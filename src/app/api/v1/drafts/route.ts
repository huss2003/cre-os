import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { createDraft } from "@/lib/services/drafts";
import { parseJson, route } from "@/lib/util/http";
import { asHttp } from "@/modules/integrations/http";
import { listDrafts } from "@/modules/integrations/drafts-view";

const CHANNELS = ["email", "whatsapp", "linkedin", "calendar_invite", "introduction", "market_note", "post"] as const;
const STATES = ["drafted", "approved", "opened_for_send", "marked_sent", "reconciled_sent", "discarded", "paused"] as const;

/** GET /api/v1/drafts?channel=&state= — draft queue (RLS). No send endpoint exists anywhere (S3). */
export const GET = route(async (req) => {
  const ctx = await requireContext("viewer");
  const sp = req.nextUrl.searchParams;
  const channel = sp.get("channel");
  const state = sp.get("state");
  return { drafts: await listDrafts(ctx.db, ctx.workspaceId, {
    channel: channel && (CHANNELS as readonly string[]).includes(channel) ? channel : null,
    states: state && (STATES as readonly string[]).includes(state) ? [state] : null,
  }) };
});

const body = z.object({
  channel: z.enum(CHANNELS),
  recipientPersonId: z.string().uuid().nullable().optional(),
  recipientDisplay: z.string().trim().max(200).nullable().optional(),
  recipientAddress: z.string().trim().max(500).nullable().optional(),
  subject: z.string().max(300).nullable().optional(),
  body: z.string().min(1).max(20_000),
  attachmentDocumentIds: z.array(z.string().uuid()).max(20).optional(),
  opportunityId: z.string().uuid().nullable().optional(),
  orgId: z.string().uuid().nullable().optional(),
  purpose: z.string().max(300).optional(),
});

/** POST /api/v1/drafts — create a draft (suppression checked). */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const v = await parseJson(req, body);
  const draft = await asHttp(() => createDraft(ctx.db, ctx.workspaceId, { ...v, createdByKind: "user", ownerUserId: ctx.userId }));
  return { draft };
}, { requireIdempotency: true });
