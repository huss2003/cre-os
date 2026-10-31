import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured, AiUnavailableError } from "@/lib/ai/gateway";
import { sha256 } from "@/lib/util/crypto";
import type { AiCall } from "../common";
import { CLAUSE_TYPES, ENGINE_VERSION, LEGAL_DISCLAIMER, compareClauses, documentRedline, exposureChecklist, extractClauses, validateClauses, type DocRef, type ExtractedClause, type SegmentOptions } from "./clauses";

export const LegalDocInput = z.object({
  title: z.string().min(2).max(200),
  docKind: z.enum(["loi", "term_sheet", "lease", "amendment", "other"]).default("loi"),
  familyKey: z.string().max(120).optional().nullable(),
  text: z.string().min(20).max(400_000),
  opportunityId: z.string().uuid().optional().nullable(),
  orgId: z.string().uuid().optional().nullable(),
  assetId: z.string().uuid().optional().nullable(),
  leaseId: z.string().uuid().optional().nullable(),
  ocrUnverified: z.boolean().default(false),
});

/**
 * Related lease / company / building. A chosen lease fills org_id (tenant) and asset_id (building) when not given, so the
 * Lease Radar can match this document's clauses to the lease (org_id + asset_id, or source_object_id).
 */
export async function resolveLegalLinks(db: Db, workspaceId: string, i: { leaseId?: string | null; orgId?: string | null; assetId?: string | null }) {
  let orgId = i.orgId ?? null, assetId = i.assetId ?? null;
  if (i.leaseId) {
    const { data: lease } = await db.from("lease").select("id, tenant_org_id, asset_id").eq("workspace_id", workspaceId).eq("id", i.leaseId).maybeSingle();
    if (!lease) throw new Error("Lease not found or not visible.");
    orgId ??= (lease.tenant_org_id as string | null) ?? null;
    assetId ??= (lease.asset_id as string | null) ?? null;
  }
  if (orgId) { const { data } = await db.from("organisation").select("id").eq("workspace_id", workspaceId).eq("id", orgId).maybeSingle(); if (!data) throw new Error("Company not found or not visible."); }
  if (assetId) { const { data } = await db.from("asset").select("id").eq("workspace_id", workspaceId).eq("id", assetId).maybeSingle(); if (!data) throw new Error("Building not found or not visible."); }
  return { leaseId: i.leaseId ?? null, orgId, assetId };
}

const ClauseSchema = z.object({
  clauses: z.array(z.object({
    clause_type: z.enum(CLAUSE_TYPES),
    heading: z.string().nullable(),
    clause_text: z.string(),
    locator: z.object({ line_start: z.number(), line_end: z.number(), char_start: z.number(), char_end: z.number(), page: z.number().nullable() }),
    extracted_values: z.record(z.string(), z.unknown()),
  })),
});

/** Extract clauses via the gateway (luna). Mock / fallback = deterministic heading+regex extractor. Model output is validated against the source. */
export async function extractWithGateway(workspaceId: string, text: string, ai: AiCall = callStructured as AiCall, seg: SegmentOptions = {}): Promise<{ clauses: ExtractedClause[]; method: "heuristic" | "model"; rejected: number }> {
  const heuristic = extractClauses(text, seg);
  try {
    const res = await ai({
      workspaceId, workflow: "legal.extract", tier: "luna",
      system: "Extract lease/LOI clauses (rent, escalation, lock-in, notice, term, renewal, deposit, CAM, fit-out, possession/commencement dates, reinstatement, termination/break, indemnity, obligations, permitted use, assignment, insurance, force majeure, disputes, parking, taxes). Quote the COMPLETE source wording of each clause exactly; give line/char locators. Only report values stated in the clause. Do not give legal advice.",
      input: "Return clauses found in the evidence document.", evidence: text.slice(0, 60_000),
      schema: ClauseSchema, schemaName: "clauses", maxOutputTokens: 4000, mock: () => ({ clauses: heuristic }),
    });
    if (res.mocked) return { clauses: heuristic, method: "heuristic", rejected: 0 };
    const v = validateClauses(text, res.data.clauses as ExtractedClause[], seg);
    return v.clauses.length ? { clauses: v.clauses, method: "model", rejected: v.rejected.length } : { clauses: heuristic, method: "heuristic", rejected: v.rejected.length };
  } catch (e) {
    if (e instanceof AiUnavailableError) return { clauses: heuristic, method: "heuristic", rejected: 0 };
    throw e;
  }
}

