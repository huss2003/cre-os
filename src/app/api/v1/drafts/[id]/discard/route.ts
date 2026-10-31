import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { discardDraft } from "@/lib/services/drafts";
import { parseJson, route, uuid } from "@/lib/util/http";
import { asHttp } from "@/modules/integrations/http";

const body = z.object({ reason: z.string().max(300).optional() });

/** POST /api/v1/drafts/:id/discard */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  const v = await parseJson(req, body);
  return { draft: await asHttp(() => discardDraft(ctx.db, ctx.workspaceId, id, ctx.userId, v.reason)) };
}, { requireIdempotency: true });
