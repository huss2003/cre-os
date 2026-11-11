import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { indexWorkspace } from "./embed";

/**
 * assistant.embed — chunk + embed new/changed sources of one workspace (content_hash dedupe, batched, time-boxed 25 s).
 * payload: { since?: ISO } — only sources updated after it. If the time box is hit, it re-enqueues itself.
 * The lead registers `handlers` in src/lib/jobs/registry.ts.
 */
export const handlers: Record<string, JobHandler> = {
  "assistant.embed": async (job) => {
    if (!job.workspace_id) throw new Error("workspace required");
    const since = typeof job.payload.since === "string" ? job.payload.since : null;
    const st = await indexWorkspace(createAdminClient(), job.workspace_id, { since });
    if (st.timedOut) await enqueueEmbed(job.workspace_id, { since, continuation: true });
    return st;
  },
};

/** Enqueue (deduped per workspace per 5 minutes). Call after an attachment upload or on a schedule. */
export async function enqueueEmbed(workspaceId: string, o: { since?: string | null; continuation?: boolean } = {}) {
  const slot = Math.floor(Date.now() / 300_000);
  return enqueue({ workspaceId, type: "assistant.embed", payload: o.since ? { since: o.since } : {}, dedupeKey: `assistant.embed:${workspaceId}:${slot}${o.continuation ? ":c" : ""}` });
}
