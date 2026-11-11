import type { JobHandler } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { processCapture } from "./service";
import { processDocument } from "./docs/service";
import { runInputEngine } from "./input-engine/service";

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
    const r = await processCapture(admin, job.workspace_id, captureId, { reextract: !!job.payload.force });
    try { await runInputEngine(admin, job.workspace_id, captureId); } catch { /* receipt is best effort */ }
    return r;
  },
  /**
   * payload { documentId }. Retry path for the drop zone (the upload already ran it inline). Runs as the uploader
   * (owner_user_id, editor-level actor for proposals); every query filters workspace_id explicitly (S2).
   */
  "capture.document": async (job) => {
    if (!job.workspace_id) throw new Error("capture.document needs a workspace");
    const id = String(job.payload.documentId ?? "");
    const admin = createAdminClient();
    const { data } = await admin.from("capture_document").select("status, owner_user_id").eq("workspace_id", job.workspace_id).eq("id", id).maybeSingle();
    if (!data) return { skipped: "document not found" };
    if (!["received", "processing", "failed"].includes(data.status as string)) return { skipped: data.status };
    const r = await processDocument({ db: admin, workspaceId: job.workspace_id, userId: String(data.owner_user_id), role: "editor", service: true }, id, {}, { admin });
    if (r.status === "failed") throw new Error(String(r.error ?? "document processing failed"));
    return { status: r.status };
  },
};

/** No scheduled capture jobs: processing is event-driven (one job per capture). */
export async function schedule(_now: Date): Promise<void> {}
