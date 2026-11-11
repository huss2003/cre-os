import "server-only";
/**
 * Automation controls + monitoring (spec §2.4, §2.7–2.9, §2.11–2.13; UI A, C, D, E, F).
 *  - Global pause/resume (mudar.automation_control): non-critical background jobs are deferred (never dropped), the
 *    dispatcher stops starting scheduled / event-driven runs, user-started work and critical jobs keep running.
 *    Resume brings deferred jobs and paused-out runs forward without creating duplicates (dedupe keys unchanged).
 *  - Routed-work tracking: whether the receiving module actually completed the work an event was routed to.
 *  - Delayed-process notifications, background job list, workflow history, alerts and per-category budget usage.
 */
import type { Db } from "@/lib/supabase/server";
import type { Job } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { audit } from "../engine/audit";
import { notifyAdmins } from "../notify/service";
import { budgetStates } from "../budget/service";
import { periodWindow, workflowResource } from "../budget/rules";
import { delayReason, DELAY, isDelayedJob, moduleOfJob, routedStatus } from "./rules";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface AutomationState { paused: boolean; pausedAt: string | null; pausedBy: string | null; reason: string | null; resumedAt: string | null }

export async function getAutomationState(db: Db, ws: string): Promise<AutomationState> {
  const { data } = await db.from("automation_control").select("*").eq("workspace_id", ws).maybeSingle();
  return { paused: !!data?.paused, pausedAt: data?.paused_at ?? null, pausedBy: data?.paused_by ?? null, reason: data?.reason ?? null, resumedAt: data?.resumed_at ?? null };
}
export async function isAutomationPaused(db: Db, ws: string) { return (await getAutomationState(db, ws)).paused; }

/**
 * One-click pause / resume. `db` = the user's client (RLS: editor+). Resume releases deferred jobs and nudges runs
 * through mudar_app.release_automation_deferred (definer, editor check) — job rows are not user-writable.
 */
export async function setAutomationPaused(db: Db, ws: string, userId: string, paused: boolean, reason?: string | null, now = new Date()) {
  const before = await getAutomationState(db, ws);
  if (before.paused === paused) return { changed: false, state: before, released: 0 };
  const at = now.toISOString();
  const row: Row = paused
    ? { workspace_id: ws, paused: true, paused_at: at, paused_by: userId, reason: reason?.slice(0, 500) ?? null, updated_at: at }
    : { workspace_id: ws, paused: false, resumed_at: at, resumed_by: userId, updated_at: at };
  const { error } = await db.from("automation_control").upsert(row, { onConflict: "workspace_id" });
  if (error) throw new Error(error.code === "42501" ? "Only editors can pause or resume automation." : error.message);
  await audit(db, ws, { runId: null, key: null, action: paused ? "automation_paused" : "automation_resumed", actor: userId, detail: { reason: reason ?? null } });
  let released = 0;
  if (!paused) released = await releaseDeferred(db, ws);
  return { changed: true, state: await getAutomationState(db, ws), released };
}

