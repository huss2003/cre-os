import { enqueueEmbed } from "@/modules/assistant/documents/jobs";
import { HttpError, requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { MAX_ATTACHMENT_BYTES, uploadAttachment } from "@/modules/assistant/engine/attachments";

export const runtime = "nodejs";

/** POST /api/v1/assistant/attachments (multipart: file, conversationId?) → {id, name, pages, chars}. */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const form = await req.formData().catch(() => { throw new HttpError(400, "multipart form expected"); });
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "file is required");
  if (file.size > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "File is larger than 15 MB.");
  const conv = form.get("conversationId");
  const r = await uploadAttachment(ctx, { name: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }, typeof conv === "string" && conv ? uuid.parse(conv) : null);
  await enqueueEmbed(ctx.workspaceId).catch(() => null); // index for smart search (no-op without an embeddings key)
  return { id: r.id, name: r.name, pages: r.pages, chars: r.chars, note: r.note ?? null };
}, { requireIdempotency: true });
