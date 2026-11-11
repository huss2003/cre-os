import "server-only";
import { createAdminClient, adminApp } from "@/lib/supabase/admin";
import { runSupervisor, type SupervisorSummary } from "@/modules/admin/supervisor";
import { claim, complete, fail } from "./queue";
import { handlers, schedulers } from "./registry";

const SUPERVISOR_TIMEOUT_MS = 10_000;
/** Jobs run per batch. Each job is short (≈1–3 s); 8 clears backlogs quickly; DB load stays modest (each job is a few small queries). */
const JOB_CONCURRENCY = Number(process.env.JOB_CONCURRENCY ?? 8);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(t));
}

const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

/**
 * One scheduler tick: record a heartbeat row (scheduler_run), run module schedulers, run the System Supervisor
 * (alerts, incl. "the previous tick was > 15 min ago"), then drain due jobs until the time budget is used.
 * Safe to call concurrently (SKIP LOCKED). Paused workspaces / a platform-wide pause are skipped inside claim_jobs.
 */
export async function tick(opts: { budgetMs?: number; worker?: string; source?: string } = {}) {
  const started = Date.now();
  const budget = opts.budgetMs ?? 45_000;
  const worker = opts.worker ?? `w-${crypto.randomUUID().slice(0, 8)}`;
  const scheduleErrors: string[] = [];

  let runId: number | null = null;
  let heartbeat: { gapMinutes: number | null; prevStartedAt: string | null } | undefined;
  try {
    const { data, error } = await adminApp().rpc("begin_scheduler_run", { p_worker: worker, p_source: opts.source ?? null });
    if (error) throw error;
    const r = data as { id: number; gap_minutes: number | null; prev_started_at: string | null };
    runId = r.id;
    heartbeat = { gapMinutes: r.gap_minutes === null ? null : Number(r.gap_minutes), prevStartedAt: r.prev_started_at };
  } catch (e) {
    scheduleErrors.push(`heartbeat: ${errText(e)}`);
  }

  // Module schedulers only enqueue (dedupe-keyed) work, so they run in parallel: ~8 s worst case instead of 8 s × modules.
  const now = new Date();
  const results = await Promise.allSettled(schedulers.map((s) => withTimeout(s(now), 8_000, "scheduler")));
  for (const r of results) if (r.status === "rejected") scheduleErrors.push(errText(r.reason));

  let supervisor: SupervisorSummary | null = null;
  try {
    supervisor = await withTimeout(runSupervisor(createAdminClient(), { now: new Date(), heartbeat }), SUPERVISOR_TIMEOUT_MS, "supervisor");
    scheduleErrors.push(...supervisor.checkErrors.slice(0, 10).map((e) => `supervisor check ${e}`));
  } catch (e) {
    scheduleErrors.push(`supervisor: ${errText(e)}`);
  }

  let ran = 0, failed = 0;
  try {
    // Leave headroom: a job started late could overrun the 60 s platform limit (the cause of the live timeouts).
    while (Date.now() - started < budget - 15_000) {
      // Small batches run concurrently (SKIP LOCKED claim); the time budget is re-checked before every batch,
      // and unclaimed work waits for the next tick.
      const jobs = await claim(worker, JOB_CONCURRENCY);
      if (jobs.length === 0) break;
      await Promise.all(jobs.map(async (job) => {
        const h = handlers[job.job_type];
        try {
          if (!h) throw new Error(`no handler for job_type ${job.job_type}`);
          const remaining = Math.max(5_000, budget - (Date.now() - started));
          const result = await withTimeout(h(job), remaining, `job ${job.job_type}`);
          await complete(job.id, result);
          ran++;
        } catch (e) {
          await fail(job.id, e);
          failed++;
        }
      }));
    }
  } catch (e) {
    scheduleErrors.push(`queue: ${errText(e)}`);
  }

  const ms = Date.now() - started;
  if (runId !== null) {
    await createAdminClient().from("scheduler_run").update({
      finished_at: new Date().toISOString(), ms, ran, failed,
      schedule_errors: scheduleErrors.slice(0, 20).map((s) => s.slice(0, 500)),
      supervisor: supervisor ? { workspaces: supervisor.workspaces, opened: supervisor.opened, notifications: supervisor.notifications, check_errors: supervisor.checkErrors.length } : null,
    }).eq("id", runId).then(undefined, () => undefined);
  }
  return { ran, failed, scheduleErrors, ms, heartbeat: heartbeat ?? null, supervisor };
}
