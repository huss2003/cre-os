import "server-only";
import type { JobHandler } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import * as execution from "./jobs-b";
import { refreshRequirementTasks, rematchRequirement } from "./matching/rematch";
import { computeConcessionNpv } from "./finance/concession-npv";

/**
 * Job handlers owned by the "deals" module. Key = job_type (prefix with "deals.").
 * This file belongs to the deals-A half (requirements, matching, finance); the deals-B half
 * (documents, closing, fees) registers in ./jobs-b.ts and is merged here.
 *
 * deals-A jobs are enqueued by SQL triggers (migration 20261101000400_deals_a_round2.sql), never by the scheduler:
 * - deals.rematch   {requirement_id, reason} — re-run match-v1 after availability/space/asset/requirement changes
 *                    (at most one queued job per requirement; service role, explicit workspace filters).
 * - deals.req_tasks {requirement_id}         — refresh follow-up tasks after an approved change proposal was applied.
 * - deals.concession_npv {step_id}           — fill concession_step.npv_equivalent / engine_version (null when unknown).
 */
const need = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`${what} missing in job payload`);
  return v;
};

const ownHandlers: Record<string, JobHandler> = {
  "deals.rematch": async (job) =>
    rematchRequirement(createAdminClient() as never, need(job.workspace_id, "workspace_id"), need(job.payload.requirement_id, "requirement_id"), String(job.payload.reason ?? "inventory changed")),
  "deals.req_tasks": async (job) =>
    refreshRequirementTasks(createAdminClient() as never, need(job.workspace_id, "workspace_id"), need(job.payload.requirement_id, "requirement_id")),
  "deals.concession_npv": async (job) =>
    computeConcessionNpv(createAdminClient() as never, need(job.workspace_id, "workspace_id"), need(job.payload.step_id, "step_id")),
};

export const handlers: Record<string, JobHandler> = { ...ownHandlers, ...execution.handlers };

/**
 * Called by /api/cron/tick (every ~5 min). Enqueue any jobs that are due at `now`,
 * using dedupe keys like "deals.<job>:<workspace>:<local-date>" so repeated ticks are no-ops.
 */
export async function schedule(now: Date): Promise<void> {
  await execution.schedule(now);
}
