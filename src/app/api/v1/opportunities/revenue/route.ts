import { dealsRoute } from "@/modules/deals/api";
import { revenueReport } from "@/modules/deals/fees/report-service";
import { localDate } from "@/lib/util/time";

/** Revenue controller report: fee register (each amount with status + transaction link), forecast, aging, slippage, cohort funnel. */
export const GET = dealsRoute({}, async (req, ctx) => {
  const asOf = req.nextUrl.searchParams.get("asOf");
  return revenueReport(ctx, asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : localDate());
});
