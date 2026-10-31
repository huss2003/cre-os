import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import type { AiCall } from "../common";
import { addLegalDocument } from "./service";

/**
 * Legal desk file intake: PDF (unpdf) and DOCX (mammoth) → text with page / paragraph structure kept.
 * The original is stored read-only in storage (mudar-workspace-files/<ws>/legal/<sha256>/<name>) and registered as a
 * source_object; legal_document.source_object_id links back to it. A PDF without a text layer is NOT guessed at:
 * it is stored with ocr_status = 'ocr_needed' and no clauses until verified text is supplied.
 */
export const BUCKET = "mudar-workspace-files";
export const MAX_LEGAL_BYTES = 20 * 1024 * 1024;
/** Average non-whitespace characters per page below which a PDF page is treated as scanned (no text layer). */
export const MIN_CHARS_PER_PAGE = 25;

export type FileKind = "pdf" | "docx" | "text";

export function detectKind(fileName: string, bytes: Uint8Array): FileKind | null {
  const head = String.fromCharCode(...bytes.slice(0, 5));
  if (head.startsWith("%PDF")) return "pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && /\.docx$/i.test(fileName)) return "docx";
  if (/\.(txt|md)$/i.test(fileName)) return "text";
  return null;
}

export interface ExtractedText { kind: FileKind; text: string; pageCount: number | null; emptyPages: number[]; ocrStatus: "not_needed" | "ocr_needed" | "ocr_unverified"; notes: string[] }

/** Pure-ish text extraction. PDF pages are joined with form feeds so clause locators carry page numbers. */
export async function extractDocumentText(fileName: string, bytes: Uint8Array): Promise<ExtractedText> {
  const kind = detectKind(fileName, bytes);
  if (!kind) throw new Error("Unsupported file: upload a PDF, a Word .docx or a .txt file.");
  if (kind === "text") return { kind, text: new TextDecoder().decode(bytes), pageCount: null, emptyPages: [], ocrStatus: "not_needed", notes: [] };
  if (kind === "docx") {
    const mammoth = (await import("mammoth")).default;
    const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const text = r.value.replace(/\n{3,}/g, "\n\n").trim();
    const notes = r.messages.filter((m) => m.type === "warning").slice(0, 5).map((m) => `DOCX: ${m.message}`);
    if (!text) return { kind, text: "", pageCount: null, emptyPages: [], ocrStatus: "ocr_needed", notes: [...notes, "The Word file contains no text (images only?) — OCR or a text version is needed."] };
    return { kind, text, pageCount: null, emptyPages: [], ocrStatus: "not_needed", notes: [...notes, "Paragraph locators (¶) follow the Word paragraphs; DOCX has no fixed pages."] };
  }
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text: pages } = await extractText(pdf, { mergePages: false });
  const pageTexts = (pages as string[]).map((p) => p.replace(/\f/g, " ").replace(/[ \t]+\n/g, "\n").trim());
  const emptyPages = pageTexts.map((p, i) => (p.replace(/\s/g, "").length < MIN_CHARS_PER_PAGE ? i + 1 : 0)).filter(Boolean);
  const total = pageTexts.join("").replace(/\s/g, "").length;
  if (total < MIN_CHARS_PER_PAGE * Math.max(1, totalPages) || emptyPages.length === totalPages) {
    return { kind, text: "", pageCount: totalPages, emptyPages, ocrStatus: "ocr_needed", notes: [`No text layer found on ${emptyPages.length} of ${totalPages} page(s): this looks like a scan. OCR is needed — clauses were not extracted. Upload a text PDF/DOCX or paste verified OCR text as a new version.`] };
  }
  const notes = emptyPages.length ? [`Page(s) ${emptyPages.join(", ")} have no text layer (scanned?) — OCR is needed for those pages; clauses on them are missing.`] : [];
  return { kind, text: pageTexts.join("\n\f"), pageCount: totalPages, emptyPages, ocrStatus: emptyPages.length ? "ocr_unverified" : "not_needed", notes };
}

