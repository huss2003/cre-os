import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { localDate } from "@/lib/util/time";
import { isoWeekKey } from "@/modules/brief/dates";
import { loadOrchSettings } from "@/modules/orchestrator/schedule/settings-db";

/** GET /api/v1/orchestrator/plan?kind=daily|weekly&period= — the stored daily plan (local date) or weekly review (ISO week). */
export const GET = route(async (req) => {
  const ctx = await requireContext();
  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind") === "weekly" ? "weekly" : "daily";
  const s = await loadOrchSettings(ctx.db, ctx.workspaceId, ctx.userId);
  const today = localDate(new Date(), s.timezone);
  const period = sp.get("period") ?? (kind === "daily" ? today : isoWeekKey(today));
  const { data, error } = await ctx.db.from("orch_plan").select("*").eq("workspace_id", ctx.workspaceId).eq("user_id", ctx.userId).eq("kind", kind).eq("period_key", period).maybeSingle();
  if (error) throw error;
  return { kind, period, timezone: s.timezone, plan: data ?? null };
});
