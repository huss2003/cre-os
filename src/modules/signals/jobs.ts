import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { localDate, atLocal } from "@/lib/util/time";
import { scanWorkspace } from "./service";
import { researchDue, discoverMarket } from "./research";
import { dueCompanies, refreshCompany } from "./refresh";

/**
 * signals.scan — daily per workspace (06:00 local). Incremental: claims changed in the last 2 days + all lease events in
 * their windows. Dedupe key per workspace per day; retries cannot duplicate signals (dedupe_key unique) or tasks.
 * Manual "Scan now" enqueues the same job type with a full=true payload.
 */
export const SCAN_LOCAL_TIME = "06:00";
export const handlers: Record<string, JobHandler> = {
  "signals.scan": async (job) => {
    if (!job.workspace_id) throw new Error("signals.scan requires workspace_id");
    const since = job.payload.full ? undefined : new Date(Date.now() - 2 * 86_400_000).toISOString();
    const admin = createAdminClient();
    const res = await scanWorkspace(admin, job.workspace_id, { since });
    await admin.from("research_source_registry").update({ last_sync_at: new Date().toISOString(), last_sync_status: "ok", last_error: null })
      .eq("workspace_id", job.workspace_id).eq("paused", false).eq("acquisition_method", "manual_paste");
    return res;
  },
};

handlers["signals.research"] = async (job) => {
  if (!job.workspace_id) throw new Error("signals.research requires workspace_id");
  return researchDue(createAdminClient(), job.workspace_id);
};

handlers["signals.discover"] = async (job) => {
  if (!job.workspace_id) throw new Error("signals.discover requires workspace_id");
  return discoverMarket(createAdminClient(), job.workspace_id);
};

/** Daily planner: due companies inside the bounded universe → one refresh job each (dedupe per company per day). */
handlers["signals.refresh_plan"] = async (job) => {
  if (!job.workspace_id) throw new Error("signals.refresh_plan requires workspace_id");
  const admin = createAdminClient();
  const day = String(job.payload.day ?? new Date().toISOString().slice(0, 10));
  const { due, universe, cap } = await dueCompanies(admin as never, job.workspace_id);
  for (const w of due) await enqueue({ workspaceId: job.workspace_id, type: "signals.refresh_company", payload: { orgId: w.org_id, trigger: "scheduled", slot: day }, dedupeKey: `signals.refresh:${job.workspace_id}:${w.org_id}:${day}`, maxAttempts: 3 });
  return { due: due.length, universe: universe.length, cap };
};

/** One company refresh (scheduled, event-triggered or retried). Sync-run dedupe key makes a retried job a no-op. */
handlers["signals.refresh_company"] = async (job) => {
  if (!job.workspace_id) throw new Error("signals.refresh_company requires workspace_id");
  const orgId = String(job.payload.orgId ?? "");
  if (!orgId) throw new Error("signals.refresh_company requires orgId");
  const trigger = (job.payload.trigger as "scheduled" | "event" | undefined) ?? "scheduled";
  return refreshCompany(createAdminClient() as never, job.workspace_id, orgId, { trigger, dedupeKey: job.dedupe_key ?? `job:${job.id}` });
};

/** Event-triggered refresh (newly detected material event): at most one per company per day. */
export async function triggerEventRefresh(workspaceId: string, orgId: string, day = new Date().toISOString().slice(0, 10)) {
  return enqueue({ workspaceId, type: "signals.refresh_company", payload: { orgId, trigger: "event", slot: day }, dedupeKey: `signals.refresh:${workspaceId}:${orgId}:${day}`, maxAttempts: 3 });
}

export async function schedule(now: Date): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.from("workspace").select("id, timezone, status").eq("status", "active");
  for (const ws of data ?? []) {
    const tz = ws.timezone || "Asia/Kolkata";
    const day = localDate(now, tz);
    const at = atLocal(day, SCAN_LOCAL_TIME, tz);
    const rAt = atLocal(day, "05:30", tz);
    if (now >= rAt) await enqueue({ workspaceId: ws.id, type: "signals.research", dedupeKey: `signals.research:${ws.id}:${day}`, dueAt: rAt, maxAttempts: 2 });
    // Market discovery once a week (Monday 05:15 local).
    const dAt = atLocal(day, "05:15", tz);
    if (new Date(`${day}T12:00:00Z`).getUTCDay() === 1 && now >= dAt) await enqueue({ workspaceId: ws.id, type: "signals.discover", dedupeKey: `signals.discover:${ws.id}:${day}`, dueAt: dAt, maxAttempts: 2 });
    if (now >= at) await enqueue({ workspaceId: ws.id, type: "signals.scan", dedupeKey: `signals.scan:${ws.id}:${day}`, dueAt: at, maxAttempts: 3 });
    const pAt = atLocal(day, "06:15", tz);
    if (now >= pAt) await enqueue({ workspaceId: ws.id, type: "signals.refresh_plan", payload: { day }, dedupeKey: `signals.refresh_plan:${ws.id}:${day}`, dueAt: pAt, maxAttempts: 2 });
  }
}
