import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { parseJson, route, uuid } from "@/lib/util/http";
import { setChecklistItem, VisitInputError } from "@/modules/integrations/calendar";

const body = z.object({
  itemKey: z.string().max(80).nullable().optional(),
  label: z.string().max(200).nullable().optional(),
  done: z.boolean(),
});

/** POST /api/v1/calendar/:id/checklist — tick / untick a visit checklist item, or add a custom item (label). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  try {
    return { item: await setChecklistItem(ctx.db, ctx.workspaceId, id, await parseJson(req, body), ctx.userId) };
  } catch (e) {
    if (e instanceof VisitInputError) throw new HttpError(400, e.message);
    throw e;
  }
}, { requireIdempotency: true });
