import { z } from "zod";
import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { upsertWatch } from "@/modules/intelligence/research/service";
import { watchlistView } from "@/modules/intelligence/research/queries";

export const GET = route(async () => {
  const ctx = await requireContext();
  return guard(watchlistView(ctx.db, ctx.workspaceId));
});

const Body = z.object({ orgId: z.string().uuid(), tier: z.enum(["critical", "active", "universe"]), reason: z.string().max(300).optional().nullable() });
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  return guard(upsertWatch(ctx.db, ctx.workspaceId, { ...b, userId: ctx.userId }));
}, { requireIdempotency: true });
