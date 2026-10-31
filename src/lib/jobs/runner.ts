import "server-only";
import { claim, complete, fail } from "./queue";
import { handlers, schedulers } from "./registry";

/** Run schedulers, then drain due jobs until the time budget is used. Safe to call concurrently (SKIP LOCKED). */
export async function tick(opts: { budgetMs?: number; worker?: string } = {}) {
  const started = Date.now();
  const budget = opts.budgetMs ?? 45_000;
  const worker = opts.worker ?? `w-${crypto.randomUUID().slice(0, 8)}`;
  const scheduleErrors: string[] = [];
  for (const s of schedulers) {
    try {
      await s(new Date());
    } catch (e) {
      scheduleErrors.push(String(e));
    }
  }
  let ran = 0, failed = 0;
  while (Date.now() - started < budget) {
    // One job per claim so the time budget is checked before every job; unclaimed work waits for the next tick.
    const jobs = await claim(worker, 1);
    if (jobs.length === 0) break;
    for (const job of jobs) {
      const h = handlers[job.job_type];
      try {
        if (!h) throw new Error(`no handler for job_type ${job.job_type}`);
        const result = await h(job);
        await complete(job.id, result);
        ran++;
      } catch (e) {
        await fail(job.id, e);
        failed++;
      }
    }
  }
  return { ran, failed, scheduleErrors, ms: Date.now() - started };
}
