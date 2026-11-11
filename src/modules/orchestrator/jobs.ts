import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import "./reassess/workflows";
import { processEvents } from "./events/process";
import { advanceExecution, runnableExecutions, timeoutExecutions } from "./engine/runner";
import { startDueScheduled } from "./engine/controls";
import type { Db } from "@/lib/supabase/server";
import { dispatchOrder } from "./automation/rules";
import { isAutomationPaused, notifyDelayed, notifyFailures, trackRouted } from "./automation/service";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * orchestrator.dispatch — every tick per active workspace (dedupe per 5-minute bucket). Service-role client; every
 * query filters workspace_id (S2). Order: events → due recurring workflows (paused ones skipped) → runnable
 * executions (queued / retry backoff elapsed, highest priority first) → timeouts. Time-boxed.
 */
export async function dispatch(ws: string, now = new Date(), deadlineAt = Date.now() + 20_000, db: Db = createAdminClient()) {
  // Global pause (§2.13): events stay pending, no scheduled starts, only user-started runs advance. States are kept,
  // so on resume everything continues from where it stopped (dedupe keys unchanged ⇒ no duplicates).
  const paused = await isAutomationPaused(db, ws);
  const events = paused ? null : await processEvents(db, ws, { limit: 25 });
  const scheduled = paused ? [] : await startDueScheduled(db, ws, now);
  const ids = await runnableExecutions(db, ws, now, 200);
  const { data: meta } = ids.length ? await db.from("workflow_run").select("id, priority, trigger_type, started_at").eq("workspace_id", ws).in("id", ids) : { data: [] as Row[] };
  const eligible = ((meta ?? []) as Row[]).filter((r) => !paused || r.trigger_type === "user");
  // Rule 9 / §2.7: urgent client work first; routine background runs wait while urgent work is queued.
  const order = dispatchOrder(eligible, 20);
  const advanced: string[] = [];
  for (const r of order.run) {
    if (Date.now() > deadlineAt) break;
    await advanceExecution(db, ws, r.id, { now });
    advanced.push(r.id);
  }
  const timedOut = await timeoutExecutions(db, ws, now);
  const routed = await trackRouted(db, ws, now).catch(() => null);
  const delayed = await notifyDelayed(db, ws, now).catch(() => null);
  const failures = await notifyFailures(db, ws, now).catch(() => null);
  return { paused, events, scheduled: scheduled.length, advanced: advanced.length, held: order.held.length + (ids.length - eligible.length), timedOut, routed, delayed, failures };
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
