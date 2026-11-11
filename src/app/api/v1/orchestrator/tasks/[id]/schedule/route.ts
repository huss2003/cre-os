import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { parseJson, route } from "@/lib/util/http";
import { PRIORITY_CLASSES } from "@/modules/orchestrator/capacity/capacity";
import { CapacityError, setTaskSchedule } from "@/modules/orchestrator/capacity/service";

const Body = z.object({
  estimatedMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  priorityClass: z.enum(PRIORITY_CLASSES).nullable().optional(),
  start: z.string().datetime().nullable().optional(), end: z.string().datetime().nullable().optional(),
});
/** PUT /api/v1/orchestrator/tasks/:id/schedule — estimate, priority class or a user-chosen slot (override of the suggestion). */
export const PUT = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  try { return { schedule: await setTaskSchedule(ctx.db, ctx.workspaceId, ctx.userId, z.string().uuid().parse(params.id), b) }; }
  catch (e) { if (e instanceof CapacityError) throw new HttpError(400, e.message); throw e; }
}, { requireIdempotency: true });
