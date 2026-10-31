import { requireContext } from "@/lib/auth/context";
import { markDraftSent } from "@/lib/services/drafts";
import { route, uuid } from "@/lib/util/http";
import { asHttp } from "@/modules/integrations/http";
import { afterMarkedSent } from "@/modules/integrations/drafts-view";

/** POST /api/v1/drafts/:id/mark-sent — user assertion (sent_evidence='user_assertion'); Sent Items may later reconcile. */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  const res = await asHttp(() => markDraftSent(ctx.db, ctx.workspaceId, id, ctx.userId));
  if (!res.already) await afterMarkedSent(ctx.db, ctx.workspaceId, res.draft, ctx.userId);
  return res;
}, { requireIdempotency: true });
