import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { parseJson, route } from "@/lib/util/http";
import { draftInvite } from "@/modules/integrations/calendar";
import { asHttp } from "@/modules/integrations/http";

const body = z.object({
  title: z.string().trim().min(1).max(200),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  location: z.string().max(300).nullable().optional(),
  attendeeAddress: z.string().trim().max(320).nullable().optional(),
  attendeeName: z.string().trim().max(200).nullable().optional(),
  recipientPersonId: z.string().uuid().nullable().optional(),
  opportunityId: z.string().uuid().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

/** POST /api/v1/calendar/invites — creates a calendar-invite DRAFT (no calendar write scope; user sends manually). */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const v = await parseJson(req, body);
  if (Date.parse(v.end) <= Date.parse(v.start)) throw new HttpError(400, "end must be after start");
  return { draft: await asHttp(() => draftInvite(ctx.db, ctx.workspaceId, { ...v, tz: ctx.timezone, ownerUserId: ctx.userId })) };
}, { requireIdempotency: true });
