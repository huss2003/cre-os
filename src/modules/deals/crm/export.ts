/**
 * Official-CRM export proposals (spec Part III acceptance test "Official CRM conflict": exported proposal references
 * the official ID and shows the competing update instead of overwriting). The official CRM stays the source of truth;
 * CRE OS only prepares a proposal and records what the CRM said. Pure helpers + RLS-scoped service.
 */
import { createHash } from "node:crypto";
import { type DealsCtx, DealsError, dbError, must, owned } from "../ctx";

export const CRM_FIELDS = ["name", "stage", "outcome", "expected_fee", "credit_share", "expected_close", "mandate_status"] as const;
export interface FieldConflict { field: string; base: unknown; local: unknown; external: unknown }

const norm = (v: unknown) => (v === undefined || v === "" ? null : typeof v === "number" ? String(v) : v);
const eq = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

/**
 * Three-way comparison. A field conflicts when BOTH sides changed it since the base snapshot and they disagree.
 * Fields only the CRM changed are not proposed back (the CRM wins); fields changed to the same value are not conflicts.
 */
export function detectConflicts(base: Record<string, unknown>, local: Record<string, unknown>, external: Record<string, unknown>): FieldConflict[] {
  const out: FieldConflict[] = [];
  for (const f of Object.keys(local).sort()) {
    if (!(f in external)) continue;
    if (!eq(external[f], base[f]) && !eq(local[f], base[f]) && !eq(local[f], external[f])) out.push({ field: f, base: base[f] ?? null, local: local[f] ?? null, external: external[f] ?? null });
  }
  return out;
}

/** Fields the CRM changed while we did not: the CRM value stands. */
export function crmOnlyChanges(base: Record<string, unknown>, local: Record<string, unknown>, external: Record<string, unknown>): string[] {
  return Object.keys(local).filter((f) => f in external && !eq(external[f], base[f]) && eq(local[f], base[f])).sort();
}

export function payloadHash(p: unknown) {
  return createHash("sha256").update(JSON.stringify(p)).digest("hex");
}

/** Prepare an export proposal for an opportunity. Without an official CRM id the proposal waits (needs_external_id). */
export async function proposeCrmExport(ctx: DealsCtx, opportunityId: string, opts: { baseSnapshot?: Record<string, unknown> } = {}) {
  const opp = must(await ctx.db.from("opportunity").select("*").eq("id", opportunityId).maybeSingle(), "opportunity") as Record<string, unknown>;
  const proposed: Record<string, unknown> = {};
  for (const f of CRM_FIELDS) proposed[f] = opp[f] ?? null;
  const prior = await ctx.db.from("crm_export").select("*").eq("entity_type", "opportunity").eq("entity_id", opportunityId)
    .in("status", ["proposed", "conflict", "needs_external_id"]).order("created_at", { ascending: false });
  if (prior.error) throw dbError(prior.error, "crm_export");
  const hash = payloadHash({ id: opportunityId, crm: opp.crm_external_id ?? null, proposed });
  const same = (prior.data ?? []).find((p) => p.payload_hash === hash);
  if (same) return same;
  const lastExported = await ctx.db.from("crm_export").select("external_snapshot, proposed_fields").eq("entity_type", "opportunity").eq("entity_id", opportunityId)
    .in("status", ["exported", "reconciled"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const base = opts.baseSnapshot ?? ((lastExported.data?.external_snapshot ?? lastExported.data?.proposed_fields ?? {}) as Record<string, unknown>);
  for (const p of prior.data ?? []) await ctx.db.from("crm_export").update({ status: "superseded" }).eq("id", p.id);
  return must(await ctx.db.from("crm_export").insert({
    ...owned(ctx, String(opp.classification ?? "corporate_confidential")), entity_type: "opportunity", entity_id: opportunityId,
    crm_external_id: opp.crm_external_id ?? null, proposed_fields: proposed, base_snapshot: base,
    status: opp.crm_external_id ? "proposed" : "needs_external_id", entity_row_version: opp.row_version, payload_hash: hash,
  }).select("*").single(), "crm_export");
}

/** Record the CRM's current values (from an import or typed by the user) and surface conflicts. Never overwrites. */
export async function recordExternalSnapshot(ctx: DealsCtx, exportId: string, external: Record<string, unknown>, crmExternalId?: string | null) {
  const ex = must(await ctx.db.from("crm_export").select("*").eq("id", exportId).maybeSingle(), "crm_export") as Record<string, unknown>;
  if (["exported", "superseded", "rejected"].includes(String(ex.status))) throw new DealsError(409, `export is ${ex.status}`);
  const conflicts = detectConflicts((ex.base_snapshot ?? {}) as Record<string, unknown>, ex.proposed_fields as Record<string, unknown>, external);
  const id = crmExternalId?.trim() || (ex.crm_external_id as string | null);
  const status = !id ? "needs_external_id" : conflicts.length ? "conflict" : "proposed";
  // fields only the CRM changed are dropped from the proposal so we never re-enter a stale value
  const base = (ex.base_snapshot ?? {}) as Record<string, unknown>;
  const proposed = { ...(ex.proposed_fields as Record<string, unknown>) };
  for (const f of crmOnlyChanges(base, proposed, external)) delete proposed[f];
  const r = await ctx.db.from("crm_export").update({ external_snapshot: external, conflict_fields: conflicts, status, crm_external_id: id, proposed_fields: proposed })
    .eq("id", exportId).select("*").single();
  if (r.error) throw dbError(r.error, "crm_export");
  return r.data;
}

/** User confirms they entered the proposal into the official CRM. Blocked while conflicts or the official id are missing. */
export async function markExported(ctx: DealsCtx, exportId: string, opts: { resolution?: "keep_external" | "use_local" | null } = {}) {
  const ex = must(await ctx.db.from("crm_export").select("*").eq("id", exportId).maybeSingle(), "crm_export") as Record<string, unknown>;
  if (!ex.crm_external_id) throw new DealsError(422, "official CRM id is required before export");
  if (ex.status === "conflict" && !opts.resolution) throw new DealsError(422, "resolve the CRM conflicts first", { conflicts: ex.conflict_fields });
  const r = await ctx.db.from("crm_export").update({
    status: ex.status === "conflict" ? "reconciled" : "exported", exported_at: new Date().toISOString(), exported_by: ctx.userId,
  }).eq("id", exportId).select("*").single();
  if (r.error) throw dbError(r.error, "crm_export");
  return r.data;
}
