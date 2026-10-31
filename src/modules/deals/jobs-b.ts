import type { JobHandler } from "@/lib/jobs/queue";

/**
 * Job handlers for the deals "execution" half (documents, closing coordinator, fees/revenue).
 * Owned by the deals-B agent. Composed into src/modules/deals/jobs.ts. job_type prefix: "deals.".
 */
export const handlers: Record<string, JobHandler> = {};

export async function schedule(_now: Date): Promise<void> {}
