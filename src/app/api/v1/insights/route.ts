import { route } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { insightsOverview } from "@/modules/intelligence/insights/service";

export const GET = route(async () => {
  const ctx = await requireContext();
  const d = await guard(insightsOverview(ctx.db, ctx.workspaceId));
  const { opps: _opps, ...funnel } = d.funnel;
  return { ...d, funnel };
});
