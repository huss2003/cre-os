import "server-only";
import { createHash } from "node:crypto";
import { HttpError, type AppContext } from "@/lib/auth/context";
import { STORAGE_BUCKET } from "@/lib/supabase/schema";

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_TEXT = 200_000;

/** PDF (unpdf), DOCX (mammoth), TXT/CSV/MD/JSON. Scanned PDFs yield no text (no OCR guess). Text is untrusted evidence. */
export async function extractAttachmentText(bytes: Uint8Array, name: string, mime: string): Promise<{ text: string; pages: number | null; kind: string; pageTexts?: string[] }> {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf" || ext === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pageTexts = (Array.isArray(text) ? text : [String(text ?? "")]).map((p) => String(p ?? "").replace(/\u0000/g, ""));
    return { text: pageTexts.join("\n\f\n"), pages: totalPages, kind: "pdf", pageTexts };
  }
  if (ext === "docx" || mime.includes("wordprocessingml")) {
    const mammoth = (await import("mammoth")).default;
    const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { text: r.value, pages: null, kind: "docx", pageTexts: [r.value] };
  }
  if (["txt", "csv", "md", "json", "tsv"].includes(ext) || mime.startsWith("text/")) {
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), pages: null, kind: ext || "text" };
  }
  throw new HttpError(415, "Unsupported file type. Use PDF, DOCX, TXT, CSV or MD.");
}

/** Keep per-page text within the same overall cap as extracted_text. */
function capPages(pages: string[], max: number): string[] {
  const out: string[] = []; let left = max;
  for (const p of pages) { if (left <= 0) break; const s = p.slice(0, left); out.push(s); left -= s.length; }
  return out;
}

export async function uploadAttachment(ctx: AppContext, file: { name: string; mime: string; bytes: Uint8Array }, conversationId?: string | null) {
  if (file.bytes.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "File is larger than 15 MB.");
  if (!file.bytes.length) throw new HttpError(400, "Empty file.");
  if (conversationId) {
    const { data } = await ctx.db.from("assistant_conversation").select("id").eq("workspace_id", ctx.workspaceId).eq("id", conversationId).maybeSingle();
    if (!data) throw new HttpError(404, "conversation not found");
  }
  const ex = await extractAttachmentText(file.bytes, file.name, file.mime);
  const safeName = file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
  const sha = createHash("sha256").update(file.bytes).digest("hex").slice(0, 32);
  const path = `${ctx.workspaceId}/assistant/${sha}/${safeName}`;
  const up = await ctx.db.storage.from(STORAGE_BUCKET).upload(path, file.bytes, { contentType: file.mime || "application/octet-stream", upsert: false });
  const stored = !up.error || /exists|duplicate/i.test(up.error.message);
  const text = ex.text.replace(/\u0000/g, "").slice(0, MAX_TEXT);
  const { data, error } = await ctx.db.from("assistant_attachment").insert({
    workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, conversation_id: conversationId ?? null, file_name: safeName, mime: file.mime,
    size_bytes: file.bytes.length, storage_path: stored ? path : null, extracted_text: text, pages: ex.pages,
    page_texts: ex.pageTexts ? capPages(ex.pageTexts, MAX_TEXT) : null,
  }).select("id").single();
  if (error || !data) throw new Error(`attachment insert failed: ${error?.message}`);
  return { id: data.id as string, name: safeName, pages: ex.pages, chars: text.length, stored, note: !text.trim() ? "No text could be extracted (scanned PDF?)." : undefined };
}
