/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { z } from "zod";
import { callStructured, AiUnavailableError } from "@/lib/ai/gateway";
import { proposeChange, type PatchOp } from "@/lib/services/changes";
import { addLegalDocument } from "@/modules/intelligence/legal/service";
import type { ApprovalPlan, Block, ToolContext } from "../types";
import {
  FIELD_LABEL, ModelTermsSchema, displayNormalised, finaliseTerms, heuristicTerms, leasePatchFromTerms, pagesForPrompt,
  type ExtractedTerm,
} from "../documents/lease-terms";
import { HREF, db, defineTool, denied, errMsg, failed, isUuid, logDenied, ref, ws, type Row } from "./shared";

/**
 * Ask-about-this-document: lease / LOI / term-sheet / offer term extraction from an attached PDF/DOCX with page-verified
 * verbatim snippets, then an approval-gated save onto a lease record (proposeChange) and optional "attach to lease".
 * Suggested group: "documents" (alongside search_documents / retrieve_document_content).
 */

/** Per-page text of an attachment: page_texts, else extracted_text split on form feeds, else one page. */
export function attachmentPages(r: Row): string[] {
  if (Array.isArray(r.page_texts) && r.page_texts.length) return r.page_texts.map((p: unknown) => String(p ?? ""));
  const t = String(r.extracted_text ?? "");
  return t.includes("\f") ? t.split(/\n?\f\n?/) : [t];
}

async function loadAttachment(t: ToolContext, tool: string, id: string): Promise<Row | null> {
  if (!isUuid(id)) { await logDenied(t, tool, { entity: "assistant_attachment", id }); return null; }
  const { data } = await db(t).from("assistant_attachment").select("id, file_name, pages, page_texts, extracted_text, conversation_id").eq("workspace_id", ws(t)).eq("id", id).is("archived_at", null).maybeSingle();
  if (!data) await logDenied(t, tool, { entity: "assistant_attachment", id });
  return data ?? null;
}

const SYSTEM = "You locate commercial lease terms (India office leasing: leases, LOIs, term sheets, offers) in a document. For each term you find, return the page number and a VERBATIM snippet of at most 25 words copied exactly from that page, plus the value as written. Do not compute, convert or infer values. If a term is not in the document, omit it.";

export function termsTable(terms: ExtractedTerm[], title: string): Block {
  return {
    kind: "table", title, columns: ["Term", "Value (normalised)", "Page", "Verbatim snippet", "Confidence", "Check"],
    rows: terms.map((x) => [FIELD_LABEL[x.field], displayNormalised(x.normalised) ?? (x.verified ? "see snippet" : "unknown"), x.page, x.snippet ? `“${x.snippet}”` : null, x.verified ? Math.round(x.confidence * 100) / 100 : null, x.flag ?? (x.verified ? "verified on page" : "not found")]),
    note: "Snippets are checked against the page text; unverifiable ones are dropped. Numbers and dates are parsed by code from the verified snippet, not by the model. Not legal advice.",
  };
}

