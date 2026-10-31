import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { generateDailyBrief } from "@/modules/brief/brief-service";
import { loadCtxFor, todayFor } from "@/modules/brief/context";
import { loadSettings } from "@/modules/brief/db";

export const maxDuration = 60;

/**
 * POST /api/v1/briefs/generate — (re)build today's brief now as the signed-in user (RLS-scoped data).
 * Idempotent: identical deterministic content returns the existing version (created=false).
 */
export const POST = route(async () => {
  const ctx = await requireContext("editor");
  const settings = await loadSettings(ctx.db, ctx.workspaceId, ctx.userId);
  const date = todayFor(ctx);
  const { brief, created } = await generateDailyBrief(loadCtxFor(ctx), settings, { date, generatedBy: "user" });
  return { created, brief: { id: brief.id, date: brief.brief_date, version: brief.version, synthesis_status: brief.synthesis_status, generated_at: brief.generated_at } };
}, { requireIdempotency: true });
