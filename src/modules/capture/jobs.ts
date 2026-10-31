import type { JobHandler } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { processCapture } from "./service";

/** Job handlers owned by the "capture" module. Key = job_type (prefix with "capture."). */
export const handlers: Record<string, JobHandler> = {
  /** payload { captureId, force? }. Idempotent: re-running never duplicates interactions/tasks/proposals/drafts. */
  "capture.process": async (job) => {
    if (!job.workspace_id) throw new Error("capture.process needs a workspace");
    const captureId = String(job.payload.captureId ?? "");
    const admin = createAdminClient();
    const { data } = await admin.from("capture").select("status").eq("workspace_id", job.workspace_id).eq("id", captureId).maybeSingle();
    if (!data) return { skipped: "capture not found" };
    // the API may already have processed it inline; only a forced run re-extracts
    if (!job.payload.force && ["needs_review", "reviewed"].includes(data.status as string)) return { skipped: data.status };
    return processCapture(admin, job.workspace_id, captureId, { reextract: !!job.payload.force });
  },
};

/** No scheduled capture jobs: processing is event-driven (one job per capture). */
export async function schedule(_now: Date): Promise<void> {}
