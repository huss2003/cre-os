import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { sweep } from "./service";

/**
 * workflows.sweep — every cron tick (5 min) per active workspace, deduped per 5-minute bucket. Starts the signal and
 * lease chains for new triggers and resumes lease runs whose requirement proposal was approved. Never sends anything.
 * Runs with the service role: every query in ./service filters workspace_id explicitly.
 */
export const handlers: Record<string, JobHandler> = {
  "workflows.sweep": async (job) => {
    if (!job.workspace_id) throw new Error("workflows.sweep requires workspace_id");
    return sweep(createAdminClient(), job.workspace_id, { limit: 8, deadlineAt: Date.now() + 20_000 });
  },
};

export async function schedule(now: Date): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.from("workspace").select("id, status").eq("status", "active");
  const bucket = Math.floor(now.getTime() / 300_000);
  for (const ws of data ?? []) {
    await enqueue({ workspaceId: ws.id, type: "workflows.sweep", dedupeKey: `workflows.sweep:${ws.id}:${bucket}`, dueAt: now, maxAttempts: 2 });
  }
}
