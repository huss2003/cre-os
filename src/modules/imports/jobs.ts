import "server-only";
import { enqueue, type JobHandler } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { processBatch } from "./pipeline";

/**
 * Job handlers owned by the "imports" module.
 *  - imports.process {batch_id}: process a registered batch (service role; every query filters workspace_id).
 *    The upload route also processes inline; the status claim in processBatch makes the two mutually exclusive.
 */
export const handlers: Record<string, JobHandler> = {
  "imports.process": async (job) => {
    if (!job.workspace_id) throw new Error("imports.process requires a workspace");
    const batchId = String(job.payload.batch_id ?? "");
    if (!batchId) throw new Error("imports.process requires payload.batch_id");
    const allowFrom = Array.isArray(job.payload.allow_from) ? (job.payload.allow_from as string[]) : ["registered"];
    const res = await processBatch(createAdminClient(), { workspaceId: job.workspace_id, batchId, allowFrom });
    if (res.status === "failed") throw new Error(res.error ?? "import failed");
    return { status: res.status, batch_id: batchId, reconciles: res.counts?.reconciles ?? null };
  },
};

export async function enqueueProcess(workspaceId: string, batchId: string, attempt: string | number, allowFrom: string[] = ["registered"]) {
  return enqueue({
    workspaceId, type: "imports.process", payload: { batch_id: batchId, allow_from: allowFrom },
    dedupeKey: `imports.process:${batchId}:${attempt}`, maxAttempts: 3,
  });
}

/**
 * Called by /api/cron/tick. Picks up batches that were registered but never processed (e.g. the inline run was
 * interrupted) once they are older than 10 minutes. Dedupe per batch per hour keeps repeated ticks a no-op.
 */
export async function schedule(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - 10 * 60_000).toISOString();
  const { data } = await createAdminClient().from("import_batch").select("id, workspace_id")
    .eq("status", "registered").lt("created_at", cutoff).limit(20);
  const hour = now.toISOString().slice(0, 13);
  for (const b of (data ?? []) as { id: string; workspace_id: string }[]) {
    await enqueueProcess(b.workspace_id, b.id, `sweep:${hour}`);
  }
}
