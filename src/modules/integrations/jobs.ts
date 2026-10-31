import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueue, type JobHandler } from "@/lib/jobs/queue";
import { detectConflictsAndNotify } from "./calendar";
import { CADENCE_MINUTES } from "./config";
import { ensurePush, pushConfigured } from "./push";
import { sequenceTick } from "./sequences";
import { loadAccount, syncResource, type Resource } from "./sync";

/**
 * Job handlers owned by the "integrations" module (job_type prefix "integrations.").
 *  integrations.inbox_sync      {account_id}  every 10 min  — delta sync + triage effects
 *  integrations.calendar_sync   {account_id}  every 15 min  — events, reschedules, cancellations
 *  integrations.sent_reconcile  {account_id}  every 30 min  — Sent Items => reconciled_sent
 *  integrations.sequence_tick   {}            hourly        — next outreach step drafts (never sends)
 *  integrations.push_subscribe  {account_id}  every 6 h     — create/renew Graph subscriptions / Gmail watch (live connectors, when configured)
 *  integrations.calendar_conflicts {}         after calendar sync / manual visit changes — deduped in-app conflict alerts
 * Webhooks (/api/webhooks/microsoft|google) only enqueue inbox_sync / calendar_sync with coalescing dedupe keys.
 * All use the service-role client with explicit workspace filters; sync jobs check the kill switch first.
 */
function syncHandler(resource: Resource): JobHandler {
  return async (job) => {
    const ws = job.workspace_id;
    const accountId = String(job.payload.account_id ?? "");
    if (!ws || !accountId) return { skipped: "missing workspace/account" };
    const admin = createAdminClient();
    const account = await loadAccount(admin, ws, accountId);
    if (!account) return { skipped: "account removed" };
    if (account.status === "revoked" || account.status === "expired") return { skipped: `connector ${account.status}; reconnect required` };
    const res = await syncResource(admin, account, resource);
    if (resource === "calendar" && res.status === "ok") {
      (res as typeof res & { conflictAlerts?: number }).conflictAlerts = (await detectConflictsAndNotify(admin, ws)).length;
    }
    if (res.status === "rate_limited") {
      await enqueue({ workspaceId: ws, type: job.job_type, payload: job.payload, dueAt: new Date(Date.now() + (res.retryAfterSeconds ?? 60) * 1000),
        dedupeKey: `${job.job_type}:${accountId}:retry:${Math.floor(Date.now() / 60_000)}` });
    }
    return res;
  };
}

export const handlers: Record<string, JobHandler> = {
  "integrations.inbox_sync": syncHandler("inbox"),
  "integrations.calendar_sync": syncHandler("calendar"),
  "integrations.sent_reconcile": syncHandler("sent"),
  "integrations.sequence_tick": async (job) => {
    if (!job.workspace_id) return { skipped: "no workspace" };
    return sequenceTick(createAdminClient(), job.workspace_id);
  },
  "integrations.push_subscribe": async (job) => {
    const ws = job.workspace_id;
    const accountId = String(job.payload.account_id ?? "");
    if (!ws || !accountId) return { skipped: "missing workspace/account" };
    const admin = createAdminClient();
    const account = await loadAccount(admin, ws, accountId);
    if (!account) return { skipped: "account removed" };
    return ensurePush(admin, account);
  },
  "integrations.calendar_conflicts": async (job) => {
    if (!job.workspace_id) return { skipped: "no workspace" };
    return { alerts: (await detectConflictsAndNotify(createAdminClient(), job.workspace_id)).length };
  },
};

const bucket = (now: Date, minutes: number) => Math.floor(now.getTime() / (minutes * 60_000));

/** Called by /api/cron/tick: enqueue due syncs per live connector with time-bucket dedupe keys (repeat ticks = no-op). */
export async function schedule(now: Date): Promise<void> {
  const admin = createAdminClient();
  const { data: accounts } = await admin.from("connector_account").select("id, workspace_id, status").in("status", ["connected", "mock", "error"]);
  for (const a of accounts ?? []) {
    const jobs: [string, number][] = [["integrations.inbox_sync", CADENCE_MINUTES.inbox], ["integrations.calendar_sync", CADENCE_MINUTES.calendar], ["integrations.sent_reconcile", CADENCE_MINUTES.sent]];
    for (const [type, every] of jobs) {
      await enqueue({ workspaceId: a.workspace_id, type, payload: { account_id: a.id }, dedupeKey: `${type}:${a.id}:${bucket(now, every)}`, maxAttempts: 3 });
    }
  }
  const { data: live } = await admin.from("connector_account").select("id, workspace_id, provider").eq("status", "connected");
  for (const a of live ?? []) {
    if (!pushConfigured(a.provider)) continue;
    await enqueue({ workspaceId: a.workspace_id, type: "integrations.push_subscribe", payload: { account_id: a.id }, dedupeKey: `integrations.push_subscribe:${a.id}:${bucket(now, 360)}`, maxAttempts: 3 });
  }
  const workspaces = [...new Set((accounts ?? []).map((a) => a.workspace_id as string))];
  const { data: enr } = await admin.from("sequence_enrollment").select("workspace_id").eq("status", "active").lte("next_due_at", now.toISOString()).limit(500);
  for (const ws of new Set([...(enr ?? []).map((e) => e.workspace_id as string), ...workspaces])) {
    await enqueue({ workspaceId: ws, type: "integrations.sequence_tick", dedupeKey: `integrations.sequence_tick:${ws}:${bucket(now, CADENCE_MINUTES.sequences)}` });
  }
}
