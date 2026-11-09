import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { localDate, atLocal } from "@/lib/util/time";
import { reverifyDue } from "./service";

/** contacts.reverify — weekly (Sunday 03:00 local): contacts past next_review_on get channels re-checked (no web, no cost). */
export const handlers: Record<string, JobHandler> = {
  "contacts.reverify": async (job) => {
    if (!job.workspace_id) throw new Error("workspace required");
    return reverifyDue(createAdminClient(), job.workspace_id);
  },
};
export async function schedule(now: Date): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.from("workspace").select("id, timezone, status").eq("status", "active");
  for (const ws of data ?? []) {
    const tz = ws.timezone || "Asia/Kolkata";
    const day = localDate(now, tz);
    const at = atLocal(day, "03:00", tz);
    if (new Date(`${day}T12:00:00Z`).getUTCDay() === 0 && now >= at) await enqueue({ workspaceId: ws.id, type: "contacts.reverify", dedupeKey: `contacts.reverify:${ws.id}:${day}`, dueAt: at, maxAttempts: 2 });
  }
}
