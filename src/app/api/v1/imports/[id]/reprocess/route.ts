import { requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { reprocess } from "@/modules/imports/service";

/** POST /api/v1/imports/[id]/reprocess — re-run detection/mapping/upserts on the stored original (idempotent). */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext("editor");
  return reprocess(ctx, uuid.parse(params.id));
}, { requireIdempotency: true });
