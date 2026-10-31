import type { Job, JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Db } from "@/lib/supabase/server";
import { localDate } from "@/lib/util/time";
import { runClosingAlerts } from "./pipeline/closing-service";

/**
 * Job handlers for the deals "execution" half (documents, closing coordinator, fees/revenue).
 * Owned by the deals-B agent. Composed into src/modules/deals/jobs.ts. job_type prefix: "deals.".
 *
 * deals.closing_alerts — once per workspace per local (IST) day: overdue / blocked closing items → deduped in-app
 * alert (outbox) + task. Service-role client; every query filters workspace_id (S2).
 */
export const CLOSING_ALERTS = "deals.closing_alerts";

export const handlers: Record<string, JobHandler> = {
  [CLOSING_ALERTS]: async (job: Job) => {
    if (!job.workspace_id) throw new Error("deals.closing_alerts needs a workspace");
    const asOf = typeof job.payload?.asOf === "string" ? job.payload.asOf : localDate(new Date());
    return runClosingAlerts(createAdminClient(), job.workspace_id, asOf);
  },
};

export async function schedule(now: Date, admin: Db = createAdminClient()): Promise<{ enqueued: number }> {
  const { data: wss, error } = await admin.from("workspace").select("id, timezone, status").eq("status", "active");
  if (error) throw error;
  let enqueued = 0;
  for (const w of (wss ?? []) as { id: string; timezone: string | null }[]) {
    const day = localDate(now, w.timezone || undefined);
    // enqueue_job ignores a dedupe key that is queued/running/succeeded, so every tick after the first is a no-op
    await enqueue({ workspaceId: w.id, type: CLOSING_ALERTS, payload: { asOf: day }, dedupeKey: `${CLOSING_ALERTS}:${w.id}:${day}`, maxAttempts: 3 });
    enqueued++;
  }
  return { enqueued };
}
