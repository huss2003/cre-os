import { route } from "@/lib/util/http";
import { HttpError, requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { uploadLegalDocument, MAX_LEGAL_BYTES } from "@/modules/intelligence/legal/upload";
import { LEGAL_DISCLAIMER } from "@/modules/intelligence/common";

/**
 * POST /api/v1/legal/documents/upload (multipart: file, title, doc_kind?, family_key?, lease_id?, org_id?, asset_id?) — editor+.
 * PDF (text layer) / DOCX / TXT. The original is stored read-only and linked as a source_object; scanned PDFs are stored
 * with ocr_status "ocr_needed" and no clauses. Same family + same content => the existing version (duplicate=true).
 */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File)) throw new HttpError(400, "multipart field 'file' is required");
  if (file.size > MAX_LEGAL_BYTES) throw new HttpError(413, "file too large (20 MB max)");
  const s = (k: string) => { const v = form.get(k); return typeof v === "string" && v.trim() ? v.trim() : null; };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const r = await guard(uploadLegalDocument(ctx.db, ctx.workspaceId, { name: file.name, bytes }, {
    title: s("title") ?? file.name.replace(/\.[a-z0-9]+$/i, ""), docKind: (s("doc_kind") ?? "loi") as never, familyKey: s("family_key"),
    leaseId: s("lease_id"), orgId: s("org_id"), assetId: s("asset_id"),
  }, { userId: ctx.userId }));
  return { disclaimer: LEGAL_DISCLAIMER, ...r };
}, { requireIdempotency: true });
