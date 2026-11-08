import { HttpError, requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { applySafeChunk } from "@/modules/imports/summary";

export const maxDuration = 60;

/**
 * POST /api/v1/imports/:id/apply-safe — owner/admin only. Approves + applies the next time-boxed chunk of SAFE
 * proposals from this import and returns progress. Idempotent per chunk key; safe to call repeatedly until remaining = 0.
 */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext("admin");
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw new HttpError(400, "bad id");
  const { data: batch } = await ctx.db.from("import_batch").select("id, source_object_id").eq("workspace_id", ctx.workspaceId).eq("id", params.id).maybeSingle();
  if (!batch?.source_object_id) throw new HttpError(404, "import not found");
  return applySafeChunk(ctx.db, ctx.workspaceId, ctx.userId, batch.source_object_id);
}, { requireIdempotency: true });
