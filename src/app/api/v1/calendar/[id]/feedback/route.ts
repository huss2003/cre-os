import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { parseJson, route, uuid } from "@/lib/util/http";
import { saveVisitFeedback } from "@/modules/integrations/calendar";

const body = z.object({
  attended: z.boolean().nullable().optional(),
  clientRating: z.number().int().min(1).max(5).nullable().optional(),
  liked: z.string().max(2000).nullable().optional(),
  concerns: z.string().max(2000).nullable().optional(),
  dealbreakers: z.string().max(2000).nullable().optional(),
  nextStep: z.string().max(300).nullable().optional(),
  followUpDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

/** POST /api/v1/calendar/:id/feedback — visit feedback (one per visit; next step becomes one task). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  return saveVisitFeedback(ctx.db, ctx.workspaceId, id, await parseJson(req, body), ctx.userId);
}, { requireIdempotency: true });
