import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { enqueue } from "@/lib/jobs/queue";
import { parseJson, route, uuid } from "@/lib/util/http";
import { updatePlannedVisit, VisitInputError } from "@/modules/integrations/calendar";

const body = z.object({
  status: z.enum(["confirmed", "cancelled", "provisional"]).optional(),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
});

/** PATCH /api/v1/calendar/:id — confirm / cancel / reschedule a hand-planned visit (synced events are read-only). */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  try {
    const mv = await updatePlannedVisit(ctx.db, ctx.workspaceId, id, await parseJson(req, body));
    await enqueue({ workspaceId: ctx.workspaceId, type: "integrations.calendar_conflicts", dedupeKey: `integrations.calendar_conflicts:${ctx.workspaceId}:${mv.id}:${mv.version_key}:${mv.status}` });
    return { visit: mv };
  } catch (e) {
    if (e instanceof VisitInputError) throw new HttpError(400, e.message);
    throw e;
  }
}, { requireIdempotency: true });
