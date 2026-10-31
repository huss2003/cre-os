/**
 * Background re-match (workflow 09 trigger "a relevant availability record changes"). Enqueued by SQL triggers on
 * availability / space / asset / requirement (migration 20261101000400) as `deals.rematch` with at most one queued job
 * per requirement. Runs with the service-role client (S2): every query filters workspace_id explicitly, rows are owned
 * by the requirement owner. Notifies the owner in-app (deduped outbox row) when the eligible set changed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { notify } from "@/modules/brief/db";
import type { DealsCtx } from "../ctx";
import { dbError } from "../ctx";
import type { RequirementRow } from "../requirements/contract";
import { syncQuestionTasks } from "../requirements/tasks";
import { runShortlist } from "./service";

const ACTIVE = new Set(["estimated", "client_confirmed"]);

async function loadRequirement(db: SupabaseClient<any, any, any>, workspaceId: string, requirementId: string) {
  const r = await db.from("requirement").select("*").eq("workspace_id", workspaceId).eq("id", requirementId).maybeSingle();
  if (r.error) throw dbError(r.error, "requirement");
  return r.data as (RequirementRow & { id: string; owner_user_id: string | null; archived_at: string | null; title: string }) | null;
}

export async function rematchRequirement(db: SupabaseClient<any, any, any>, workspaceId: string, requirementId: string, reason = "inventory changed") {
  const req = await loadRequirement(db, workspaceId, requirementId);
  if (!req || req.archived_at || !ACTIVE.has(String(req.status))) return { skipped: "requirement not active" };
  const ctx: DealsCtx = { db, workspaceId, userId: req.owner_user_id as string };
  const prev = await db.from("shortlist_version").select("version").eq("workspace_id", workspaceId).eq("requirement_id", requirementId)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  const prevVersion = (prev.data as { version: number } | null)?.version ?? null;
  const prevEligible = new Set<string>();
  if (prevVersion !== null) {
    const o = await db.from("shortlist_option").select("space_id, score_breakdown").eq("workspace_id", workspaceId).eq("requirement_id", requirementId).eq("version", prevVersion);
    if (o.error) throw dbError(o.error, "shortlist_option");
    for (const x of o.data ?? []) if ((x.score_breakdown as { eligibility?: string })?.eligibility === "eligible") prevEligible.add(x.space_id as string);
  }
  const run = await runShortlist(ctx, requirementId, { trigger: `auto re-match: ${reason}` });
  const nowEligible = run.results.filter((r) => r.eligibility === "eligible");
  const added = nowEligible.filter((r) => !prevEligible.has(r.spaceId)).map((r) => r.label);
  const dropped = [...prevEligible].filter((sid) => !nowEligible.some((r) => r.spaceId === sid)).length;
  if (added.length || dropped) {
    await notify(db as never, workspaceId, req.owner_user_id, "deals.shortlist_changed", `deals.rematch:${requirementId}:v${run.version}`, {
      requirement_id: requirementId, title: req.title, version: run.version, newly_eligible: added.slice(0, 10), dropped_count: dropped,
      text: `Shortlist for “${req.title}” re-ran (${reason}): ${added.length} newly eligible, ${dropped} no longer eligible. Verify live availability before client use.`,
    });
  }
  return { version: run.version, eligible: nowEligible.length, newlyEligible: added.length, dropped };
}

/** `deals.req_tasks`: refresh follow-up tasks after a change proposal was applied to a requirement. */
export async function refreshRequirementTasks(db: SupabaseClient<any, any, any>, workspaceId: string, requirementId: string) {
  const req = await loadRequirement(db, workspaceId, requirementId);
  if (!req || req.archived_at) return { skipped: "requirement not found" };
  return syncQuestionTasks({ db, workspaceId, userId: req.owner_user_id as string }, req);
}
