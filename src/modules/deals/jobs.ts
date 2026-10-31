import type { JobHandler } from "@/lib/jobs/queue";
import * as execution from "./jobs-b";

/**
 * Job handlers owned by the "deals" module. Key = job_type (prefix with "deals.").
 * This file belongs to the deals-A half (requirements, matching, finance); the deals-B half
 * (documents, closing, fees) registers in ./jobs-b.ts and is merged here.
 */
const ownHandlers: Record<string, JobHandler> = {};

export const handlers: Record<string, JobHandler> = { ...ownHandlers, ...execution.handlers };

/**
 * Called by /api/cron/tick (every ~5 min). Enqueue any jobs that are due at `now`,
 * using dedupe keys like "deals.<job>:<workspace>:<local-date>" so repeated ticks are no-ops.
 */
export async function schedule(now: Date): Promise<void> {
  await execution.schedule(now);
}
