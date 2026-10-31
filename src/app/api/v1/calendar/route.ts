import { HttpError, requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { agenda, clusterByLocality, findConflicts } from "@/modules/integrations/calendar";

/** GET /api/v1/calendar?from=ISO&to=ISO — agenda (default today-1 .. +14 days) with conflicts and locality clusters. */
export const GET = route(async (req) => {
  const ctx = await requireContext("viewer");
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from") ? new Date(sp.get("from")!) : new Date(Date.now() - 86_400_000);
  const to = sp.get("to") ? new Date(sp.get("to")!) : new Date(Date.now() + 14 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new HttpError(400, "invalid from/to");
  const items = await agenda(ctx.db, ctx.workspaceId, from, to);
  return { items, conflicts: findConflicts(items), clusters: clusterByLocality(items, ctx.timezone) };
});
