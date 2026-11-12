import type { Job, JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Db } from "@/lib/supabase/server";
import { localDate } from "@/lib/util/time";
import { scanTransactions } from "./events";

/**
 * transactions.scan — once per workspace per local day: offer expiring, issue overdue, possession approaching, handover
 * incomplete → orchestrator events (deduped per subject per day). Service-role client; every query filters workspace_id (S2).
 */
export const TX_SCAN = "transactions.scan";

export const handlers: Record<string, JobHandler> = {
  [TX_SCAN]: async (job: Job) => {
    if (!job.workspace_id) throw new Error("transactions.scan needs a workspace");
    const asOf = typeof job.payload?.asOf === "string" ? job.payload.asOf : localDate(new Date());
    const admin = createAdminClient();
    const events = (await scanTransactions({ db: admin, workspaceId: job.workspace_id }, asOf)).length;
    // Module 15 hand-offs still pending (e.g. tenant was not linked yet) are retried daily; idempotent once delivered.
    const { retryPendingHandoffs } = await import("@/modules/orchestrator/events/tx-lease");
    return { events, handoffsDelivered: await retryPendingHandoffs(admin, job.workspace_id) };
  },
};

export async function schedule(now: Date, admin: Db = createAdminClient()): Promise<{ enqueued: number }> {
  const { data: wss, error } = await admin.from("workspace").select("id, timezone, status").eq("status", "active");
  if (error) throw error;
  let enqueued = 0;
  for (const w of (wss ?? []) as { id: string; timezone: string | null }[]) {
    const day = localDate(now, w.timezone || undefined);
    await enqueue({ workspaceId: w.id, type: TX_SCAN, payload: { asOf: day }, dedupeKey: `${TX_SCAN}:${w.id}:${day}`, maxAttempts: 3 });
    enqueued++;
  }
  return { enqueued };
}
