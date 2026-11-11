/**
 * Module 13 §11 (Module 9 Orchestrator): event consumers that reassess memory when new evidence arrives. Each runs
 * change detection for the event's subject (idempotent: memory_change / recommendation dedupe keys, event inbox),
 * which emits recommendations, flags affected opportunities and publishes `intelligence.change_detected`.
 * The dispatcher passes the service-role client; every query filters workspace_id explicitly (S2).
 */
import "server-only";
import { registerConsumer, type Consumer } from "@/modules/orchestrator/events/process";
import type { Db } from "@/lib/supabase/server";
import { detectChanges, type ChangeScope } from "../changes/service";

type Row = Record<string, any>;

async function scopeFor(db: Db, ws: string, e: Row): Promise<ChangeScope | null> {
  const id = e.subject_id as string | null;
  if (!id) return null;
  switch (e.event_type) {
    case "commercial.requirement_changed": return { requirementId: id };
    case "contact.employment_changed": case "contact.role_updated": return { personId: id };
    case "commercial.quote_received": {
      const { data } = await db.from("quote").select("requirement_id, space:space_id(asset_id)").eq("workspace_id", ws).eq("id", id).maybeSingle();
      return data ? { requirementId: data.requirement_id ?? undefined, assetId: (data as Row).space?.asset_id ?? undefined } : null;
    }
    case "commercial.availability_changed": return e.subject_type === "asset" ? { assetId: id } : null;
    case "lease.created": case "lease.changed": {
      const { data } = await db.from("lease").select("tenant_org_id").eq("workspace_id", ws).eq("id", id).maybeSingle();
      return data?.tenant_org_id ? { orgId: data.tenant_org_id } : null;
    }
    case "meeting.completed": {
      const { data } = await db.from("meeting_visit").select("opportunity_id, linked_entity_type, linked_entity_id").eq("workspace_id", ws).eq("id", id).maybeSingle();
      if (!data) return null;
      return data.opportunity_id ? { opportunityId: data.opportunity_id } : data.linked_entity_type === "organisation" ? { orgId: data.linked_entity_id } : null;
    }
    case "research.signal_detected": {
      if (e.subject_type === "organisation") return { orgId: id };
      if (e.subject_type === "person") return { personId: id };
      return null;
    }
    default: return null;
  }
}

export const reassessMemory: Consumer = async (db, ws, e) => {
  const scope = await scopeFor(db, ws, e);
  if (!scope || !Object.values(scope).some(Boolean)) return { status: "skipped", detail: "No memory subject for this event." };
  const r = await detectChanges({ db, workspaceId: ws, userId: "" }, scope);
  return { status: "done", detail: `Memory reassessed: ${r.detected.length} change(s) on record, ${r.inserted.length} new, ${r.recommendations} recommendation(s), ${r.notified} notified.` };
};

export const MEMORY_EVENTS = [
  "commercial.requirement_changed", "contact.employment_changed", "contact.role_updated", "commercial.quote_received", "commercial.availability_changed",
  "lease.created", "lease.changed", "meeting.completed", "research.signal_detected",
];
for (const t of MEMORY_EVENTS) registerConsumer(t, "memory", reassessMemory);
