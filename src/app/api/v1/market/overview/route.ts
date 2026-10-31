import { route } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { marketOverview } from "@/modules/intelligence/market/service";

/** Gated series (each with period, unit, sources + release dates, sample size), flags, excluded/superseded rows with reasons. */
export const GET = route(async () => {
  const ctx = await requireContext();
  const { sources, geos, ...ov } = await guard(marketOverview(ctx.db, ctx.workspaceId));
  return { ...ov, geographies: geos.map((g) => ({ id: g.id, name: g.name })), sources: [...sources.entries()].map(([key, v]) => ({ key, ...v })) };
});
