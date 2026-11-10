/**
 * Evidence attachments on a deal analysis (quote, brochure, floor plan, photo, email, note). Files live in storage
 * under <ws>/evidence/...; rows in mudar.deal_evidence (RLS via make_business_table). Each item carries a verification
 * label (verified / unverified / conflicting); any "conflicting" item flags the analysis.
 * UI: `EvidenceList` + `EvidenceUploadForm` in src/app/(app)/toolkit/packs/evidence-ui.tsx (embed with an analysisId).
 */
import { type DealsCtx, DealsError, dbError } from "@/modules/deals/ctx";

export const EVIDENCE_KINDS = ["quote", "brochure", "floor_plan", "photo", "email", "note", "other"] as const;
export const VERIFICATION = ["verified", "unverified", "conflicting"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type Verification = (typeof VERIFICATION)[number];
export interface EvidenceRow { id: string; analysis_id: string; kind: EvidenceKind; title: string; storage_path: string | null; url: string | null; source_date: string | null; verification: Verification; note: string | null; created_at: string; row_version: number }

export interface AddEvidenceInput { analysisId: string; kind: EvidenceKind; title: string; storagePath?: string | null; url?: string | null; sourceDate?: string | null; verification?: Verification; note?: string | null }

export async function addEvidence(ctx: DealsCtx, e: AddEvidenceInput): Promise<EvidenceRow> {
  if (!EVIDENCE_KINDS.includes(e.kind)) throw new DealsError(400, "unknown evidence kind");
  if (!e.title.trim()) throw new DealsError(400, "Give the evidence a title.");
  if (e.storagePath && !e.storagePath.startsWith(`${ctx.workspaceId}/evidence/`)) throw new DealsError(400, "invalid upload path");
  if (e.url && !/^https?:\/\//i.test(e.url)) throw new DealsError(400, "Links must start with http:// or https://");
  const a = await ctx.db.from("deal_analysis").select("id, classification").eq("workspace_id", ctx.workspaceId).eq("id", e.analysisId).maybeSingle();
  if (!a.data) throw new DealsError(404, "analysis not found");
  const r = await ctx.db.from("deal_evidence").insert({
    workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, classification: (a.data as { classification: string }).classification,
    analysis_id: e.analysisId, kind: e.kind, title: e.title.trim().slice(0, 200), storage_path: e.storagePath ?? null, url: e.url ?? null,
    source_date: e.sourceDate || null, verification: e.verification ?? "unverified", note: e.note?.trim() || null,
  }).select("*").single();
  if (r.error) throw dbError(r.error, "deal_evidence");
  return r.data as EvidenceRow;
}

export async function listEvidence(ctx: DealsCtx, analysisId: string): Promise<EvidenceRow[]> {
  const r = await ctx.db.from("deal_evidence").select("*").eq("workspace_id", ctx.workspaceId).eq("analysis_id", analysisId).is("archived_at", null).order("created_at", { ascending: false });
  if (r.error) throw dbError(r.error, "deal_evidence");
  return (r.data ?? []) as EvidenceRow[];
}

export async function setVerification(ctx: DealsCtx, id: string, verification: Verification, note?: string | null) {
  if (!VERIFICATION.includes(verification)) throw new DealsError(400, "unknown verification status");
  if (verification === "conflicting" && !note?.trim()) throw new DealsError(400, "Say what conflicts (e.g. brochure says 42,000 SF, quote says 40,500 SF).");
  const r = await ctx.db.from("deal_evidence").update({ verification, ...(note !== undefined ? { note: note?.trim() || null } : {}) }).eq("workspace_id", ctx.workspaceId).eq("id", id).select("*");
  if (r.error) throw dbError(r.error, "deal_evidence");
  if (!r.data?.length) throw new DealsError(404, "evidence not found");
  return r.data[0] as EvidenceRow;
}

/** Pure summary: counts per status and whether any item conflicts. */
export function evidenceSummary(rows: Pick<EvidenceRow, "verification">[]) {
  const c = { verified: 0, unverified: 0, conflicting: 0 };
  for (const r of rows) c[r.verification]++;
  return { ...c, total: rows.length, hasConflict: c.conflicting > 0 };
}

/** Short-lived download link for a stored evidence file (user-scoped: storage RLS applies). */
export async function evidenceLink(ctx: DealsCtx, row: Pick<EvidenceRow, "storage_path" | "url">): Promise<string | null> {
  if (row.url) return row.url;
  if (!row.storage_path) return null;
  const s = await ctx.db.storage.from("mudar-workspace-files").createSignedUrl(row.storage_path, 600);
  return s.data?.signedUrl ?? null;
}
