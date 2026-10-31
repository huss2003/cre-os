import type { JobHandler } from "@/lib/jobs/queue";

/**
 * Job handlers for the intelligence "publishing" half (legal desk, market analyst, content editor).
 * Owned by the intel-B agent. Merged into src/modules/intelligence/jobs.ts. job_type prefix: "intelligence.".
 */
export const handlers: Record<string, JobHandler> = {};

export async function schedule(_now: Date): Promise<void> {}
