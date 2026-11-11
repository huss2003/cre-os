import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { parseJson, route } from "@/lib/util/http";
import { ExportError, exportMessage } from "@/modules/assistant/outputs/export";

const Body = z.object({ messageId: z.string().uuid(), format: z.enum(["pptx", "docx", "pdf"]) });

/** POST /api/v1/assistant/exports {messageId, format} → builds a branded file from the message's blocks; returns {href, fileName}. */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  try { return await exportMessage(ctx, b); }
  catch (e) { if (e instanceof ExportError) throw new HttpError(e.status, e.message); throw e; }
}, { requireIdempotency: true });
