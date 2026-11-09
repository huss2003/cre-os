import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { localDate, atLocal } from "@/lib/util/time";
import { scanWorkspace } from "./service";
import { researchDue } from "./research";

/**
 * signals.scan — daily per workspace (06:00 local). Incremental: claims changed in the last 2 days + all lease events in
 * their windows. Dedupe key per workspace per day; retries cannot duplicate signals (dedupe_key unique) or tasks.
 * Manual "Scan now" enqueues the same job type with a full=true payload.
 */
export const SCAN_LOCAL_TIME = "06:00";
export const handlers: Record<string, JobHandler> = {
  "signals.scan": async (job) => {
    if (!job.workspace_id) throw new Error("signals.scan requires workspace_id");
    const since = job.payload.full ? undefined : new Date(Date.now() - 2 * 86_400_000).toISOString();
    const admin = createAdminClient();
    const res = await scanWorkspace(admin, job.workspace_id, { since });
    await admin.from("research_source_registry").update({ last_sync_at: new Date().toISOString(), last_sync_status: "ok", last_error: null })
      .eq("workspace_id", job.workspace_id).eq("paused", false).eq("acquisition_method", "manual_paste");
    return res;
  },
};

handlers["signals.research"] = async (job) => {
  if (!job.workspace_id) throw new Error("signals.research requires workspace_id");
  return researchDue(createAdminClient(), job.workspace_id);
};

export async function schedule(now: Date): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.from("workspace").select("id, timezone, status").eq("status", "active");
  for (const ws of data ?? []) {
    const tz = ws.timezone || "Asia/Kolkata";
    const day = localDate(now, tz);
    const at = atLocal(day, SCAN_LOCAL_TIME, tz);
    const rAt = atLocal(day, "05:30", tz);
    if (now >= rAt) await enqueue({ workspaceId: ws.id, type: "signals.research", dedupeKey: `signals.research:${ws.id}:${day}`, dueAt: rAt, maxAttempts: 2 });
    if (now >= at) await enqueue({ workspaceId: ws.id, type: "signals.scan", dedupeKey: `signals.scan:${ws.id}:${day}`, dueAt: at, maxAttempts: 3 });
  }
}
