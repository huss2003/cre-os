import "server-only";
import type { Db } from "@/lib/supabase/server";
import { backoffMs } from "../engine/plan";

type Row = Record<string, any>;
export type MarkKind = "needs_refresh" | "stale" | "outdated_warning" | "review";

/** Flag an output as outdated. The flagged record itself is never changed (approved/shared outputs are not overwritten). Idempotent per dedupeKey. */
export async function markEntity(db: Db, ws: string, m: { entityType: string; entityId: string; mark: MarkKind; reason: string; causeType?: string; causeId?: string | null; eventId?: string | null; runId?: string | null; detail?: Record<string, unknown>; dedupeKey: string; owner?: string | null }) {
  const row = {
    workspace_id: ws, entity_type: m.entityType, entity_id: m.entityId, mark: m.mark, reason: m.reason, cause_type: m.causeType ?? null, cause_id: m.causeId ?? null,
    cause_event_id: m.eventId ?? null, run_id: m.runId ?? null, detail: m.detail ?? {}, dedupe_key: m.dedupeKey, owner_user_id: m.owner ?? null,
  };
  const { data, error } = await db.from("reassessment_mark").upsert(row, { onConflict: "workspace_id,dedupe_key", ignoreDuplicates: true }).select("id");
  if (error) throw new Error(error.message);
  if (data?.length) {
    // Newest mark supersedes older open ones of the same kind on the same record — one entry per record, not a pile.
    await db.from("reassessment_mark").update({ state: "resolved", resolved_at: new Date().toISOString() }).eq("workspace_id", ws).eq("entity_type", m.entityType).eq("entity_id", m.entityId).eq("mark", m.mark).eq("state", "open").neq("id", data[0].id);
    return data[0].id as string;
  }
  return ((await db.from("reassessment_mark").select("id").eq("workspace_id", ws).eq("dedupe_key", m.dedupeKey).single()).data?.id ?? null) as string | null;
}
export async function listMarks(db: Db, ws: string, f: { entityType?: string; entityId?: string; state?: "open" | "resolved" | "dismissed"; limit?: number } = {}) {
  let q = db.from("reassessment_mark").select("*").eq("workspace_id", ws);
  if (f.entityType) q = q.eq("entity_type", f.entityType);
  if (f.entityId) q = q.eq("entity_id", f.entityId);
  q = q.eq("state", f.state ?? "open");
  return ((await q.order("created_at", { ascending: false }).limit(f.limit ?? 100)).data ?? []) as Row[];
}
export async function resolveMark(db: Db, ws: string, id: string, state: "resolved" | "dismissed" = "resolved") {
  await db.from("reassessment_mark").update({ state, resolved_at: new Date().toISOString() }).eq("workspace_id", ws).eq("id", id);
}
/** Latest open mark on a record (for "needs refresh" / "may be stale" labels — S10 visible failure). */
export async function isStale(db: Db, ws: string, entityType: string, entityId: string) {
  return (await listMarks(db, ws, { entityType, entityId, limit: 1 }))[0] ?? null;
}

// ------------------------------------------------------------------ integration health (spec §7 ex.5)
const HEALTH_RETRY = { baseMs: 5 * 60_000, maxMs: 6 * 3600_000 };

export async function recordIntegrationFailure(db: Db, ws: string, source: string, error: string, o: { label?: string; affects?: { type: string; id: string }[]; now?: Date } = {}) {
  const now = o.now ?? new Date();
  const { data: cur } = await db.from("integration_health").select("*").eq("workspace_id", ws).eq("source_key", source).maybeSingle();
  const n = (cur?.consecutive_failures ?? 0) + 1;
  const row = {
    workspace_id: ws, source_key: source, label: o.label ?? cur?.label ?? source, status: n >= 3 ? "down" : "degraded",
    last_failure_at: now.toISOString(), last_error: error.slice(0, 1000), consecutive_failures: n,
    next_retry_at: new Date(+now + backoffMs(n, HEALTH_RETRY)).toISOString(), affects: o.affects ?? cur?.affects ?? [], updated_at: now.toISOString(),
  };
  const { data, error: e } = await db.from("integration_health").upsert(row, { onConflict: "workspace_id,source_key" }).select("*").single();
  if (e) throw new Error(e.message);
  return data as Row;
}
export async function recordIntegrationSuccess(db: Db, ws: string, source: string, now = new Date()) {
  const { data, error } = await db.from("integration_health").upsert({ workspace_id: ws, source_key: source, status: "healthy", last_success_at: now.toISOString(), consecutive_failures: 0, next_retry_at: null, updated_at: now.toISOString() }, { onConflict: "workspace_id,source_key" }).select("*").single();
  if (error) throw new Error(error.message);
  // Stale marks caused by this source are resolved (the data refreshes on the next sync).
  await db.from("reassessment_mark").update({ state: "resolved", resolved_at: now.toISOString() }).eq("workspace_id", ws).eq("mark", "stale").eq("state", "open").eq("cause_type", `integration:${source}`);
  return data as Row;
}
export async function listIntegrationHealth(db: Db, ws: string) {
  return ((await db.from("integration_health").select("*").eq("workspace_id", ws).order("source_key")).data ?? []) as Row[];
}