/** On resume: deferred jobs become due now; queued scheduled/event runs are picked up at the next tick. No new rows. */
export async function releaseDeferred(db: Db, ws: string) {
  const { data, error } = await db.schema("mudar_app").rpc("release_automation_deferred", { p_workspace: ws });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

/**
 * Job guard: while paused a pausable job is re-queued 30 min later (dedupe per original job + slot, so repeated ticks
 * never multiply it) and completes with a `paused` result. Completed work is never undone.
 */
export async function deferForPause(job: Job, now = new Date()) {
  const due = new Date(+now + 30 * 60_000);
  const root = (job.payload as Row)?._automationDeferredFrom ?? job.id;
  await enqueue({ workspaceId: job.workspace_id, type: job.job_type, payload: { ...job.payload, _automationDeferredFrom: root }, dueAt: due, dedupeKey: `automation-paused:${root}:${Math.floor(+due / 1_800_000)}`, maxAttempts: 3 });
  return { paused: "automation_paused", resumeAt: due.toISOString() };
}

// ------------------------------------------------------------------ routed work (§2.4 "track whether the receiving module completed")
interface Route { kind: string; module: string; optional: boolean; find: (admin: Db, ws: string, e: Row) => Promise<Row | null> }
const after = (e: Row) => new Date(Date.parse(e.occurred_at) - 60_000).toISOString();
const latest = async (q: PromiseLike<{ data: Row[] | null }>) => ((await q).data ?? [])[0] ?? null;
export const ROUTES: Record<string, Route> = {
  "research.signal_detected": { kind: "signal_chain", module: "signals", optional: true, find: (a, ws, e) => e.subject_type !== "organisation" ? Promise.resolve(null)
    : latest(a.from("workflow_run").select("id, status").eq("workspace_id", ws).eq("kind", "signal_chain").eq("org_id", e.subject_id).gte("started_at", after(e)).order("started_at").limit(1) as never) },
  "meeting.completed": { kind: "meeting_chain", module: "meetings", optional: false, find: async (a, ws, e) => {
    const { data: preps } = await a.from("meeting_prep").select("id").eq("workspace_id", ws).eq("meeting_visit_id", e.subject_id).limit(20);
    const ids = ((preps ?? []) as Row[]).map((p) => p.id);
    return ids.length ? latest(a.from("workflow_run").select("id, status").eq("workspace_id", ws).eq("kind", "meeting_chain").in("subject_id", ids).gte("started_at", after(e)).order("started_at").limit(1) as never) : null;
  } },
  "contact.employment_changed": { kind: "employer_chain", module: "workflows", optional: true, find: (a, ws, e) => e.payload?.employment_id
    ? latest(a.from("workflow_run").select("id, status").eq("workspace_id", ws).eq("kind", "employer_chain").eq("subject_id", e.payload.employment_id).order("started_at").limit(1) as never) : Promise.resolve(null) },
  "lease.created": { kind: "lease_chain", module: "workflows", optional: true, find: (a, ws, e) => latest(a.from("workflow_run").select("id, status").eq("workspace_id", ws).eq("kind", "lease_chain").eq("subject_id", e.subject_id).gte("started_at", after(e)).order("started_at").limit(1) as never) },
  "lease.changed": { kind: "lease_chain", module: "workflows", optional: true, find: (a, ws, e) => latest(a.from("workflow_run").select("id, status").eq("workspace_id", ws).eq("kind", "lease_chain").eq("subject_id", e.subject_id).gte("started_at", after(e)).order("started_at").limit(1) as never) },
};

/** Refresh the status of routed work (pending/running → completed/failed/delayed/untracked). Returns counts. */
export async function trackRouted(admin: Db, ws: string, now = new Date()) {
  const { data } = await admin.from("event_processing_log").select("id, event_id, consumer, routed_status, created_at, event:event_id(id, event_type, subject_type, subject_id, payload, occurred_at)")
    .eq("workspace_id", ws).eq("status", "routed").in("routed_status", ["pending", "running"]).order("created_at").limit(100);
  const out = { completed: 0, failed: 0, delayed: 0, untracked: 0, open: 0 };
  for (const l of (data ?? []) as Row[]) {
    const e = l.event as Row | null; const route = e ? ROUTES[e.event_type] : undefined;
    if (!e || !route) continue;
    const run = await route.find(admin, ws, e);
    let st: string = routedStatus(run, e.occurred_at, now);
    // Optional routes: the receiving module decided nothing was needed (e.g. weak signal, lease outside renewal window).
    if (st === "delayed" && route.optional) st = "untracked";
    await admin.from("event_processing_log").update({ routed_status: st, routed_run_id: run?.id ?? null, routed_checked_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", l.id);
    if (st in out) out[st as keyof typeof out]++; else out.open++;
  }
  return out;
}

// ------------------------------------------------------------------ delayed processes (§2.8 notify about delayed processes)
/** Notify admins once per delayed run (after 60 min) — dedupe per run, so repeated ticks never repeat it. */
export async function notifyDelayed(admin: Db, ws: string, now = new Date()) {
  const { data } = await admin.from("workflow_run").select("id, definition_key, summary, status, started_at, next_attempt_at, error").eq("workspace_id", ws).eq("kind", "orchestrated")
    .in("status", ["queued", "waiting_dependency", "partially_completed"]).lt("started_at", new Date(+now - DELAY.notifyAfterMinutes * 60_000).toISOString()).limit(50);
  let sent = 0;
  for (const r of (data ?? []) as Row[]) {
    const why = delayReason(r, now);
    if (!why) continue;
    const res = await notifyAdmins(admin, ws, { category: "workflow_delayed", eventKey: `delayed:${r.id}`, severity: "info", title: `Delayed: ${r.summary ?? r.definition_key}`, body: why, href: `/automation/runs/${r.id}`, now });
    sent += res.filter((x) => x.created).length;
  }
  return { sent };
}

/**
 * §2.8 / §2.10: tell admins once when a workflow cannot recover by itself (failed, or partly failed with no retry
 * scheduled). Temporary failures that will retry stay quiet. Dedupe per run.
 */
export async function notifyFailures(admin: Db, ws: string, now = new Date()) {
  const { data } = await admin.from("workflow_run").select("id, definition_key, summary, status, error, next_attempt_at, finished_at").eq("workspace_id", ws).eq("kind", "orchestrated")
    .in("status", ["failed", "partially_completed"]).or("status.eq.failed,next_attempt_at.is.null").gte("started_at", new Date(+now - 24 * 3600_000).toISOString())
    // Newest first: an unordered capped read could skip a fresh failure once >limit older ones exist (dedupe makes re-sends no-ops).
    .order("started_at", { ascending: false }).limit(200);
  let sent = 0;
  for (const r of (data ?? []) as Row[]) {
    if (r.status === "partially_completed" && r.next_attempt_at) continue;
    const res = await notifyAdmins(admin, ws, { category: "failed_job", eventKey: `wf_failed:${r.id}`, severity: "urgent", title: `Needs you: ${r.summary ?? r.definition_key} could not finish`, body: `${r.error ?? "A step failed."} Finished steps are kept — open it to retry.`, href: `/automation/runs/${r.id}`, now });
    sent += res.filter((x) => x.created).length;
  }
  return { sent };
}

// ------------------------------------------------------------------ read models (UI C, D, F)
/** UI D — background jobs (mudar.job; admins only by RLS) + routed module tasks. */
export async function listBackgroundJobs(db: Db, ws: string, f: { state?: string; limit?: number } = {}, now = new Date()) {
  let q = db.from("job").select("id, job_type, state, attempts, max_attempts, due_at, last_error, created_at, updated_at, payload").eq("workspace_id", ws);
  if (f.state === "delayed") q = q.eq("state", "queued");
  else if (f.state) q = q.eq("state", f.state);
  const { data, error } = await q.order("updated_at", { ascending: false }).limit(f.limit ?? 100);
  if (error) throw new Error(error.message);
  const jobs = ((data ?? []) as Row[]).map((j) => {
    const finished = ["succeeded", "failed", "dead", "cancelled"].includes(j.state);
    const seconds = finished && j.created_at && j.updated_at ? Math.max(0, Math.round((Date.parse(j.updated_at) - Date.parse(j.due_at > j.created_at ? j.due_at : j.created_at)) / 1000)) : null;
    const deferred = (j.payload as Row)?._automationDeferredFrom ? "automation paused" : (j.payload as Row)?._budgetDeferredFrom ? "budget" : null;
    return {
      id: j.id, name: j.job_type, module: moduleOfJob(j.job_type), state: j.state, delayed: isDelayedJob(j, now), deferred,
      dueAt: j.due_at, finishedAt: finished ? j.updated_at : null, seconds, error: j.last_error,
      retry: j.state === "dead" ? `gave up after ${j.attempts} attempt(s)` : j.attempts > 0 && j.state === "queued" ? `retry ${j.attempts + 1} of ${j.max_attempts} at ${j.due_at}` : `${j.attempts} of ${j.max_attempts} attempts`,
    };
  });
  return f.state === "delayed" ? jobs.filter((j) => j.delayed) : jobs;
}

export async function listRouted(db: Db, ws: string, limit = 50) {
  const { data } = await db.from("event_processing_log").select("id, consumer, detail, routed_module, routed_kind, routed_status, routed_run_id, routed_checked_at, created_at, event:event_id(event_type)")
    .eq("workspace_id", ws).eq("status", "routed").order("created_at", { ascending: false }).limit(limit);
  return (data ?? []) as Row[];
}

/** UI C — workflow history: trigger, start/finish, status, executed/failed actions, retries, errors (from steps). */
export async function listHistory(db: Db, ws: string, f: { status?: string; limit?: number } = {}, now = new Date()) {
  let q = db.from("workflow_run").select("id, definition_key, summary, status, trigger_type, trigger_ref, started_at, finished_at, error, next_attempt_at, priority").eq("workspace_id", ws).eq("kind", "orchestrated");
  if (f.status && f.status !== "delayed") q = q.eq("status", f.status);
  const { data: runs } = await q.order("started_at", { ascending: false }).limit(f.limit ?? 50);
  const rows = (runs ?? []) as Row[];
  const ids = rows.map((r) => r.id);
  const { data: steps } = ids.length ? await db.from("workflow_step").select("run_id, label, status, attempts, error").eq("workspace_id", ws).in("run_id", ids) : { data: [] as Row[] };
  const by = new Map<string, Row[]>();
  for (const s of (steps ?? []) as Row[]) by.set(s.run_id, [...(by.get(s.run_id) ?? []), s]);
  const out = rows.map((r): Row => {
    const st = by.get(r.id) ?? [];
    return {
      ...r, name: r.summary ?? r.definition_key,
      trigger: triggerLabel(r),
      executed: st.filter((s) => s.status === "done").map((s) => s.label),
      failed: st.filter((s) => s.status === "failed" || s.status === "dead").map((s) => s.label),
      retries: st.reduce((n, s) => n + Math.max(0, (s.attempts ?? 0) - 1), 0),
      errors: st.filter((s) => s.error).map((s) => `${s.label}: ${s.error}`),
      delayed: delayReason(r, now),
    };
  });
  return f.status === "delayed" ? out.filter((r) => r.delayed) : out;
}

export function triggerLabel(r: Row): string {
  const t = r.trigger_type; const ref = (r.trigger_ref ?? {}) as Row;
  if (t === "event") return `Event: ${String(ref.event_type ?? "change").replace(/[._]/g, " ")}`;
  if (t === "schedule") return "Schedule";
  if (t === "user") return "Started by a person";
  return t ?? "—";
}

/** UI F — usage per category this month (model_usage USD + resource_usage units), used when no budget is configured. */
export async function monthUsage(db: Db, ws: string, now = new Date()): Promise<Record<string, { used: number; unit: string }>> {
  const { data: w } = await db.from("workspace").select("timezone").eq("id", ws).maybeSingle();
  const win = periodWindow("monthly", now, (w?.timezone as string) || "Asia/Kolkata");
  const { data: mu } = await db.from("model_usage").select("workflow, estimated_usd, search_calls, audio_seconds").eq("workspace_id", ws).gte("occurred_at", win.start.toISOString()).lt("occurred_at", win.end.toISOString()).limit(20_000);
  const out: Record<string, { used: number; unit: string }> = {};
  for (const r of (mu ?? []) as Row[]) {
    const k = workflowResource(r.workflow, r.search_calls, Number(r.audio_seconds));
    out[k] = { used: Math.round(((out[k]?.used ?? 0) + Number(r.estimated_usd)) * 10_000) / 10_000, unit: "usd" };
  }
  return out;
}

export async function loadBudgetCategories(db: Db, ws: string) {
  const [states, used] = await Promise.all([budgetStates(db, ws).catch(() => []), monthUsage(db, ws).catch(() => ({}))]);
  return { states, used };
}