const extractLeaseTerms = defineTool({
  id: "extract_lease_terms", module: "documents", category: "B", minRole: "member", timeoutMs: 60_000,
  description: "Extract lease/LOI/term-sheet/offer terms from a PDF or DOCX attached to this chat: parties, premises, area + basis, rent, escalation, lock-in, term, start/expiry/rent-commencement dates, notice, deposit, CAM, parking, fit-out, renewal options, special clauses. Each term comes with page number, a verbatim snippet checked against that page, and confidence; unknown stays unknown. Saves the extraction (returns extractionId) so save_lease_terms can propose it onto a lease record.",
  input: z.object({
    attachmentId: z.string().describe("Assistant attachment id (from the chat's attached files)"),
    docKind: z.enum(["lease", "loi", "term_sheet", "offer", "other"]).optional(),
  }),
  async run(i, t) {
    const a = await loadAttachment(t, "extract_lease_terms", i.attachmentId);
    if (!a) return denied(t, "extract_lease_terms", { entity: "assistant_attachment", id: i.attachmentId });
    const pages = attachmentPages(a);
    if (!pages.some((p) => p.trim())) return { ok: false, error: "no_text", summary: `${a.file_name}: no text could be extracted (scanned PDF?) — nothing extracted, nothing guessed.`, missing: ["Document text (OCR needed)"] };
    let model = "heuristic"; let mocked = true; let raw;
    try {
      const r = await callStructured({
        workspaceId: ws(t), workflow: "assistant.lease_terms", tier: "luna", system: SYSTEM,
        input: `Document kind: ${i.docKind ?? "unknown"}. Pages are wrapped in <page n="…"> tags. Return fields with page + verbatim snippet (≤25 words).`,
        evidence: pagesForPrompt(pages), schema: ModelTermsSchema, schemaName: "lease_terms", maxOutputTokens: 3000,
        mock: () => heuristicTerms(pages), requestId: t.runId,
      });
      raw = r.data; model = r.model; mocked = r.mocked;
    } catch (e) {
      if (!(e instanceof AiUnavailableError)) throw e;
      raw = heuristicTerms(pages);
    }
    const terms = finaliseTerms(raw, pages);
    const flags = terms.filter((x) => x.flag).map((x) => ({ field: x.field, flag: x.flag }));
    const { data: saved, error } = await db(t).from("assistant_lease_extraction").insert({
      workspace_id: ws(t), owner_user_id: t.ctx.userId, attachment_id: a.id, doc_kind: i.docKind ?? null,
      terms: Object.fromEntries(terms.map((x) => [x.field, x])), flags, mocked, model, run_id: isUuid(t.runId) ? t.runId : null,
    }).select("id").single();
    if (error) return failed("Could not save the extraction", error);
    const found = terms.filter((x) => x.verified);
    const dropped = flags.filter((f) => f.flag === "snippet_not_found").map((f) => FIELD_LABEL[f.field as keyof typeof FIELD_LABEL]);
    const unknown = terms.filter((x) => !x.verified && x.flag !== "snippet_not_found").map((x) => FIELD_LABEL[x.field]);
    return {
      ok: true, summary: `${a.file_name}: ${found.length}/${terms.length} terms found with page-verified snippets${dropped.length ? `, ${dropped.length} dropped (snippet not on page)` : ""}`,
      data: { extractionId: saved.id, attachmentId: a.id, file: a.file_name, pages: pages.length, mocked, untrusted: true,
        terms: found.map((x) => ({ field: x.field, value: displayNormalised(x.normalised), page: x.page, snippet: x.snippet, confidence: x.confidence, flag: x.flag })),
        unknown: terms.filter((x) => !x.verified).map((x) => x.field), leaseColumns: leasePatchFromTerms(terms).map((p) => p.column) },
      missing: [...unknown.map((u) => `${u}: not found in the document`), ...dropped.map((d) => `${d}: model snippet not found on the page — dropped`)],
      sources: [{ label: `Attachment: ${a.file_name}`, status: "reported" }],
      blocks: [termsTable(terms, `Terms in ${a.file_name}`)],
    };
  },
});

async function loadExtraction(t: ToolContext, tool: string, id: string): Promise<Row | null> {
  if (!isUuid(id)) { await logDenied(t, tool, { entity: "assistant_lease_extraction", id }); return null; }
  const { data } = await db(t).from("assistant_lease_extraction").select("id, attachment_id, doc_kind, terms").eq("workspace_id", ws(t)).eq("id", id).is("archived_at", null).maybeSingle();
  if (!data) await logDenied(t, tool, { entity: "assistant_lease_extraction", id });
  return data ?? null;
}
async function loadLease(t: ToolContext, tool: string, id: string): Promise<Row | null> {
  if (!isUuid(id)) { await logDenied(t, tool, { entity: "lease", id }); return null; }
  const { data } = await db(t).from("lease").select("id, row_version, tenant_name_raw, area_sf, area_basis, rent_per_sf, rent_basis, start_date, contractual_expiry, tenure_months_raw, lockin_months_raw").eq("workspace_id", ws(t)).eq("id", id).maybeSingle();
  if (!data) await logDenied(t, tool, { entity: "lease", id });
  return data ?? null;
}
class NotVisible extends Error { constructor() { super("not_found_or_no_access"); } }

const sameVal = (a: unknown, b: unknown) => {
  if (a === null || a === undefined) return b === null || b === undefined;
  const na = Number(a); const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== "" ? na === nb : String(a) === String(b);
};

/** Diff of extracted terms vs the lease record (only columns that would change). */
export function leaseDiff(lease: Row, terms: ExtractedTerm[], only?: string[]) {
  const patch = leasePatchFromTerms(terms).filter((p) => !only?.length || only.includes(p.column));
  const changes = patch.filter((p) => !sameVal(lease[p.column], p.value));
  const unsaved = terms.filter((x) => x.verified && !patch.some((p) => p.field === x.field)).map((x) => FIELD_LABEL[x.field]);
  return { changes, unsaved, diff: changes.map((p) => { const term = terms.find((x) => x.field === p.field)!; return { field: `${p.column} (p.${term.page}: “${term.snippet}”)`, before: lease[p.column] ?? null, after: p.value }; }) };
}

