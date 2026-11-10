import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { remind, syncFromCalendar } from "./service";
import { autoBriefs } from "./more";

/** meetings.autobrief (every tick, 15-min dedupe): brief ~1h before. meetings.remind (hourly): prep reminders as tasks. meetings.calendar (hourly): preps for newly synced calendar events. */
export const handlers: Record<string, JobHandler> = {
  "meetings.remind": async (job) => { if (!job.workspace_id) throw new Error("workspace required"); return remind(createAdminClient(), job.workspace_id); },
  "meetings.autobrief": async (job) => { if (!job.workspace_id) throw new Error("workspace required"); return autoBriefs(createAdminClient(), job.workspace_id); },
  "meetings.calendar": async (job) => { if (!job.workspace_id) throw new Error("workspace required"); return syncFromCalendar(createAdminClient(), job.workspace_id, null); },
};
export async function schedule(now: Date): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.from("workspace").select("id, status").eq("status", "active");
  const hour = now.toISOString().slice(0, 13);
  const quarter = `${hour}:${String(Math.floor(now.getUTCMinutes() / 15) * 15).padStart(2, "0")}`;
  for (const ws of data ?? []) {
    await enqueue({ workspaceId: ws.id, type: "meetings.remind", dedupeKey: `meetings.remind:${ws.id}:${hour}`, dueAt: now, maxAttempts: 2 });
    await enqueue({ workspaceId: ws.id, type: "meetings.autobrief", dedupeKey: `meetings.autobrief:${ws.id}:${quarter}`, dueAt: now, maxAttempts: 1 });
    await enqueue({ workspaceId: ws.id, type: "meetings.calendar", dedupeKey: `meetings.calendar:${ws.id}:${hour}`, dueAt: now, maxAttempts: 2 });
  }
}