export function familyKeyFor(title: string, explicit?: string | null): string {
  return explicit?.trim() || title.trim().toLowerCase().replace(/\s+v(?:ersion)?\s*\d+$/i, "").replace(/[^a-z0-9]+/g, "-").slice(0, 80);
}

export interface StoreOptions {
  userId?: string | null;
  ai?: AiCall;
  /** Set by file uploads. */
  file?: { sourceObjectId: string; fileKind: "pdf" | "docx" | "text"; sha256: string; pageCount: number | null; ocrStatus: "not_needed" | "ocr_needed" | "ocr_unverified"; notes: string[] };
}

export async function addLegalDocument(db: Db, workspaceId: string, raw: z.input<typeof LegalDocInput>, opts: StoreOptions = {}) {
  const ocrNeeded = opts.file?.ocrStatus === "ocr_needed";
  const input = ocrNeeded ? LegalDocInput.extend({ text: z.string().max(400_000) }).parse(raw) : LegalDocInput.parse(raw);
  const family = familyKeyFor(input.title, input.familyKey);
  // A scanned PDF has no text: hash the file so different scans never collapse into one version.
  const hash = input.text.trim() ? sha256(input.text) : `file:${opts.file?.sha256 ?? sha256(input.title)}`;
  const { data: same } = await db.from("legal_document").select("*").eq("workspace_id", workspaceId).eq("family_key", family).eq("text_sha256", hash).maybeSingle();
  if (same) return { document: same, duplicate: true, clauseCount: 0, method: "heuristic" as const };
  const { data: last } = await db.from("legal_document").select("version").eq("workspace_id", workspaceId).eq("family_key", family).order("version", { ascending: false }).limit(1).maybeSingle();
  const ocrStatus = opts.file?.ocrStatus ?? (input.ocrUnverified ? "ocr_unverified" : "not_needed");
  const links = await resolveLegalLinks(db, workspaceId, input);
  const { data: doc, error } = await db.from("legal_document").insert({
    workspace_id: workspaceId, title: input.title, doc_kind: input.docKind, family_key: family, version: (last ? Number(last.version) : 0) + 1,
    opportunity_id: input.opportunityId ?? null, org_id: links.orgId, asset_id: links.assetId, lease_id: links.leaseId, text_content: input.text, text_sha256: hash,
    ocr_unverified: input.ocrUnverified || ocrStatus !== "not_needed", ocr_status: ocrStatus,
    source_object_id: opts.file?.sourceObjectId ?? null, file_kind: opts.file?.fileKind ?? "text", page_count: opts.file?.pageCount ?? null,
    extraction_notes: opts.file?.notes ?? [],
    owner_user_id: opts.userId ?? undefined,
  }).select().single();
  if (error) throw error;
  if (ocrNeeded) return { document: doc, duplicate: false, clauseCount: 0, method: "heuristic" as const, ocrNeeded: true };
  const seg: SegmentOptions = { paged: opts.file?.fileKind === "pdf" };
  const { clauses, method } = await extractWithGateway(workspaceId, input.text, opts.ai, seg);
  if (clauses.length) {
    const { error: e2 } = await db.from("clause_extract").insert(clauses.map((c) => ({
      workspace_id: workspaceId, document_id: doc.id, clause_type: c.clause_type, heading: c.heading, clause_text: c.clause_text, locator: c.locator,
      extracted_values: c.extracted_values, validation: c.validation ?? {}, extraction_method: method, needs_review: true, owner_user_id: opts.userId ?? undefined,
    })));
    if (e2) throw e2;
  }
  return { document: doc, duplicate: false, clauseCount: clauses.length, method };
}

