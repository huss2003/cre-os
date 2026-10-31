import type { JobHandler } from "@/lib/jobs/queue";

/** Job handlers owned by the "imports" module. Key = job_type (prefix with "imports."). */
export const handlers: Record<string, JobHandler> = {};

/**
 * Called by /api/cron/tick (every ~5 min). Enqueue any jobs that are due at `now`,
 * using dedupe keys like "imports.<job>:<workspace>:<local-date>" so repeated ticks are no-ops.
 */
export async function schedule(_now: Date): Promise<void> {}
