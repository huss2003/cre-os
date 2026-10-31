import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { getDraft, updateDraft } from "@/lib/services/drafts";
import { parseJson, route, uuid } from "@/lib/util/http";
import { asHttp } from "@/modules/integrations/http";
import { draftEvents } from "@/modules/integrations/drafts-view";

type P = { id: string };

/** GET /api/v1/drafts/:id — draft + lifecycle events. */
export const GET = route<P>(async (_req, { params }) => {
  const ctx = await requireContext("viewer");
  const id = uuid.parse(params.id);
  const draft = await asHttp(() => getDraft(ctx.db, ctx.workspaceId, id));
  return { draft, events: await draftEvents(ctx.db, ctx.workspaceId, id) };
});

const body = z.object({
  expectedVersion: z.number().int().positive(),
  recipientPersonId: z.string().uuid().nullable().optional(),
  recipientDisplay: z.string().trim().max(200).nullable().optional(),
  recipientAddress: z.string().trim().max(500).nullable().optional(),
  subject: z.string().max(300).nullable().optional(),
  body: z.string().min(1).max(20_000).optional(),
  attachmentDocumentIds: z.array(z.string().uuid()).max(20).optional(),
});

/** PATCH /api/v1/drafts/:id — edit; any content change invalidates approval (DB-enforced). */
export const PATCH = route<P>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  const { expectedVersion, ...edit } = await parseJson(req, body);
  return asHttp(() => updateDraft(ctx.db, ctx.workspaceId, id, edit, { expectedVersion, actorUserId: ctx.userId }));
}, { requireIdempotency: true });
