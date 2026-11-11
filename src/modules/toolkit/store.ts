import "server-only";
import type { Db } from "@/lib/supabase/server";
import { stableStringify } from "@/modules/deals/finance/engine";

/**
 * Module 8 shared persistence. Every workbench analysis (any kind) is saved through `saveAnalysis`: it writes the
 * current inputs/outputs onto deal_analysis and appends an immutable deal_analysis_version (inputs, outputs,
 * formula version). `reproduce` re-runs a stored version with the same pure calculator and checks the outputs match.
 * Calculators are PURE functions in src/modules/toolkit/calc/*.ts — never AI.
 */
export type AnalysisKind = "brief" | "property_comparison" | "lease_economics" | "occupancy" | "conventional_vs_managed" | "renewal_vs_relocation" | "fitout" | "financing" | "negotiation" | "deliverable" | "bts" | "investment";
type Row = Record<string, any>;

export interface SaveInput {
  id?: string | null; kind: AnalysisKind; title: string;
  orgId?: string | null; requirementId?: string | null; opportunityId?: string | null; assetIds?: string[]; quoteRefs?: unknown[];
  inputs: unknown; outputs: unknown; formulaVersion: string; missing?: string[]; note?: string | null;
}
export async function saveAnalysis(db: Db, ws: string, userId: string, s: SaveInput): Promise<{ id: string; version: number }> {
  const status = (s.missing ?? []).length ? "needs_info" : "ready";
  let id = s.id ?? null; let version = 1;
  if (id) {
    const { data: cur, error } = await db.from("deal_analysis").select("current_version").eq("workspace_id", ws).eq("id", id).single();
    if (error) throw new Error(error.message);
    version = (cur.current_version ?? 0) + 1;
    const { error: e2 } = await db.from("deal_analysis").update({ title: s.title, org_id: s.orgId ?? null, requirement_id: s.requirementId ?? null, opportunity_id: s.opportunityId ?? null, asset_ids: s.assetIds ?? [], quote_refs: s.quoteRefs ?? [], inputs: s.inputs, outputs: s.outputs, formula_version: s.formulaVersion, missing: s.missing ?? [], status, current_version: version, approved_by: null, approved_at: null }).eq("id", id);
    if (e2) throw new Error(e2.message);
  } else {
    const { data, error } = await db.from("deal_analysis").insert({ workspace_id: ws, kind: s.kind, title: s.title, org_id: s.orgId ?? null, requirement_id: s.requirementId ?? null, opportunity_id: s.opportunityId ?? null, asset_ids: s.assetIds ?? [], quote_refs: s.quoteRefs ?? [], inputs: s.inputs, outputs: s.outputs, formula_version: s.formulaVersion, missing: s.missing ?? [], status, current_version: 1, owner_user_id: userId }).select("id").single();
    if (error) throw new Error(error.message);
    id = data.id as string;
  }
  const { error: e3 } = await db.from("deal_analysis_version").insert({ workspace_id: ws, analysis_id: id, version, inputs: s.inputs, outputs: s.outputs, formula_version: s.formulaVersion, note: s.note ?? null, owner_user_id: userId });
  if (e3) throw new Error(e3.message);
  return { id: id!, version };
}

export async function getAnalysis(db: Db, ws: string, id: string) {
  const { data } = await db.from("deal_analysis").select("*, org:org_id(display_name), requirement:requirement_id(title)").eq("workspace_id", ws).eq("id", id).maybeSingle();
  if (!data) return null;
  const { data: versions } = await db.from("deal_analysis_version").select("version, formula_version, note, created_at, owner_user_id").eq("analysis_id", id).order("version", { ascending: false }).limit(20);
  return { ...(data as Row), versions: (versions ?? []) as Row[] };
}
export async function getVersion(db: Db, ws: string, id: string, version: number) {
  const { data } = await db.from("deal_analysis_version").select("*").eq("workspace_id", ws).eq("analysis_id", id).eq("version", version).maybeSingle();
  return data as Row | null;
}
export async function listAnalyses(db: Db, ws: string, opts: { kind?: AnalysisKind; requirementId?: string; limit?: number } = {}) {
  let q = db.from("deal_analysis").select("id, kind, title, status, current_version, formula_version, missing, updated_at, org:org_id(display_name), requirement:requirement_id(title)").eq("workspace_id", ws).is("archived_at", null);
  if (opts.kind) q = q.eq("kind", opts.kind);
  if (opts.requirementId) q = q.eq("requirement_id", opts.requirementId);
  const { data } = await q.order("updated_at", { ascending: false }).limit(opts.limit ?? 100);
  return (data ?? []) as Row[];
}
export async function approveAnalysis(db: Db, ws: string, userId: string, id: string) {
  const { data } = await db.from("deal_analysis").select("missing").eq("workspace_id", ws).eq("id", id).single();
  if ((data?.missing ?? []).length) throw new Error("Fill in the missing information before approving.");
  await db.from("deal_analysis").update({ status: "approved", approved_by: userId, approved_at: new Date().toISOString() }).eq("id", id);
}

/** Re-run a stored version with its calculator; returns whether outputs are identical (reproducibility check). */
// jsonb reorders keys, so compare key-sorted forms.
export function sameOutputs(a: unknown, b: unknown) { return stableStringify(a) === stableStringify(b); }
