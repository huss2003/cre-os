import "server-only";
import type { Job } from "@/lib/jobs/queue";
import type { EntityRef } from "../types";
import { runAssistant, serviceContext } from "./run";

/**
 * job_type `assistant.run`: continues a chat run that would have exceeded the HTTP time budget.
 * Payload { runId, userId, request, focus, attachmentIds }. Category B tools dedupe on (runId, tool, input), so
 * re-executing the loop never duplicates writes; category C still only creates approvals.
 */
export async function assistantRunHandler(job: Job) {
  const p = job.payload as { runId: string; userId: string; request: string; focus?: EntityRef | null; attachmentIds?: string[] };
  if (!job.workspace_id || !p.runId || !p.userId) throw new Error("assistant.run: missing workspace/run/user");
  const ctx = serviceContext(job.workspace_id, p.userId);
  const r = await runAssistant({ ctx, request: p.request, focus: p.focus ?? null, attachmentIds: p.attachmentIds ?? [], resumeRunId: p.runId });
  return { status: r.status, messageId: r.messageId };
}
