import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { localDate } from "@/lib/util/time";
import { loadCapacity } from "@/modules/orchestrator/capacity/service";
import { loadOrchSettings } from "@/modules/orchestrator/schedule/settings-db";

/** GET /api/v1/orchestrator/capacity?date=YYYY-MM-DD — free time, placements, conflicts, warnings, rescheduling suggestions (RLS). */
export const GET = route(async (req) => {
  const ctx = await requireContext();
  const s = await loadOrchSettings(ctx.db, ctx.workspaceId, ctx.userId);
  const q = req.nextUrl.searchParams.get("date");
  const date = q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : localDate(new Date(), s.timezone);
  return { capacity: await loadCapacity({ db: ctx.db, workspaceId: ctx.workspaceId, userId: ctx.userId, tz: s.timezone, access: null }, s, date) };
});
