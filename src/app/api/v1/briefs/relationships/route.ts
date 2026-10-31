import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { computeRelationshipSuggestions } from "@/modules/brief/caretaker-data";
import { todayFor } from "@/modules/brief/context";
import { loadSettings } from "@/modules/brief/db";
import { loadRadar } from "@/modules/brief/radar-data";

/** GET /api/v1/briefs/relationships — follow-up suggestions (promises, post-visit, renewals, referrals); opt-outs withheld. */
export const GET = route(async (req) => {
  const ctx = await requireContext();
  const date = todayFor(ctx);
  const settings = await loadSettings(ctx.db, ctx.workspaceId, ctx.userId);
  const radar = await loadRadar(ctx.db, ctx.workspaceId, date, settings);
  const scope = req.nextUrl.searchParams.get("scope") === "all" ? null : ctx.userId;
  const r = await computeRelationshipSuggestions(ctx.db, ctx.workspaceId, date, radar.items, { userId: scope });
  return { date, suggestions: r.suggestions, withheld: r.withheld.length };
});
