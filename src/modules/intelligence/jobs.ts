import type { JobHandler } from "@/lib/jobs/queue";
import * as jobsB from "./jobs-b";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { callStructured, AiUnavailableError } from "@/lib/ai/gateway";
import { localDate, atLocal } from "@/lib/util/time";
import type { AiCall } from "./common";
import { dueForResearch, generateDossier, detectRecentSignals } from "./research/service";
import { refreshStrategyForEvent } from "./strategy/service";
import { notify } from "@/modules/brief/db";
import { runPatrol } from "./research/patrol-service";
// Module 13 memory: orchestrator event consumers (reassess memory on new evidence) register on import.
import "./memory/integrate/consumers";

/**
 * Intelligence jobs (service role; every query filters workspace_id explicitly):
 *  - intelligence.patrol    daily evidence conflict & expiry patrol -> evidence_finding (deduped)
 *  - intelligence.research  daily refresh of due watchlist dossiers. Re-runs only on changed evidence or elapsed tier
 *                           interval. Once the AI budget is exhausted, remaining dossiers use the rule synthesis
 *                           (spend cap: non-critical AI research stops, local work continues). Before refreshing, rule-based
 *                           signal detection runs over evidence changed in the last day.
 *  - intelligence.research_org  one company's dossier refresh, enqueued by a DB trigger when a rule-detected signal lands on
 *                           a watchlist company (dedupe key per source evidence item).
 *  - intelligence.strategy  deal-strategist snapshot re-run, enqueued by DB triggers on opportunity stage change, new quote
 *                           (revision) and new objection (dedupe key per event). Suggestion-only: never moves stages.
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
  const detected = await detectRecentSignals(db, workspaceId, new Date(now.getTime() - 86_400_000));
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
  return { ...out, signals_detected: detected.created, ai_stopped: latch.tripped() };
}

/** Refresh one company's dossier after a detected signal (re-runs only because evidence changed; deduped by the trigger). */
export async function runOrgResearch(workspaceId: string, orgId: string, now = new Date(), ai?: AiCall, signalClaimId?: string | null) {
  const db = createAdminClient();
  const { data: watch } = await db.from("watchlist").select("owner_user_id, active").eq("workspace_id", workspaceId).eq("org_id", orgId).maybeSingle();
  if (!watch?.active) return { skipped: "not_watched" };
  const owner = (watch.owner_user_id as string | null) ?? null;
  const r = await generateDossier(db, workspaceId, orgId, { now, ai: ai ?? budgetLatch().ai, userId: owner });
  if (owner && signalClaimId) {
    // in-app only (outbox), deduped per signal; never emailed
    await notify(db, workspaceId, owner, "research.signal", `research.signal:${signalClaimId}`, { org_id: orgId, signal_claim_id: signalClaimId, href: `/research/${orgId}`, text: "New business-signal hypothesis on a watchlist company — dossier refreshed. Verify before acting." });
  }
  return { status: r.status, reason: r.reason, synthesis_status: r.synthesis_status ?? null };
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
  "intelligence.research_org": async (job) => {
    const orgId = String(job.payload?.org_id ?? "");
    if (!job.workspace_id || !orgId) throw new Error("intelligence.research_org requires workspace_id and payload.org_id");
    return runOrgResearch(job.workspace_id, orgId, new Date(), undefined, (job.payload?.signal_claim_id as string | undefined) ?? null);
  },
  "intelligence.strategy": async (job) => {
    const oppId = String(job.payload?.opportunity_id ?? "");
    if (!job.workspace_id || !oppId) throw new Error("intelligence.strategy requires workspace_id and payload.opportunity_id");
    return refreshStrategyForEvent(createAdminClient(), job.workspace_id, oppId);
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