export const UploadMeta = z.object({
  title: z.string().min(2).max(200),
  docKind: z.enum(["loi", "term_sheet", "lease", "amendment", "other"]).default("loi"),
  familyKey: z.string().max(120).optional().nullable(),
  opportunityId: z.string().uuid().optional().nullable(),
  orgId: z.string().uuid().optional().nullable(),
  assetId: z.string().uuid().optional().nullable(),
  leaseId: z.string().uuid().optional().nullable(),
});

const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "document";

/** Store the original + source_object, extract text, then version + extract clauses (same family/hash => existing version). */
export async function uploadLegalDocument(db: Db, workspaceId: string, file: { name: string; bytes: Uint8Array }, rawMeta: z.input<typeof UploadMeta>, opts: { userId: string; ai?: AiCall }) {
  const meta = UploadMeta.parse(rawMeta);
  if (file.bytes.length === 0) throw new Error("The file is empty.");
  if (file.bytes.length > MAX_LEGAL_BYTES) throw new Error("File too large (20 MB max).");
  const extracted = await extractDocumentText(file.name, file.bytes);
  const sha = createHash("sha256").update(file.bytes).digest("hex");

  let { data: so } = await db.from("source_object").select("id").eq("workspace_id", workspaceId).eq("kind", "file").eq("sha256", sha).is("archived_at", null).limit(1).maybeSingle();
  if (!so) {
    const path = `${workspaceId}/legal/${sha}/${safeName(file.name)}`;
    const mime = extracted.kind === "pdf" ? "application/pdf" : extracted.kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain";
    const up = await db.storage.from(BUCKET).upload(path, file.bytes, { contentType: mime, upsert: false });
    if (up.error && !/exists|duplicate/i.test(up.error.message)) throw new Error(`storage upload failed: ${up.error.message}`);
    const ins = await db.from("source_object").insert({
      workspace_id: workspaceId, owner_user_id: opts.userId, kind: "file", uri: `storage://${BUCKET}/${path}`, file_name: file.name, sha256: sha,
      meta: { module: "legal", storage_bucket: BUCKET, storage_path: path, mime, size: file.bytes.length, pages: extracted.pageCount, file_kind: extracted.kind, read_only: true },
    }).select("id").single();
    if (ins.error) throw ins.error;
    so = ins.data;
  }
  return addLegalDocument(db, workspaceId, { ...meta, text: extracted.text, ocrUnverified: extracted.ocrStatus !== "not_needed" }, {
    userId: opts.userId, ai: opts.ai,
    file: { sourceObjectId: so!.id as string, fileKind: extracted.kind, sha256: sha, pageCount: extracted.pageCount, ocrStatus: extracted.ocrStatus, notes: extracted.notes },
  });
}

/** Download the stored original through RLS (row visible => storage policy re-checked). */
export async function legalOriginal(db: Db, workspaceId: string, documentId: string) {
  const { data: doc } = await db.from("legal_document").select("id, source_object_id, title, version").eq("workspace_id", workspaceId).eq("id", documentId).maybeSingle();
  if (!doc?.source_object_id) throw new Error("No stored original for this document (pasted text).");
  const { data: so } = await db.from("source_object").select("uri, file_name, sha256, meta").eq("workspace_id", workspaceId).eq("id", doc.source_object_id).maybeSingle();
  if (!so) throw new Error("Original not found or not visible.");
  const path = String(so.uri).replace(`storage://${BUCKET}/`, "");
  if (!path.startsWith(`${workspaceId}/`)) throw new Error("not visible: unexpected storage path");
  const dl = await db.storage.from(BUCKET).download(path);
  if (dl.error || !dl.data) throw new Error("Original file not found.");
  const buffer = Buffer.from(await dl.data.arrayBuffer());
  if (createHash("sha256").update(buffer).digest("hex") !== so.sha256) throw new Error("Stored original does not match its recorded hash.");
  return { buffer, fileName: String(so.file_name ?? "document"), mime: String((so.meta as Record<string, unknown>)?.mime ?? "application/octet-stream") };
}
