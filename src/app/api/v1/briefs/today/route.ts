import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { latestBrief } from "@/modules/brief/brief-service";
import { parseDateParam, todayFor } from "@/modules/brief/context";


/** GET /api/v1/briefs/today[?date=YYYY-MM-DD&kind=daily|reconciliation] — the caller's latest brief version (RLS). */
export const GET = route(async (req) => {
  const ctx = await requireContext();
  const date = parseDateParam(req.nextUrl.searchParams.get("date"), todayFor(ctx));
  const kindParam = req.nextUrl.searchParams.get("kind");
  const kind = kindParam === "reconciliation" ? "reconciliation" : "daily";
  const brief = await latestBrief(ctx.db, ctx.workspaceId, ctx.userId, date, kind);
  return { date, brief };
});
