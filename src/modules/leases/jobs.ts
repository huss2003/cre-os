import "server-only";
/**
 * leases module jobs (job_type prefix "leases."). Service-role client: every query filters workspace_id (S2).
 *  leases.daily — per workspace, 06:30 local: resync reminders from confirmed dates, deliver due reminders via the
 *                 orchestrator notify service, publish potential lease opportunities (events, deduped).
 * Registration: add `import * as leases from "@/modules/leases/jobs"` to src/lib/jobs/registry.ts (shared file).
 */
import type { Job, JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { atLocal, localDate } from "@/lib/util/time";
import { dispatchDueReminders, scanOpportunities, syncReminders } from "./service";

export async function runDaily(workspaceId: string, today: string, admin = createAdminClient()) {
  const { data: ws } = await admin.from("workspace").select("id").eq("id", workspaceId).maybeSingle();
  if (!ws) return { skipped: true };
  const { data: owner } = await admin.from("membership").select("user_id").eq("workspace_id", workspaceId).eq("role", "owner").limit(1).maybeSingle();
  const userId = owner?.user_id as string | undefined;
  const { data: leases } = await admin.from("lease").select("id").eq("workspace_id", workspaceId).is("archived_at", null).neq("lifecycle_status", "closed").limit(5000);
  let created = 0, cancelled = 0;
  if (userId) for (const l of leases ?? []) { const r = await syncReminders({ db: admin, ws: workspaceId, userId }, l.id, today); created += r.created; cancelled += r.cancelled; }
  const d = await dispatchDueReminders(admin, workspaceId, today);
  const opps = userId ? await scanOpportunities({ db: admin, ws: workspaceId, userId }, today) : [];
  return { created, cancelled, sent: d.sent, opportunities: opps.length };
}

export const handlers: Record<string, JobHandler> = {
  "leases.daily": async (job: Job) => runDaily(job.workspace_id ?? "", String((job.payload as { day?: string })?.day ?? localDate())),
};

export async function schedule(now: Date): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.from("workspace").select("id, timezone, status").eq("status", "active");
  for (const ws of data ?? []) {
    const tz = ws.timezone || "Asia/Kolkata";
    const day = localDate(now, tz);
    const at = atLocal(day, "06:30", tz);
    if (now >= at) await enqueue({ workspaceId: ws.id, type: "leases.daily", payload: { day }, dedupeKey: `leases.daily:${ws.id}:${day}`, dueAt: at, maxAttempts: 3 });
  }
}
