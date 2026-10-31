import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireContext, HttpError } from "@/lib/auth/context";
import { route, parseJson } from "@/lib/util/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { createCapture, listCaptures, processCapture, type NewCapture } from "@/modules/capture/service";
import { asHttp } from "@/modules/changes/http";

export const dynamic = "force-dynamic";

const Body = z.object({
  kind: z.enum(["text", "audio", "image", "mixed"]).default("text"),
  text: z.string().max(20_000).nullish(),
  sourceAt: z.string().datetime({ offset: true }).nullish(),
  languageHint: z.enum(["en", "hi", "hinglish", "mr"]).nullish(),
  consentReference: z.string().max(500).nullish(),
  classification: z.enum(["public", "permitted_personal", "corporate_confidential", "licensed_restricted"]).optional(),
});
const MAX_FILE = 25 * 1024 * 1024;

/** GET /api/v1/captures — recent captures with status and open-question counts. */
export const GET = route(async () => {
  const ctx = await requireContext();
  return { captures: await listCaptures(ctx.db, ctx.workspaceId) };
});

/**
 * POST /api/v1/captures — JSON {kind,text,sourceAt,languageHint,consentReference} or multipart (same fields + file).
 * Requires Idempotency-Key (same key => same capture). Enqueues capture.process and runs it once inline so the
 * review screen is ready; the queued job is then a no-op (idempotent consumers).
 */
export const POST = route(async (req: NextRequest, { idempotencyKey }) => {
  const ctx = await requireContext("editor");
  let input: NewCapture;
  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    const fields = Body.parse(Object.fromEntries([...form.entries()].filter(([k, v]) => k !== "file" && typeof v === "string" && v !== "")));
    if (file && typeof file !== "string" && file.size > MAX_FILE) throw new HttpError(413, "file too large (max 25 MB)");
    input = { ...fields, file: file && typeof file !== "string" ? { name: file.name, type: file.type, bytes: await file.arrayBuffer() } : null };
  } else {
    input = await parseJson(req, Body);
  }
  try {
    const { capture, duplicate } = await createCapture(ctx.db, ctx.workspaceId, ctx.userId, input, idempotencyKey);
    let processed: unknown = null;
    if (!duplicate) {
      try { processed = await processCapture(createAdminClient(), ctx.workspaceId, capture.id); }
      catch (e) { processed = { status: "failed", error: e instanceof Error ? e.message : String(e) }; }
    }
    return { capture: { id: capture.id, status: capture.status }, duplicate, processed, review: `/api/v1/captures/${capture.id}/review` };
  } catch (e) { asHttp(e); }
}, { requireIdempotency: true });
