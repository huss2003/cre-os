import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { assistantRunHandler } from "./engine/job";
import { runAssistant, serviceContext } from "./engine/run";
import { fillPrompt, type CommandRow } from "./commands/service";
import { scheduleCommands, advanceSchedule } from "./commands/schedule";
import * as usageJobs from "./usage/jobs";
import * as briefJobs from "./briefs/jobs";
import * as docJobs from "./documents/jobs";
import { outputHandlers, scheduleOutputs } from "./outputs/jobs";

/**
 * assistant.run     — background assistant run (engine).
 * assistant.command — one due scheduled command; re-checks opt-in, runs as the command's owner, advances next_run_at.
 * Memory staleness is computed at read time (isStale), so no sweep job is needed.
 */
export const handlers: Record<string, JobHandler> = {
  ...usageJobs.handlers, ...briefJobs.handlers, ...docJobs.handlers, ...outputHandlers,
  "assistant.run": assistantRunHandler,
  "assistant.command": async (job) => {
    if (!job.workspace_id) throw new Error("workspace required");
    const admin = createAdminClient();
    const id = String(job.payload.commandId ?? "");
    const { data } = await admin.from("assistant_command").select("*").eq("workspace_id", job.workspace_id).eq("id", id).is("archived_at", null).maybeSingle();
    const c = data as CommandRow | null;
    if (!c || !c.schedule_enabled || !c.schedule_authorised_at || !c.owner_user_id) return { skipped: "not scheduled or not authorised" };
    const now = new Date();
    const { prompt, missing } = fillPrompt(c);
    if (missing.length) { await advanceSchedule(admin, job.workspace_id, c, now, undefined, false); return { skipped: `missing inputs: ${missing.join(", ")}` }; }
    const ctx = serviceContext(job.workspace_id, c.owner_user_id);
    const r = await runAssistant({ ctx, request: prompt, commandId: c.id, idempotencyKey: `cmd:${c.id}:${String(job.payload.scheduledFor ?? c.next_run_at)}` });
    await advanceSchedule(admin, job.workspace_id, c, now);
    return r;
  },
};

export async function schedule(now: Date): Promise<void> {
  const run = (f: () => Promise<unknown>) => f().catch((e) => console.error("assistant schedule", e));
  await run(() => scheduleCommands(createAdminClient(), now, (o) => enqueue(o)));
  await run(() => usageJobs.schedule(now));
  await run(() => briefJobs.schedule(now));
  await run(() => scheduleOutputs(now));
}
