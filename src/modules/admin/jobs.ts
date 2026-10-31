import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { localDate, atLocal } from "@/lib/util/time";
import { exportWorkspace, restoreSampleCheck } from "./backup";
import { purgeWorkspace } from "./retention";

/**
 * Admin jobs (service role; workspace filtered explicitly):
 *  - admin.export          nightly logical export of every workspace table to storage (RPO 24h)
 *  - admin.restore_sample  monthly re-read of the latest export: counts/hashes + restore hazards
 *  - admin.retention_purge nightly purge per APPROVED retention policy (legal hold overrides; audit is report-only)
 * Backups are internal work, so they continue while the AI/ingestion kill switch is on.
 */
export const handlers: Record<string, JobHandler> = {
  "admin.export": async (job) => {
    if (!job.workspace_id) throw new Error("admin.export requires workspace_id");
    const run = await exportWorkspace(createAdminClient(), job.workspace_id, { jobId: job.id });
    return { backup_run_id: run.id, tables: Object.keys(run.table_counts ?? {}).length, bytes: run.bytes };
  },
  "admin.restore_sample": async (job) => {
    if (!job.workspace_id) throw new Error("admin.restore_sample requires workspace_id");
    const run = await restoreSampleCheck(createAdminClient(), job.workspace_id, {
      jobId: job.id, sample: typeof job.payload.sample === "number" ? job.payload.sample : undefined,
    });
    if (run.status === "failed") throw new Error(`restore sample failed: ${run.error}`);
    return { backup_run_id: run.id, status: run.status };
  },
  "admin.retention_purge": async (job) => {
    if (!job.workspace_id) throw new Error("admin.retention_purge requires workspace_id");
    const report = await purgeWorkspace(createAdminClient(), job.workspace_id, { dryRun: job.payload.dryRun === true });
    return report.categories;
  },
};

export const RETENTION_LOCAL_TIME = "02:30";
export const EXPORT_LOCAL_TIME = "01:30";
export const RESTORE_SAMPLE_LOCAL_TIME = "03:00";

/** Enqueue nightly exports and the monthly restore sample. Dedupe keys make repeated ticks no-ops. */
export async function schedule(now: Date): Promise<void> {
  const admin = createAdminClient();
  const { data: list } = await admin.from("workspace").select("id, timezone, status").neq("status", "archived");
  for (const ws of list ?? []) {
    const tz = ws.timezone || "Asia/Kolkata";
    const day = localDate(now, tz);
    const exportAt = atLocal(day, EXPORT_LOCAL_TIME, tz);
    if (now >= exportAt) {
      await enqueue({ workspaceId: ws.id, type: "admin.export", dedupeKey: `admin.export:${ws.id}:${day}`, dueAt: exportAt, maxAttempts: 4 });
    }
    const sampleAt = atLocal(day, RESTORE_SAMPLE_LOCAL_TIME, tz);
    if (now >= sampleAt) {
      await enqueue({ workspaceId: ws.id, type: "admin.restore_sample", dedupeKey: `admin.restore_sample:${ws.id}:${day.slice(0, 7)}`, dueAt: sampleAt, maxAttempts: 3 });
    }
    const purgeAt = atLocal(day, RETENTION_LOCAL_TIME, tz);
    if (now >= purgeAt) {
      await enqueue({ workspaceId: ws.id, type: "admin.retention_purge", dedupeKey: `admin.retention_purge:${ws.id}:${day}`, dueAt: purgeAt, maxAttempts: 3 });
    }
  }
}
