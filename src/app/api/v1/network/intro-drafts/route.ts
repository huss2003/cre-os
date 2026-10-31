import { z } from "zod";
import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { draftIntroRequest } from "@/modules/intelligence/network/relationships";

/** Draft (never send) an introduction request. 400 unless the introducer's consent is recorded and active. */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, z.object({ edgeId: z.string().uuid() }));
  return guard(draftIntroRequest(ctx.db, ctx.workspaceId, { edgeId: b.edgeId, userId: ctx.userId }));
}, { requireIdempotency: true });
