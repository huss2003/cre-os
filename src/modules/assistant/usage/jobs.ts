import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkThresholds } from "./service";

/**
 * assistant.usage_check — for one workspace (job.workspace_id) or, if null, every active workspace:
 * creates an owner task once per threshold (80%, 100%) per IST month. Re-running is safe (task idempotency_key).
 */
export const handlers: Record<string, JobHandler> = {
  "assistant.usage_check": async (job) => {
    const admin = createAdminClient();
    let ids: string[];
    if (job.workspace_id) ids = [job.workspace_id];
    else {
      const { data } = await admin.from("workspace").select("id").eq("status", "active");
      ids = (data ?? []).map((w) => w.id as string);
    }
    const out: Record<string, unknown> = {};
    for (const id of ids) out[id] = await checkThresholds(id, new Date(), admin);
    return out;
  },
};

/** Hourly sweep (dedupe key per IST hour). */
export async function schedule(now: Date): Promise<void> {
  const hour = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 13);
  await enqueue({ workspaceId: null, type: "assistant.usage_check", dedupeKey: `assistant.usage_check:${hour}` });
}
