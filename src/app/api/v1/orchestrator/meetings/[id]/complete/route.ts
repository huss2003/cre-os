import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { confirmMeetingCompleted, MeetingFlowError } from "@/modules/orchestrator/schedule/meetings";

/** POST /api/v1/orchestrator/meetings/:prepId/complete — the user confirms the meeting happened → post-meeting processing is queued. */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext("editor");
  try { return await confirmMeetingCompleted(ctx.db, ctx.workspaceId, z.string().uuid().parse(params.id)); }
  catch (e) { if (e instanceof MeetingFlowError) throw new HttpError(400, e.message); throw e; }
}, { requireIdempotency: true });
