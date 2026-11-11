import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import "./reassess/workflows";
import { processEvents } from "./events/process";
import { advanceExecution, runnableExecutions, timeoutExecutions } from "./engine/runner";
import { startDueScheduled } from "./engine/controls";

/**
 * orchestrator.dispatch — every tick per active workspace (dedupe per 5-minute bucket). Service-role client; every
 * query filters workspace_id (S2). Order: events → due recurring workflows (paused ones skipped) → runnable
 * executions (queued / retry backoff elapsed, highest priority first) → timeouts. Time-boxed.
 */
export async function dispatch(ws: string, now = new Date(), deadlineAt = Date.now() + 20_000) {
  const db = createAdminClient();
  const events = await processEvents(db, ws, { limit: 25 });
  const scheduled = await startDueScheduled(db, ws, now);
  const advanced: string[] = [];
  for (const id of await runnableExecutions(db, ws, now, 20)) {
    if (Date.now() > deadlineAt) break;
    await advanceExecution(db, ws, id, { now });
    advanced.push(id);
  }
  const timedOut = await timeoutExecutions(db, ws, now);
  return { events, scheduled: scheduled.length, advanced: advanced.length, timedOut };
}

export const handlers: Record<string, JobHandler> = {
  "orchestrator.dispatch": async (job) => {
    if (!job.workspace_id) throw new Error("orchestrator.dispatch requires workspace_id");
    return dispatch(job.workspace_id, new Date(), Date.now() + 20_000);
  },
};

export async function schedule(now: Date): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.from("workspace").select("id").eq("status", "active");
  const bucket = Math.floor(now.getTime() / 300_000);
  for (const ws of data ?? []) {
    await enqueue({ workspaceId: ws.id, type: "orchestrator.dispatch", dedupeKey: `orchestrator.dispatch:${ws.id}:${bucket}`, dueAt: now, maxAttempts: 2 });
  }
}
