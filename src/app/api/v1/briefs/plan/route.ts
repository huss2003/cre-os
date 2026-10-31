import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { loadCtxFor, parseDateParam, todayFor } from "@/modules/brief/context";
import { loadSettings } from "@/modules/brief/db";
import { buildDailyPlan, computeDailyPlan, latestPlan } from "@/modules/brief/plan";

export const maxDuration = 60;

/** GET /api/v1/briefs/plan[?date=] — latest stored day plan (day order, blocked, conflicts); live preview if none. */
export const GET = route(async (req) => {
  const ctx = await requireContext();
  const date = parseDateParam(req.nextUrl.searchParams.get("date"), todayFor(ctx));
  const lc = loadCtxFor(ctx);
  const stored = await latestPlan(lc, date);
  if (stored?.agenda) return { date, stored: true, plan: stored };
  const settings = await loadSettings(ctx.db, ctx.workspaceId, ctx.userId);
  return { date, stored: false, plan: await computeDailyPlan(lc, settings, date) };
});

/** POST /api/v1/briefs/plan — re-plan today now (deterministic; same input version → same plan row). */
export const POST = route(async () => {
  const ctx = await requireContext("editor");
  const settings = await loadSettings(ctx.db, ctx.workspaceId, ctx.userId);
  const p = await buildDailyPlan(loadCtxFor(ctx), settings, todayFor(ctx), { reason: "api re-plan" });
  return { id: p.id, date: p.planDate, inputVersion: p.inputVersion, agenda: p.agenda };
}, { requireIdempotency: true });
