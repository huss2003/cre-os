import { route } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { latestAnalysis, runMarketAnalysis } from "@/modules/intelligence/market/service";

export const GET = route(async () => {
  const ctx = await requireContext();
  return { analysis: await guard(latestAnalysis(ctx.db, ctx.workspaceId)) };
});

/** Manual re-run of the market data checks (imports trigger it automatically via intelligence.market_analysis). */
export const POST = route(async () => {
  const ctx = await requireContext("editor");
  return guard(runMarketAnalysis(ctx.db, ctx.workspaceId, { trigger: "manual", ownerUserId: ctx.userId }));
}, { requireIdempotency: true });
