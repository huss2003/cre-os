import type { JobHandler } from "@/lib/jobs/queue";
import * as jobsB from "./jobs-b";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { callStructured, AiUnavailableError } from "@/lib/ai/gateway";
import { localDate, atLocal } from "@/lib/util/time";
import type { AiCall } from "./common";
import { dueForResearch, generateDossier } from "./research/service";
import { runPatrol } from "./research/patrol-service";

/**
 * Intelligence jobs (service role; every query filters workspace_id explicitly):
 *  - intelligence.patrol    daily evidence conflict & expiry patrol -> evidence_finding (deduped)
 *  - intelligence.research  daily refresh of due watchlist dossiers. Re-runs only on changed evidence or elapsed tier
 *                           interval. Once the AI budget is exhausted, remaining dossiers use the rule synthesis
 *                           (spend cap: non-critical AI research stops, local work continues).
 */

/** Wrap the gateway so that after the first budget/pause refusal no further AI calls are attempted in this run. */
export function budgetLatch(ai: AiCall = callStructured as AiCall): { ai: AiCall; tripped: () => string | null } {
  let reason: string | null = null;
  const wrapped: AiCall = async (call) => {
    if (reason) throw new AiUnavailableError(reason as "budget_exceeded", `AI skipped: ${reason}`);
    try {
      return await ai(call);
    } catch (e) {
      if (e instanceof AiUnavailableError && (e.reason === "budget_exceeded" || e.reason === "paused")) reason = e.reason;
      throw e;
    }
  };
  return { ai: wrapped, tripped: () => reason };
}

export async function runResearchRefresh(workspaceId: string, now: Date, opts: { ai?: AiCall; limit?: number } = {}) {
  const db = createAdminClient();
  const orgIds = await dueForResearch(db, workspaceId, now, opts.limit ?? 50);
  const latch = budgetLatch(opts.ai);
  const out = { due: orgIds.length, generated: 0, skipped: 0, degraded: 0, errors: 0 };
  for (const orgId of orgIds) {
    try {
      const r = await generateDossier(db, workspaceId, orgId, { now, ai: latch.ai });
      if (r.status === "generated") out.generated++; else out.skipped++;
      if (r.synthesis_status === "fallback_no_ai") out.degraded++;
    } catch (e) {
      out.errors++;
      console.warn(`[intelligence.research] ${workspaceId}/${orgId}:`, e instanceof Error ? e.message : e);
    }
  }
  return { ...out, ai_stopped: latch.tripped() };
}

const ownHandlers: Record<string, JobHandler> = {
  "intelligence.patrol": async (job) => {
    if (!job.workspace_id) throw new Error("intelligence.patrol requires workspace_id");
    return runPatrol(createAdminClient(), job.workspace_id, new Date());
  },
  "intelligence.research": async (job) => {
    if (!job.workspace_id) throw new Error("intelligence.research requires workspace_id");
    return runResearchRefresh(job.workspace_id, new Date());
  },
};

/** intel-B half (legal, market, content) registers in ./jobs-b.ts and is merged here. */
export const handlers: Record<string, JobHandler> = { ...ownHandlers, ...jobsB.handlers };

export const PATROL_LOCAL_TIME = "05:30";
export const RESEARCH_LOCAL_TIME = "05:45";

/** Called by /api/cron/tick. Dedupe keys make repeated ticks no-ops (one run per workspace per local day). */
export async function schedule(now: Date): Promise<void> {
  await jobsB.schedule(now);
  const admin = createAdminClient();
  const { data: list } = await admin.from("workspace").select("id, timezone, status").eq("status", "active");
  for (const ws of list ?? []) {
    const tz = ws.timezone || "Asia/Kolkata";
    const day = localDate(now, tz);
    const patrolAt = atLocal(day, PATROL_LOCAL_TIME, tz);
    if (now >= patrolAt) await enqueue({ workspaceId: ws.id, type: "intelligence.patrol", dedupeKey: `intelligence.patrol:${ws.id}:${day}`, dueAt: patrolAt, maxAttempts: 3 });
    const researchAt = atLocal(day, RESEARCH_LOCAL_TIME, tz);
    if (now >= researchAt) await enqueue({ workspaceId: ws.id, type: "intelligence.research", dedupeKey: `intelligence.research:${ws.id}:${day}`, dueAt: researchAt, maxAttempts: 3 });
  }
}