const saveLeaseTerms = defineTool({
  id: "save_lease_terms", module: "documents", category: "C", minRole: "member",
  description: "Propose the page-verified terms from an extract_lease_terms result onto an existing lease record (area, area basis, rent per sf, start date, expiry, term, lock-in). Needs approval; the change then goes through Review as a change proposal (never a direct write). Optionally also attach the document to the lease record (legal desk, linked to the lease). Terms without a lease column (escalation, notice, deposit, CAM, parking, fit-out, renewal, special clauses) are listed, not written.",
  input: z.object({
    extractionId: z.string().describe("extractionId returned by extract_lease_terms"),
    leaseId: z.string().describe("The lease record to update"),
    columns: z.array(z.enum(["area_sf", "area_basis", "rent_per_sf", "rent_basis", "start_date", "contractual_expiry", "tenure_months_raw", "lockin_months_raw"])).optional().describe("Only these columns (default: all found)"),
    attachDocument: z.boolean().optional().describe("Also store the document on the lease record (legal desk)"),
  }),
  async plan(i, t): Promise<ApprovalPlan> {
    const x = await loadExtraction(t, "save_lease_terms", i.extractionId); if (!x) throw new NotVisible();
    const l = await loadLease(t, "save_lease_terms", i.leaseId); if (!l) throw new NotVisible();
    const terms = Object.values(x.terms ?? {}) as ExtractedTerm[];
    const d = leaseDiff(l, terms, i.columns);
    return {
      title: `Update lease ${l.tenant_name_raw ?? l.id.slice(0, 8)} from document`, affected: [ref("lease", l.id, l.tenant_name_raw ?? "Lease", HREF.leases())], diff: d.diff,
      explanation: `${d.changes.length ? `${d.changes.length} lease field(s) will be sent to Review as a change proposal (material lease fields need a second approval there).` : "No lease field would change."}${d.unsaved.length ? ` Not written (no lease column): ${d.unsaved.join(", ")}.` : ""}${i.attachDocument ? " The document will also be attached to this lease on the legal desk." : ""}`,
    };
  },
  async run(i, t) {
    try {
      const x = await loadExtraction(t, "save_lease_terms", i.extractionId); if (!x) throw new NotVisible();
      const l = await loadLease(t, "save_lease_terms", i.leaseId); if (!l) throw new NotVisible();
      const terms = Object.values(x.terms ?? {}) as ExtractedTerm[];
      const d = leaseDiff(l, terms, i.columns);
      const done: string[] = []; const pending: string[] = []; const blocked: string[] = [];
      let proposalId: string | null = null;
      if (d.changes.length) {
        const patch: PatchOp[] = d.changes.map((p) => ({ op: "replace", path: `/${p.column}`, value: p.value }));
        const pr = await proposeChange(db(t), ws(t), {
          targetType: "lease", targetId: l.id, operation: "update", expectedVersion: Number(l.row_version), patch,
          reason: `Assistant: terms from attached document (extraction ${x.id}); ${d.diff.map((z) => z.field).join("; ")}`.slice(0, 1900),
          proposedByKind: "user", idempotencyKey: `lease-terms:${x.id}:${l.id}:${d.changes.map((p) => `${p.column}=${p.value}`).join(",")}`, ownerUserId: t.ctx.userId,
        });
        proposalId = (pr as Row)?.id ?? (pr as Row)?.proposal_id ?? null;
        const status = String((pr as Row)?.state ?? (pr as Row)?.status ?? "proposed");
        (status === "applied" ? done : pending).push(...d.changes.map((p) => `${p.column} ${status === "applied" ? "saved" : "awaiting approval in Review"}`));
      }
      if (i.attachDocument) {
        const a = await loadAttachment(t, "save_lease_terms", x.attachment_id);
        const pages = a ? attachmentPages(a) : [];
        const text = pages.join("\f");
        if (!a || text.trim().length < 20) blocked.push("Document not attached: no text");
        else {
          const kind = x.doc_kind === "offer" || !x.doc_kind ? "other" : x.doc_kind;
          const r = await addLegalDocument(db(t), ws(t), { title: String(a.file_name).slice(0, 200).padEnd(2, "_"), docKind: kind, text, leaseId: l.id }, { userId: t.ctx.userId });
          done.push(r.duplicate ? "Document already on the legal desk" : `Document attached to lease (${r.clauseCount} clauses extracted for review)`);
        }
      }
      return { ok: true, summary: `${d.changes.length} lease field(s) proposed${i.attachDocument ? "; document attach requested" : ""}`, data: { proposalId, proposed: d.changes.map((p) => p.column), notWritten: d.unsaved }, entities: [ref("lease", l.id, l.tenant_name_raw ?? "Lease", HREF.leases())], blocks: [{ kind: "status", done, pending, blocked: [...blocked, ...d.unsaved.map((u) => `${u}: no lease column — kept in the extraction only`)] }] };
    } catch (e) {
      if (e instanceof NotVisible) return { ok: false, error: "not_found_or_no_access", summary: "Record not found or you don't have access." };
      return failed(`Lease update not proposed: ${errMsg(e)}`, e);
    }
  },
});

export const documents2Tools = [extractLeaseTerms, saveLeaseTerms];
export const documents2Group = "documents";
