import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { parseJson, route } from "@/lib/util/http";
import { actOnNotification, NotificationError } from "@/modules/orchestrator/notify/service";

const Body = z.object({ action: z.enum(["dismiss", "snooze", "complete"]), until: z.string().datetime().optional() });

/** POST /api/v1/orchestrator/notifications/:id {action: dismiss|snooze|complete, until?} (Idempotency-Key required). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext();
  const b = await parseJson(req, Body);
  try { return await actOnNotification(ctx.db, ctx.workspaceId, ctx.userId, z.string().uuid().parse(params.id), b.action, { until: b.until }); }
  catch (e) { if (e instanceof NotificationError) throw new HttpError(400, e.message); throw e; }
}, { requireIdempotency: true });
