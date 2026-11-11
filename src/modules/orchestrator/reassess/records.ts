import "server-only";
/**
 * Rule 5 / §2.5: new records, contacts and lease details trigger dependent workflows.
 * `reassess.record_changed` resolves the affected companies, re-scores them through Module 3 (recalcOrg) and, for a
 * lease change, flags analyses built on that lease as needs_refresh (never edits them). The lease renewal chain itself
 * stays in workflows.lease_chain (routed + tracked by the event consumer).
 * Skips cleanly when nothing relevant is linked (no unnecessary work, §2.4).
 */
import type { Db } from "@/lib/supabase/server";
import { recalcOrg } from "@/modules/scoring/service";
import { registerWorkflow } from "../engine/registry";
import type { Ref } from "../engine/types";
import { markEntity } from "./marks";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const RECORD_CHANGED = "reassess.record_changed";

/** Companies affected by a changed record. */
export async function affectedOrgs(db: Db, ws: string, entity: string, id: string): Promise<string[]> {
  if (entity === "organisation") return [id];
  if (entity === "lease") {
    const { data } = await db.from("lease").select("tenant_org_id, landlord_org_id").eq("workspace_id", ws).eq("id", id).maybeSingle();
    return [data?.tenant_org_id, data?.landlord_org_id].filter(Boolean) as string[];
  }
  if (entity === "person") {
    const { data } = await db.from("employment").select("org_id").eq("workspace_id", ws).eq("person_id", id).eq("is_current", true).limit(10);
    return [...new Set(((data ?? []) as Row[]).map((e) => e.org_id).filter(Boolean))];
  }
  return [];
}

registerWorkflow({
  key: RECORD_CHANGED, name: "New or changed record — update dependants", module: "orchestrator",
  description: "When a company, contact, contact detail or lease is added or changed: re-scores the affected companies (Scoring Engine) and flags analyses that used a changed lease for refresh. Skips when nothing depends on it.",
  trigger: { type: "event", events: ["company.created", "company.updated", "contact.created", "contact.info_added", "lease.created", "lease.changed"] },
  priority: 45, timeoutMs: 15 * 60_000, inputs: ["entity", "entityId", "eventType", "changed", "eventId"],
  steps: [
    { key: "identify", label: "Find affected companies", module: "database", run: async (c) => {
      const orgs = await affectedOrgs(c.db, c.ws, c.input.entity, c.input.entityId);
      return { status: orgs.length ? "done" : "skipped", reason: orgs.length ? `${orgs.length} company(ies) affected.` : "No linked company — nothing to update.", refs: orgs.map((id) => ({ type: "organisation", id })), output: { orgs } };
    } },
    { key: "rescore", label: "Update account scores (Scoring Engine)", module: "scoring", dependsOn: ["identify"],
      condition: (c) => (c.outputs.identify?.orgs?.length ? true : "No affected company."),
      run: async (c) => {
        const refs: Ref[] = [];
        for (const id of c.outputs.identify.orgs as string[]) { await recalcOrg(c.db, c.ws, id, `orchestrator:${c.input.eventType}`); refs.push({ type: "organisation", id }); }
        return { status: "done", reason: `Re-scored ${refs.length} company(ies).`, refs };
      } },
    { key: "flag", label: "Flag analyses that used this lease", module: "deals",
      condition: (c) => (c.input.entity === "lease" && c.input.eventType === "lease.changed" ? true : "Only lease changes affect saved analyses."),
      run: async (c) => {
        const { data } = await c.db.from("deal_analysis").select("id, title, inputs, owner_user_id").eq("workspace_id", c.ws).is("archived_at", null).limit(500);
        const hit = ((data ?? []) as Row[]).filter((a) => JSON.stringify(a.inputs ?? {}).includes(c.input.entityId));
        for (const a of hit) await markEntity(c.db, c.ws, { entityType: "deal_analysis", entityId: a.id, mark: "needs_refresh", reason: `Lease details changed (${Object.keys(c.input.changed ?? {}).join(", ") || "lease"}) — "${a.title}" uses the old values.`, runId: c.runId, eventId: c.input.eventId ?? null, causeType: "lease", causeId: c.input.entityId, dedupeKey: `${c.idempotencyKey}:${a.id}`, owner: a.owner_user_id });
        return { status: hit.length ? "done" : "skipped", reason: hit.length ? `${hit.length} analysis(es) flagged for refresh.` : "No saved analysis uses this lease.", refs: hit.map((a) => ({ type: "deal_analysis", id: a.id, label: a.title })) };
      } },
  ],
});
