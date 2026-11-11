import "server-only";
/**
 * Read models + controls behind the Automation UI, /api/v1/orchestrator/** and the assistant's orchestrator tools.
 * Everything goes through the orchestrator core exports with the caller's RLS client (S2); role checks happen here.
 */
import { groupSteps } from "./progress";
import type { Db } from "@/lib/supabase/server";
import { hasRole, type Role } from "@/lib/auth/context";
import {
  listWorkflows, getWorkflow, definition, registeredWorkflows, setWorkflowStatus, editSchedule, changeWorkflowPriority,
  runWorkflow, advanceExecution, listExecutions, getExecution, pauseExecution, resumeExecution, cancelExecution, retryExecution,
  changePriority, affectedRecords, listMarks, resolveMark, listIntegrationHealth, type ExecStatus, type Ref,
} from "../index";
import { budgetStates } from "../budget/service";
import { PREPARE_MEETINGS, REFRESH_RECORD } from "./workflows";
import { loadOrchSettings } from "../schedule/settings-db";
import { recurringScheduleItems } from "../schedule/next-runs";
import { isRecalculated, markLabel, REF_TYPE, refHref } from "./labels";

type Row = Record<string, any>;
export interface Actor { db: Db; ws: string; userId: string; role: Role; timezone?: string }
export class AutomationError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Failed, or partly done with a step that will not retry by itself (no next attempt) — needs a person. */
const stuck = (r: Row) => r.status === "failed" || (r.status === "partially_completed" && !r.next_attempt_at);
const ACTIVE: ExecStatus[] = ["queued", "running", "waiting_dependency", "waiting_approval", "partially_completed", "paused"];
const need = (a: Actor, role: Role, what: string) => { if (!hasRole(a, role)) throw new AutomationError(403, `Only ${role === "admin" ? "admins" : "editors"} can ${what}.`); };
const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
  try { return await f(); } catch (e) {
    if (e instanceof AutomationError) throw e;
    const m = e instanceof Error ? e.message : String(e);
    throw new AutomationError(/not found|unknown workflow/i.test(m) ? 404 : /changed meanwhile|changed by someone/i.test(m) ? 409 : 400, m);
  }
};

