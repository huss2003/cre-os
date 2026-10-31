import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured, AiUnavailableError } from "@/lib/ai/gateway";
import { sha256 } from "@/lib/util/crypto";
import type { AiCall } from "../common";
import { CLAUSE_TYPES, ENGINE_VERSION, LEGAL_DISCLAIMER, compareClauses, exposureChecklist, extractClauses, validateAgainstSource, type ExtractedClause } from "./clauses";

export const LegalDocInput = z.object({
  title: z.string().min(2).max(200),
  docKind: z.enum(["loi", "term_sheet", "lease", "amendment", "other"]).default("loi"),
  familyKey: z.string().max(120).optional().nullable(),
  text: z.string().min(20).max(400_000),
  opportunityId: z.string().uuid().optional().nullable(),
  orgId: z.string().uuid().optional().nullable(),
  ocrUnverified: z.boolean().default(false),
});

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
export async function extractWithGateway(workspaceId: string, text: string, ai: AiCall = callStructured as AiCall): Promise<{ clauses: ExtractedClause[]; method: "heuristic" | "model" }> {
  const heuristic = extractClauses(text);
  try {
    const res = await ai({
      workspaceId, workflow: "legal.extract", tier: "luna",
      system: "Extract lease/LOI clauses (rent, escalation, lock-in, notice, term, deposit, CAM, fit-out, reinstatement, termination, indemnity). Quote the source wording exactly; give line/char locators. Do not give legal advice.",
      input: "Return clauses found in the evidence document.", evidence: text.slice(0, 60_000),
      schema: ClauseSchema, schemaName: "clauses", maxOutputTokens: 4000, mock: () => ({ clauses: heuristic }),
    });
    if (res.mocked) return { clauses: heuristic, method: "heuristic" };
    const valid = validateAgainstSource(text, res.data.clauses as ExtractedClause[]);
    return valid.length ? { clauses: valid, method: "model" } : { clauses: heuristic, method: "heuristic" };
  } catch (e) {
    if (e instanceof AiUnavailableError) return { clauses: heuristic, method: "heuristic" };
    throw e;
  }
}

export async function addLegalDocument(db: Db, workspaceId: string, raw: z.input<typeof LegalDocInput>, opts: { userId?: string | null; ai?: AiCall } = {}) {
  const input = LegalDocInput.parse(raw);
  const family = input.familyKey?.trim() || input.title.trim().toLowerCase().replace(/\s+v(?:ersion)?\s*\d+$/i, "").replace(/[^a-z0-9]+/g, "-").slice(0, 80);
  const hash = sha256(input.text);
  const { data: same } = await db.from("legal_document").select("*").eq("workspace_id", workspaceId).eq("family_key", family).eq("text_sha256", hash).maybeSingle();
  if (same) return { document: same, duplicate: true };
  const { data: last } = await db.from("legal_document").select("version").eq("workspace_id", workspaceId).eq("family_key", family).order("version", { ascending: false }).limit(1).maybeSingle();
  const { data: doc, error } = await db.from("legal_document").insert({
    workspace_id: workspaceId, title: input.title, doc_kind: input.docKind, family_key: family, version: (last ? Number(last.version) : 0) + 1,
    opportunity_id: input.opportunityId ?? null, org_id: input.orgId ?? null, text_content: input.text, text_sha256: hash, ocr_unverified: input.ocrUnverified,
    owner_user_id: opts.userId ?? undefined,
  }).select().single();
  if (error) throw error;
  const { clauses, method } = await extractWithGateway(workspaceId, input.text, opts.ai);
  if (clauses.length) {
    const { error: e2 } = await db.from("clause_extract").insert(clauses.map((c) => ({
      workspace_id: workspaceId, document_id: doc.id, clause_type: c.clause_type, heading: c.heading, clause_text: c.clause_text, locator: c.locator,
      extracted_values: c.extracted_values, extraction_method: method, needs_review: true, owner_user_id: opts.userId ?? undefined,
    })));
    if (e2) throw e2;
  }
  return { document: doc, duplicate: false, clauseCount: clauses.length, method };
}

async function clausesOf(db: Db, workspaceId: string, documentId: string): Promise<ExtractedClause[]> {
  const { data, error } = await db.from("clause_extract").select("clause_type, heading, clause_text, locator, extracted_values").eq("workspace_id", workspaceId).eq("document_id", documentId).order("created_at");
  if (error) throw error;
  return (data ?? []) as ExtractedClause[];
}

/** Redline comparison + exposure checklist. Idempotent per (base, compare, engine_version). Always carries the disclaimer. */
export async function compareDocuments(db: Db, workspaceId: string, baseId: string, compareId: string, userId?: string | null) {
  const { data: existing } = await db.from("clause_comparison").select("*").eq("workspace_id", workspaceId).eq("base_document_id", baseId).eq("compare_document_id", compareId).eq("engine_version", ENGINE_VERSION).maybeSingle();
  if (existing) return existing;
  const [base, next] = await Promise.all([clausesOf(db, workspaceId, baseId), clausesOf(db, workspaceId, compareId)]);
  const diff = compareClauses(base, next);
  const checklist = exposureChecklist(next, diff);
  const { data, error } = await db.from("clause_comparison").insert({
    workspace_id: workspaceId, base_document_id: baseId, compare_document_id: compareId, diff, exposure_checklist: checklist,
    disclaimer: LEGAL_DISCLAIMER, engine_version: ENGINE_VERSION, owner_user_id: userId ?? undefined,
  }).select().single();
  if (error) throw error;
  return data;
}

/** Single-document exposure checklist (no comparison). */
export async function documentChecklist(db: Db, workspaceId: string, documentId: string) {
  return { disclaimer: LEGAL_DISCLAIMER, items: exposureChecklist(await clausesOf(db, workspaceId, documentId)) };
}
