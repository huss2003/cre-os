import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { approveAndApply } from "@/modules/changes/service";

type Db = SupabaseClient<any, any, any>;

/**
 * Bulk import review (owner request, Nov 2026): one summary per import instead of one card per row.
 *  - SAFE  = proposals from this file that create new records or fill values with no conflict and no same-name duplicate.
 *  - CHECK = value conflicts with existing records + new people whose name already exists + identity matches. Never auto-applied.
 *  - PROBLEMS = quarantined rows and open import issues (kept with reasons, nothing lost).
 */
export const TYPE_LABEL: Record<string, string> = {
  organisation: "Companies", person: "People", asset: "Buildings", geography: "Locations", lease: "Leases",
  space: "Spaces", availability: "Availability", market_transaction: "Transactions", employment: "Employments", requirement: "Requirements",
};

const PENDING = ["proposed", "approved", "clarify"];
type P = { id: string; target_type: string; operation: string; idempotency_key: string | null; reason: string | null };

export function laneOf(p: P): "safe" | "check" {
  if ((p.idempotency_key ?? "").startsWith("imports.conflict:")) return "check";          // changes a value already on a record
  if (/existing person\(s\) share this name|NOT merged/i.test(p.reason ?? "")) return "check"; // possible duplicate person
  if (p.operation === "merge") return "check";
  return "safe";
}

async function pendingForSource(db: Db, ws: string, sourceId: string, limit = 5000): Promise<P[]> {
  const out: P[] = [];
  for (let from = 0; out.length < limit; from += 1000) {
    const { data, error } = await db.from("change_proposal").select("id, target_type, operation, idempotency_key, reason")
      .eq("workspace_id", ws).contains("evidence_ids", [sourceId]).in("state", PENDING).is("reversal_of", null).is("archived_at", null)
      .order("created_at").range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as P[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export interface ImportSummary {
  tiles: { type: string; label: string; total: number; added: number; linked: number; pending: number }[];
  safe: { count: number; byType: Record<string, number> };
  check: { conflicts: number; duplicatePeople: number; identity: number };
  problems: { quarantined: number; issues: number };
}

export async function importSummary(db: Db, ws: string, batch: { id: string; source_object_id: string | null; counts: Record<string, any> | null }): Promise<ImportSummary> {
  const c = batch.counts ?? {};
  const [props, idm, exc] = await Promise.all([
    batch.source_object_id ? pendingForSource(db, ws, batch.source_object_id) : Promise.resolve([] as P[]),
    db.from("identity_match_candidate").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("batch_id", batch.id).eq("decision", "pending"),
    db.from("import_exception").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("batch_id", batch.id).eq("status", "open"),
  ]);
  const safeBy: Record<string, number> = {}, pendingBy: Record<string, number> = {};
  let conflicts = 0, dupPeople = 0;
  for (const p of props) {
    pendingBy[p.target_type] = (pendingBy[p.target_type] ?? 0) + 1;
    if (laneOf(p) === "safe") safeBy[p.target_type] = (safeBy[p.target_type] ?? 0) + 1;
    else if ((p.idempotency_key ?? "").startsWith("imports.conflict:")) conflicts++;
    else dupPeople++;
  }
  const masters = (c.masters ?? {}) as Record<string, { new: number; existing_linked: number }>;
  const types = [...new Set([...Object.keys(masters), ...Object.keys(pendingBy)])];
  const order = ["organisation", "person", "asset", "geography", "lease"];
  types.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return {
    tiles: types.map((t) => {
      const m = masters[t] ?? { new: 0, existing_linked: 0 };
      return { type: t, label: TYPE_LABEL[t] ?? t.replace(/_/g, " "), total: m.new + m.existing_linked + (pendingBy[t] ?? 0), added: m.new, linked: m.existing_linked, pending: pendingBy[t] ?? 0 };
    }),
    safe: { count: Object.values(safeBy).reduce((a, b) => a + b, 0), byType: safeBy },
    check: { conflicts, duplicatePeople: dupPeople, identity: idm.count ?? 0 },
    problems: { quarantined: Number(c.quarantined ?? 0), issues: exc.count ?? 0 },
  };
}

/**
 * Approve + apply the SAFE proposals of one import, as the signed-in admin (RLS, version checks and audit still run).
 * Works in time-boxed chunks so thousands of rows never hit the 60s function limit; the page calls it until remaining = 0.
 */
export async function applySafeChunk(db: Db, ws: string, userId: string, sourceId: string, budgetMs = 40_000) {
  const t0 = Date.now();
  const all = await pendingForSource(db, ws, sourceId);
  const safe = all.filter((p) => laneOf(p) === "safe");
  let applied = 0; const failed: string[] = [];
  let i = 0;
  const worker = async () => {
    while (i < safe.length && Date.now() - t0 < budgetMs) {
      const p = safe[i++];
      try { await approveAndApply(db, p.id, { actorUserId: userId, note: "Bulk-approved from import summary (safe rows)" }); applied++; }
      catch (e) { failed.push(String(e instanceof Error ? e.message : e).slice(0, 140)); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { applied, failed: failed.length, failedSamples: failed.slice(0, 5), remaining: Math.max(0, safe.length - applied - failed.length), total: safe.length };
}
