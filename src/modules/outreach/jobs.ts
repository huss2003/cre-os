import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { localDate, atLocal } from "@/lib/util/time";
import { sweep } from "./service";

/** outreach.sweep — daily 06:30 local: re-check every open/planned outreach against the pause rules. Never sends. */
export const handlers: Record<string, JobHandler> = {
  "outreach.sweep": async (job) => {
    if (!job.workspace_id) throw new Error("workspace required");
    return sweep(createAdminClient(), job.workspace_id);
  },
};
export async function schedule(now: Date): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.from("workspace").select("id, timezone, status").eq("status", "active");
  for (const ws of data ?? []) {
    const tz = ws.timezone || "Asia/Kolkata";
    const day = localDate(now, tz);
    const at = atLocal(day, "06:30", tz);
    if (now >= at) await enqueue({ workspaceId: ws.id, type: "outreach.sweep", dedupeKey: `outreach.sweep:${ws.id}:${day}`, dueAt: at, maxAttempts: 2 });
  }
}