async function clausesOf(db: Db, workspaceId: string, documentId: string): Promise<ExtractedClause[]> {
  const { data, error } = await db.from("clause_extract").select("clause_type, heading, clause_text, locator, extracted_values, validation").eq("workspace_id", workspaceId).eq("document_id", documentId).order("created_at");
  if (error) throw error;
  return (data ?? []) as ExtractedClause[];
}

type DocRow = { id: string; title: string; version: number; family_key: string; text_content: string; file_kind: string; ocr_status: string; ocr_unverified: boolean };
async function docRow(db: Db, workspaceId: string, id: string): Promise<DocRow> {
  const { data, error } = await db.from("legal_document").select("id, title, version, family_key, text_content, file_kind, ocr_status, ocr_unverified").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Legal document not found or not visible.");
  return { ...(data as DocRow), version: Number(data.version) };
}
const ref = (d: DocRow): DocRef => ({ id: d.id, title: d.title, version: d.version });

export class FamilyMismatchError extends Error {}

/**
 * Redline (per clause + whole document) and exposure checklist. Only versions of the same document family are compared,
 * unless the user explicitly confirms a cross-family comparison. Idempotent per (base, compare, engine_version).
 * Every finding carries the document version and exact locator. Always carries the "not legal advice" disclaimer.
 */
export async function compareDocuments(db: Db, workspaceId: string, baseId: string, compareId: string, userId?: string | null, opts: { confirmCrossFamily?: boolean } = {}) {
  if (baseId === compareId) throw new Error("Choose two different documents.");
  const [base, next] = await Promise.all([docRow(db, workspaceId, baseId), docRow(db, workspaceId, compareId)]);
  const sameFamily = base.family_key === next.family_key;
  if (!sameFamily && !opts.confirmCrossFamily) {
    throw new FamilyMismatchError(`These are different documents (family “${base.family_key}” vs “${next.family_key}”). Only versions of the same document are compared — tick the confirmation to compare anyway.`);
  }
  const { data: existing } = await db.from("clause_comparison").select("*").eq("workspace_id", workspaceId).eq("base_document_id", baseId).eq("compare_document_id", compareId).eq("engine_version", ENGINE_VERSION).maybeSingle();
  if (existing) return existing;
  const [baseClauses, nextClauses] = await Promise.all([clausesOf(db, workspaceId, baseId), clausesOf(db, workspaceId, compareId)]);
  const diff = compareClauses(baseClauses, nextClauses);
  const checklist = exposureChecklist(nextClauses, diff, { document: ref(next), base: ref(base), ocrUnverified: next.ocr_unverified || base.ocr_unverified });
  const full = documentRedline(base.text_content ?? "", next.text_content ?? "", { basePaged: base.file_kind === "pdf", newPaged: next.file_kind === "pdf" });
  const { data, error } = await db.from("clause_comparison").insert({
    workspace_id: workspaceId, base_document_id: baseId, compare_document_id: compareId, diff, exposure_checklist: checklist,
    disclaimer: LEGAL_DISCLAIMER, engine_version: ENGINE_VERSION, owner_user_id: userId ?? undefined,
    base_version: base.version, compare_version: next.version, same_family: sameFamily, cross_family_confirmed: !sameFamily && !!opts.confirmCrossFamily,
    full_redline: full,
  }).select().single();
  if (error) throw error;
  return data;
}

/** Single-document exposure checklist (no comparison); every item carries the version + locator. */
export async function documentChecklist(db: Db, workspaceId: string, documentId: string) {
  const doc = await docRow(db, workspaceId, documentId);
  return { disclaimer: LEGAL_DISCLAIMER, items: exposureChecklist(await clausesOf(db, workspaceId, documentId), undefined, { document: ref(doc), ocrUnverified: doc.ocr_unverified }) };
}
