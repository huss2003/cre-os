import { requireContext } from "@/lib/auth/context";
import { openDraftForSend } from "@/lib/services/drafts";
import { route, uuid } from "@/lib/util/http";
import { asHttp } from "@/modules/integrations/http";

/**
 * POST /api/v1/drafts/:id/open — "Open to send". Returns a mailto:/wa.me/LinkedIn link + copy text and sets
 * opened_for_send. CRE OS never sends: the user sends from their own app, then marks it sent.
 */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  return asHttp(() => openDraftForSend(ctx.db, ctx.workspaceId, id, ctx.userId));
}, { requireIdempotency: true });
