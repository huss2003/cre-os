import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { retryImportRun } from "@/modules/imports/service";

/** POST /api/v1/imports/runs/[id]/retry {item_id?} — re-queue failed files with temporary errors; successful files are untouched. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const body = z.object({ item_id: z.string().uuid().nullish() }).parse(await req.json().catch(() => ({})));
  return retryImportRun(ctx, uuid.parse(params.id), body.item_id ?? null);
}, { requireIdempotency: true });
