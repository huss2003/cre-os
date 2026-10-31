import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { localDate, atLocal } from "@/lib/util/time";
import { runMarketAnalysis } from "./market/service";
import { planWeek } from "./content/service";
import { weekStartOf } from "./content/editor";

/**
 * Job handlers for the intelligence "publishing" half (legal desk, market analyst, content editor).
 * Owned by the intel-B agent. Merged into src/modules/intelligence/jobs.ts. job_type prefix: "intelligence.".
 * Service role: every query in the called services filters workspace_id explicitly (S2).
 *
 *  - intelligence.market_analysis  enqueued by the SQL trigger on market_observation inserts (one per release key,
 *                                  deduped) and monthly (1st, 06:15 local). Refreshes trends, flags inconsistencies,
 *                                  writes market_analysis and an in-app notice. Never publishes anything.
 *  - intelligence.content_plan     weekly (Monday 07:10 local): creates the week's content ideas with planned publish
 *                                  dates (idempotent per week + topic). Drafting, approval and publishing stay manual.
 */
export const MARKET_ANALYSIS_LOCAL_TIME = "06:15";
export const CONTENT_PLAN_LOCAL_TIME = "07:10";

async function workspaceOwner(workspaceId: string): Promise<string | null> {
  const { data } = await createAdminClient().from("membership").select("user_id").eq("workspace_id", workspaceId).eq("role", "owner").order("created_at").limit(1).maybeSingle();
  return (data?.user_id as string | undefined) ?? null;
}

export const handlers: Record<string, JobHandler> = {
  "intelligence.market_analysis": async (job) => {
    if (!job.workspace_id) throw new Error("intelligence.market_analysis requires workspace_id");
    const p = job.payload ?? {};
    const trigger = p.trigger === "scheduled" ? "scheduled" : p.trigger === "manual" ? "manual" : "release";
    const r = await runMarketAnalysis(createAdminClient(), job.workspace_id, {
      trigger, triggerKey: job.dedupe_key, ownerUserId: typeof p.owner_user_id === "string" ? p.owner_user_id : null,
    });
    const a = r.analysis as Record<string, unknown>;
    return { analysis_id: a.id, duplicate: r.duplicate, series: a.series_count, flags: Array.isArray(a.flags) ? a.flags.length : 0 };
  },
  "intelligence.content_plan": async (job) => {
    if (!job.workspace_id) throw new Error("intelligence.content_plan requires workspace_id");
    const owner = typeof job.payload?.owner_user_id === "string" ? job.payload.owner_user_id : await workspaceOwner(job.workspace_id);
    if (!owner) return { skipped: "no workspace owner" };
    const day = typeof job.payload?.week === "string" ? new Date(`${job.payload.week}T06:00:00Z`) : new Date();
    return planWeek(createAdminClient(), job.workspace_id, owner, day);
  },
};

/** Called by /api/cron/tick via intelligence/jobs.ts. Dedupe keys make repeated ticks no-ops. */
export async function schedule(now: Date): Promise<void> {
  const admin = createAdminClient();
  const { data: list } = await admin.from("workspace").select("id, timezone, status").eq("status", "active");
  for (const ws of list ?? []) {
    const tz = ws.timezone || "Asia/Kolkata";
    const day = localDate(now, tz);
    const week = weekStartOf(day);
    const planAt = atLocal(week, CONTENT_PLAN_LOCAL_TIME, tz);
    if (now >= planAt) await enqueue({ workspaceId: ws.id, type: "intelligence.content_plan", payload: { week }, dedupeKey: `intelligence.content_plan:${ws.id}:${week}`, dueAt: planAt, maxAttempts: 3 });
    const monthStart = `${day.slice(0, 7)}-01`;
    const analysisAt = atLocal(monthStart, MARKET_ANALYSIS_LOCAL_TIME, tz);
    if (now >= analysisAt) await enqueue({ workspaceId: ws.id, type: "intelligence.market_analysis", payload: { trigger: "scheduled" }, dedupeKey: `intelligence.market_analysis:${ws.id}:month:${day.slice(0, 7)}`, dueAt: analysisAt, maxAttempts: 3 });
  }
}