// ------------------------------------------------------------------ helpers
/** Adds a label + link to orchestrator refs (analysis links need the analysis kind). */
export async function linkRefs(db: Db, ws: string, refs: Ref[]) {
  const ids = [...new Set(refs.filter((r) => r.type === "deal_analysis").map((r) => r.id))];
  const kinds = new Map<string, Row>();
  if (ids.length) for (const a of ((await db.from("deal_analysis").select("id, kind, title").eq("workspace_id", ws).in("id", ids.slice(0, 200))).data ?? []) as Row[]) kinds.set(a.id, a);
  const seen = new Set<string>();
  return refs.filter((r) => { const k = `${r.type}:${r.id}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((r) => ({ ...r, typeLabel: REF_TYPE[r.type] ?? r.type.replace(/_/g, " "), label: r.label ?? kinds.get(r.id)?.title ?? null, href: refHref(r.type, r.id, kinds.get(r.id)?.kind) }));
}

function definitionOrThrow(key: string) {
  try { return definition(key); } catch { throw new AutomationError(404, "Unknown workflow."); }
}

// ------------------------------------------------------------------ dashboard
export async function loadDashboard(a: Actor) {
  const { db, ws } = a;
  const [workflows, runs, health, proposals, marks, budgets] = await Promise.all([
    listWorkflows(db, ws),
    listExecutions(db, ws, { limit: 100 }),
    listIntegrationHealth(db, ws),
    db.from("change_proposal").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("state", "proposed"),
    listMarks(db, ws, { limit: 200 }),
    budgetStates(db, ws).then((b) => ({ ok: true as const, items: b })).catch((e) => ({ ok: false as const, items: [], error: e instanceof Error ? e.message : String(e) })),
  ]);
  const scheduled = workflows.filter((w) => w.trigger.type === "schedule").map((w) => ({ key: w.key, name: w.name, status: w.state?.status ?? "active", everyMinutes: w.state?.every_minutes ?? w.trigger.everyMinutes ?? null, nextRunAt: w.state?.next_run_at ?? null, lastRunAt: w.state?.last_run_at ?? null }));
  // Per-user recurring items (daily plan, weekly review) come from the schedule settings, not workflow definitions.
  const recurring = await loadOrchSettings(db, ws, a.userId).then((st) => recurringScheduleItems(st, new Date())).catch(() => []);
  const names = new Map(workflows.map((w) => [w.key, w.name]));
  const withName = (r: Row) => ({ ...r, name: names.get(r.definition_key) ?? r.summary ?? r.definition_key });
  return {
    workflows,
    active: workflows.filter((w) => (w.state?.status ?? "active") === "active"),
    pausedWorkflows: workflows.filter((w) => w.state?.status === "paused"),
    scheduled,
    recurring,
    running: runs.filter((r) => ACTIVE.includes(r.status) && r.status !== "paused" && r.status !== "waiting_approval" && !stuck(r)).map(withName),
    waitingApproval: runs.filter((r) => r.status === "waiting_approval").map(withName),
    pausedRuns: runs.filter((r) => r.status === "paused").map(withName),
    failed: runs.filter(stuck).map(withName),
    completed: runs.filter((r) => r.status === "completed" || r.status === "done").slice(0, 20).map(withName),
    pendingProposals: proposals.count ?? 0,
    health,
    unhealthy: health.filter((h) => h.status !== "healthy"),
    openMarks: marks,
    budgets,
  };
}

/** Today card: things in the background that need a person. Empty list = nothing to show. */
export async function loadAttention(a: Actor) {
  const { db, ws } = a;
  const [runs, health, marks] = await Promise.all([
    listExecutions(db, ws, { status: ["failed", "partially_completed", "waiting_approval", "paused"], limit: 40 }).then((rs) => rs.filter((r) => r.status !== "partially_completed" || stuck(r)).slice(0, 20)),
    listIntegrationHealth(db, ws),
    listMarks(db, ws, { limit: 100 }),
  ]);
  const names = new Map(registeredWorkflows().map((w) => [w.key, w.name]));
  const items: { title: string; detail: string; href: string; tone: "bad" | "warn" }[] = [];
  for (const h of health.filter((x) => x.status !== "healthy")) items.push({ tone: h.status === "down" ? "bad" : "warn", title: `${h.label ?? h.source_key} is not working`, detail: `Last worked ${h.last_success_at ? new Date(h.last_success_at).toLocaleString("en-IN", { timeZone: a.timezone ?? "Asia/Kolkata" }) : "never"}; data from it may be out of date.`, href: "/automation#connections" });
  for (const r of runs) items.push({
    tone: stuck(r) ? "bad" : "warn",
    title: `${names.get(r.definition_key) ?? r.summary ?? "Background job"} — ${r.status === "failed" ? "failed" : r.status === "partially_completed" ? "partly failed" : r.status === "paused" ? "paused" : "needs your approval"}`,
    detail: r.error ?? (r.status === "paused" ? "Resume it when ready." : "Open it to approve or cancel."), href: `/automation/runs/${r.id}`,
  });
  const outdated = marks.filter((m) => m.mark === "outdated_warning").length;
  const refresh = marks.filter((m) => m.mark !== "outdated_warning").length;
  if (outdated) items.push({ tone: "bad", title: `${outdated} approved or shared output(s) are outdated`, detail: "They were not changed. Review them and create new versions if needed.", href: "/approvals/outdated" });
  if (refresh) items.push({ tone: "warn", title: `${refresh} record(s) need a refresh`, detail: "Something they depend on changed.", href: "/approvals/outdated" });
  return items;
}

/** Review → "Outdated proposals": open reassessment marks, most serious first, with links. */
export async function listExceptions(a: Actor, f: { kind?: "outdated" | "all" } = {}) {
  const marks = await listMarks(a.db, a.ws, { limit: 200 });
  const rows = f.kind === "outdated" ? marks.filter((m) => m.mark === "outdated_warning" || m.mark === "review") : marks;
  const order = ["outdated_warning", "review", "needs_refresh", "stale"];
  rows.sort((x, y) => order.indexOf(x.mark) - order.indexOf(y.mark));
  const links = await linkRefs(a.db, a.ws, rows.map((m) => ({ type: m.entity_type, id: m.entity_id })));
  const byKey = new Map(links.map((l) => [`${l.type}:${l.id}`, l]));
  return rows.map((m): Row => ({ ...m, label: markLabel(m).label, recalculated: isRecalculated(m), record: byKey.get(`${m.entity_type}:${m.entity_id}`) ?? null }));
}

/** Open marks on one record (banner on toolkit / deliverable / requirement pages). */
export async function marksFor(db: Db, ws: string, entityType: string, entityId: string) {
  return listMarks(db, ws, { entityType, entityId, limit: 5 });
}

// ------------------------------------------------------------------ workflow + run pages
export async function loadWorkflow(a: Actor, key: string) {
  definitionOrThrow(key);
  // getWorkflow creates the per-workspace row on first view; a viewer cannot (RLS) → read-only fallback.
  const w = await getWorkflow(a.db, a.ws, key).catch(async () => {
    const base = (await listWorkflows(a.db, a.ws)).find((x) => x.key === key)!;
    const { data: runs } = await a.db.from("workflow_run").select("id, status, started_at, finished_at, progress, error").eq("workspace_id", a.ws).eq("definition_key", key).order("started_at", { ascending: false }).limit(20);
    return { ...base, versions: [] as Row[], recentExecutions: (runs ?? []) as Row[] };
  });
  const recent = w.recentExecutions as Row[];
  const latest = recent[0] ?? null;
  const refs = latest ? await affectedRecords(a.db, a.ws, latest.id) : [];
  return { ...w, latest, lastFailed: recent.find(stuck) ?? null, activeRun: recent.find((r) => ACTIVE.includes(r.status)) ?? null, related: await linkRefs(a.db, a.ws, refs) };
}

export async function loadRun(a: Actor, runId: string) {
  const x = await getExecution(a.db, a.ws, runId);
  if (!x || x.run.kind !== "orchestrated") return null;
  let def: ReturnType<typeof definition> | null = null;
  try { def = definition(x.run.definition_key); } catch { def = null; }
  const refs = await affectedRecords(a.db, a.ws, runId);
  const steps = x.steps;
  return {
    ...x, name: def?.name ?? x.run.summary ?? x.run.definition_key, definitionKey: x.run.definition_key,
    ...groupSteps(steps, x.run.status),
    related: await linkRefs(a.db, a.ws, refs),
    failureRefs: x.failure ? await linkRefs(a.db, a.ws, x.failure.affectedRecords as Ref[]) : [],
  };
}

// ------------------------------------------------------------------ controls
export type WorkflowAction = { action: "pause" | "resume" } | { action: "schedule"; everyMinutes: number | null; nextRunAt?: string | null }
  | { action: "priority"; priority: number } | { action: "start"; input?: Record<string, unknown>; dedupeKey?: string };

export async function workflowControl(a: Actor, key: string, body: WorkflowAction) {
  const def = definitionOrThrow(key);
  return wrap(async () => {
    switch (body.action) {
      case "pause": need(a, "admin", "pause workflows"); return { state: await setWorkflowStatus(a.db, a.ws, key, "paused", a.userId) };
      case "resume": need(a, "admin", "switch workflows on"); return { state: await setWorkflowStatus(a.db, a.ws, key, "active", a.userId) };
      case "schedule":
        need(a, "admin", "change schedules");
        if (def.trigger.type !== "schedule") throw new AutomationError(400, "This workflow does not run on a schedule.");
        if (body.everyMinutes !== null && (!Number.isInteger(body.everyMinutes) || body.everyMinutes < 5 || body.everyMinutes > 60 * 24 * 31)) throw new AutomationError(400, "Choose an interval between 5 minutes and 31 days.");
        return { state: await editSchedule(a.db, a.ws, key, { everyMinutes: body.everyMinutes, nextRunAt: body.nextRunAt }, a.userId) };
      case "priority":
        need(a, "admin", "change priority");
        if (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 100) throw new AutomationError(400, "Priority must be 0–100.");
        return { state: await changeWorkflowPriority(a.db, a.ws, key, body.priority, a.userId) };
      case "start": return startWorkflow(a, key, body.input ?? {}, body.dedupeKey);
    }
  });
}

/** Workflows a person may start by hand (user-triggered, role allowed). */
export function startableWorkflows(a: Pick<Actor, "role">) {
  return registeredWorkflows().filter((d) => d.trigger.type === "user" && !d.key.startsWith("test.") && d.key !== REFRESH_RECORD && hasRole(a, d.permissions?.role ?? "editor"));
}

export async function startWorkflow(a: Actor, key: string, input: Record<string, unknown> = {}, dedupeKey?: string) {
  const def = definitionOrThrow(key);
  if (def.trigger.type !== "user") throw new AutomationError(400, "This workflow starts on its own; it cannot be started by hand.");
  need(a, def.permissions?.role ?? "editor", `start "${def.name}"`);
  const { data: row } = await a.db.from("workflow_definition").select("status").eq("workspace_id", a.ws).eq("key", key).maybeSingle();
  if (row?.status === "paused") throw new AutomationError(409, `"${def.name}" is paused. Switch it on first.`);
  const r = await runWorkflow(a.db, a.ws, key, { input, actor: a.userId, trigger: "user", dedupeKey });
  return { runId: r.id, duplicate: r.duplicate, status: r.status };
}

export type RunAction = { action: "pause" | "resume" | "cancel" | "retry" | "continue" } | { action: "priority"; priority: number };

export async function runControl(a: Actor, runId: string, body: RunAction) {
  return wrap(async () => {
    const { data: run } = await a.db.from("workflow_run").select("id, kind").eq("workspace_id", a.ws).eq("id", runId).maybeSingle();
    if (!run || run.kind !== "orchestrated") throw new AutomationError(404, "Run not found.");
    switch (body.action) {
      case "pause": need(a, "editor", "pause runs"); await pauseExecution(a.db, a.ws, runId, a.userId); break;
      case "resume": need(a, "editor", "resume runs"); await resumeExecution(a.db, a.ws, runId, a.userId); await advanceExecution(a.db, a.ws, runId); break;
      case "retry": need(a, "editor", "retry runs"); await retryExecution(a.db, a.ws, runId, a.userId); await advanceExecution(a.db, a.ws, runId); break;
      case "continue": need(a, "editor", "continue runs"); await advanceExecution(a.db, a.ws, runId); break;
      case "cancel": need(a, "admin", "cancel runs"); await cancelExecution(a.db, a.ws, runId, a.userId); break;
      case "priority": need(a, "admin", "change priority"); await changePriority(a.db, a.ws, runId, body.priority, a.userId); break;
    }
    const { data: after } = await a.db.from("workflow_run").select("id, status, progress, error").eq("workspace_id", a.ws).eq("id", runId).single();
    return { run: after as Row };
  });
}

/** Banner "Refresh": runs the refresh workflow for the flagged record; "Dismiss" closes the warning (kept in history). */
export async function markControl(a: Actor, markId: string, body: { action: "refresh" | "dismiss" }, dedupeKey?: string) {
  need(a, "editor", body.action === "refresh" ? "refresh records" : "dismiss warnings");
  const { data: m } = await a.db.from("reassessment_mark").select("id, entity_type, entity_id, state").eq("workspace_id", a.ws).eq("id", markId).maybeSingle();
  if (!m) throw new AutomationError(404, "Warning not found.");
  if (m.state !== "open") return { state: m.state, runId: null };
  if (body.action === "dismiss") { await resolveMark(a.db, a.ws, markId, "dismissed"); return { state: "dismissed", runId: null }; }
  return wrap(async () => {
    const r = await runWorkflow(a.db, a.ws, REFRESH_RECORD, { input: { markId, entityType: m.entity_type, entityId: m.entity_id }, actor: a.userId, trigger: "user", subjectType: m.entity_type, subjectId: m.entity_id, dedupeKey: dedupeKey ? `refresh:${markId}:${dedupeKey}` : undefined });
    const { data: after } = await a.db.from("reassessment_mark").select("state").eq("workspace_id", a.ws).eq("id", markId).single();
    return { state: after?.state ?? "open", runId: r.id, status: r.status };
  });
}

// ------------------------------------------------------------------ assistant: request → workflow
const REQUEST_RULES: [RegExp, string][] = [
  [/\b(prepare|prep|get ready)\b.*\bmeetings?\b|\bmeetings?\b.*\b(prepare|prep|brief)|\bcommitments?\b|\bpromises?\b/i, PREPARE_MEETINGS],
];
/** Picks the user-startable workflow a plain request describes (deterministic; null = none fits). */
export function workflowForRequest(request: string): string | null {
  for (const [re, key] of REQUEST_RULES) if (re.test(request)) return key;
  return null;
}
/** "tomorrow" (default) / "today" / an explicit YYYY-MM-DD → local date. */
export function dateForRequest(request: string, tz: string, now = new Date()): string {
  const explicit = request.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (explicit) return explicit[1];
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  if (/\btoday\b/i.test(request)) return today;
  return new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
