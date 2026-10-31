import { route } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { marketOverview } from "@/modules/intelligence/market/service";

export const GET = route(async () => {
  const ctx = await requireContext();
  return guard(marketOverview(ctx.db, ctx.workspaceId));
});
