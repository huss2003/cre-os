/**
 * Automation controls and monitoring rules (pure; spec §2.4, §2.7, §2.9, §2.11, §2.13, UI A/C/D/E/F).
 *  - which background jobs a global pause holds back (never user-initiated or critical operations),
 *  - when a workflow run or a job counts as delayed,
 *  - the order the dispatcher works in when urgent client work arrives,
 *  - the overview counts and the system-alerts list.
 */
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Background automation that a global pause holds back. Everything else keeps running: user-submitted work
 * (captures, imports, assistant commands), meeting reminders/briefs, the daily plan (rule 6), admin/backup jobs and the
 * dispatcher itself (which only advances user-started runs while paused).
 */
const PAUSABLE: RegExp[] = [
  /^signals\.scan$/, /^intelligence\.(research|research_org|patrol|strategy)$/, /^contacts\.reverify$/,
  /^scoring\.(bulk|recalc)$/, /^deals\.(rematch|req_tasks|concession_npv)$/, /^imports\.steward_stale$/, /^tutorials\.sync$/,
  /^workflows\.sweep$/, /^outreach\.sweep$/, /^integrations\.(sequence_tick|calendar_conflicts)$/,
  /^brief\.(radar|recalc|deadline_watch)$/, /^orchestrator\.(weekly_review|hourly|sweep)$/,
];

/** True = held back while automation is paused. A job a person started (payload.userInitiated / actor + trigger 'user') never is. */
export function isPausableJob(jobType: string, payload: Record<string, unknown> | null | undefined = {}): boolean {
  const p = payload ?? {};
  if (p.userInitiated === true || p.trigger === "user" || p.critical === true) return false;
  return PAUSABLE.some((re) => re.test(jobType));
}

export const moduleOfJob = (jobType: string) => jobType.split(".")[0];

/** Specialist module that owns a job type (UI D "assigned specialist module"). */
const MODULE_LABEL: Record<string, string> = {
  signals: "Signal Engine (2)", scoring: "Scoring Engine (3)", contacts: "Contact Enrichment (4)", outreach: "Outreach Engine (5)",
  meetings: "Meeting Intelligence (7)", deals: "Deal Toolkit (8)", orchestrator: "Orchestrator (9)", assistant: "Supercharged Assistant (12)",
  imports: "Database imports (1)", capture: "Capture", brief: "Daily brief", integrations: "Integrations", intelligence: "Research",
  admin: "Admin", workflows: "Workflow chains", tutorials: "Tutorials",
};
export const moduleLabel = (m: string | null | undefined) => (m ? MODULE_LABEL[m] ?? m : "—");

// ------------------------------------------------------------------ delayed work
export const DELAY = { queuedMinutes: 30, waitingDependencyMinutes: 120, jobLateMinutes: 15, notifyAfterMinutes: 60 };
const mins = (from: string | null | undefined, now: Date) => (from ? (+now - Date.parse(from)) / 60_000 : 0);

/**
 * A workflow run is delayed when it should have progressed and has not: waiting for a retry after a temporary failure,
 * queued for longer than 30 min, or waiting on a dependency for longer than 2 h. Paused/finished runs are not delayed.
 */
export function delayReason(r: Row, now = new Date()): string | null {
  if (["completed", "done", "failed", "cancelled", "skipped", "paused", "waiting_approval"].includes(r.status)) return null;
  if (r.next_attempt_at && Date.parse(r.next_attempt_at) > +now && (r.status === "partially_completed" || r.error)) return `Waiting to retry after a temporary failure (next try ${r.next_attempt_at}).`;
  if (r.status === "queued" && mins(r.started_at, now) > DELAY.queuedMinutes) return `Queued for ${Math.round(mins(r.started_at, now))} min without starting.`;
  if (r.status === "waiting_dependency" && mins(r.started_at, now) > DELAY.waitingDependencyMinutes) return `Waiting for required information for ${Math.round(mins(r.started_at, now) / 60)} h.`;
  return null;
}
export const isDelayedRun = (r: Row, now = new Date()) => delayReason(r, now) !== null;

/** A queued job is delayed when it is more than 15 min past its due time (or re-queued after a failure). */
export function isDelayedJob(j: Row, now = new Date()): boolean {
  if (j.state !== "queued") return false;
  return mins(j.due_at, now) > DELAY.jobLateMinutes || (j.attempts > 0 && !!j.last_error);
}

// ------------------------------------------------------------------ priority
export const URGENT_PRIORITY = 70;
export const BACKGROUND_PRIORITY = 40;
/**
 * Dispatcher order (rule 9): urgent client work first; while urgent work is waiting, routine background runs
 * (priority < 40) are held for the next tick so they cannot crowd it out. User-started runs count as urgent.
 */
export function dispatchOrder<T extends { priority?: number | null; trigger_type?: string | null; started_at?: string | null }>(runs: T[], limit = 20): { run: T[]; held: T[] } {
  const pr = (r: T) => (r.trigger_type === "user" ? Math.max(r.priority ?? 50, URGENT_PRIORITY) : r.priority ?? 50);
  const sorted = [...runs].sort((a, b) => pr(b) - pr(a) || String(a.started_at ?? "").localeCompare(String(b.started_at ?? "")));
  const urgent = sorted.some((r) => pr(r) >= URGENT_PRIORITY);
  const run = urgent ? sorted.filter((r) => pr(r) >= BACKGROUND_PRIORITY) : sorted;
  const held = urgent ? sorted.filter((r) => pr(r) < BACKGROUND_PRIORITY) : [];
  return { run: run.slice(0, limit), held };
}

// ------------------------------------------------------------------ overview + alerts
const ACTIVE = ["queued", "running", "waiting_dependency", "partially_completed"];
const needsAttention = (r: Row) => r.status === "failed" || r.status === "waiting_approval" || r.status === "paused" || (r.status === "partially_completed" && !r.next_attempt_at);

export interface OverviewCounts { total: number; active: number; scheduled: number; completed: number; failed: number; delayed: number; attention: number }
export function overviewCounts(runs: Row[], scheduledCount: number, now = new Date()): OverviewCounts {
  return {
    total: runs.length,
    active: runs.filter((r) => ACTIVE.includes(r.status) && !needsAttention(r)).length,
    scheduled: scheduledCount,
    completed: runs.filter((r) => r.status === "completed" || r.status === "done").length,
    failed: runs.filter((r) => r.status === "failed").length,
    delayed: runs.filter((r) => isDelayedRun(r, now)).length,
    attention: runs.filter(needsAttention).length,
  };
}

export type AlertKind = "info_change" | "failed" | "delayed" | "outage" | "stale" | "budget" | "attention" | "paused";
export interface Alert { kind: AlertKind; tone: "bad" | "warn" | "neutral"; title: string; detail: string; href: string }
const KIND_ORDER: AlertKind[] = ["paused", "outage", "failed", "budget", "attention", "delayed", "stale", "info_change"];

/** UI E — one short list, most serious first; routine items are folded into counts (spec §2.8: few, meaningful alerts). */
export function buildAlerts(i: {
  paused: boolean; failedRuns: Row[]; delayedRuns: Row[]; unhealthy: Row[]; marks: Row[]; budgets: { status: string; budget: Row; used: number; limit: number }[];
  pendingProposals: number; waitingApproval: number; infoChanges: Row[]; routedFailed?: number;
}): Alert[] {
  const a: Alert[] = [];
  if (i.paused) a.push({ kind: "paused", tone: "warn", title: "Background automation is paused", detail: "Scheduled checks, research and scoring wait until you resume. Your own actions and meeting reminders still run.", href: "/automation" });
  for (const h of i.unhealthy) a.push({ kind: "outage", tone: h.status === "down" ? "bad" : "warn", title: `${h.label ?? h.source_key} is unavailable`, detail: `Last worked ${h.last_success_at ?? "never"}; information from it may be stale.`, href: "/automation#connections" });
  if (i.failedRuns.length) a.push({ kind: "failed", tone: "bad", title: `${i.failedRuns.length} workflow${i.failedRuns.length === 1 ? "" : "s"} failed`, detail: i.failedRuns.slice(0, 3).map((r) => r.name ?? r.definition_key).join(", "), href: "/automation?view=history&status=failed" });
  if (i.routedFailed) a.push({ kind: "failed", tone: "bad", title: `${i.routedFailed} routed task${i.routedFailed === 1 ? "" : "s"} failed in the receiving module`, detail: "See Background jobs for the module and reason.", href: "/automation?view=jobs" });
  for (const b of i.budgets.filter((x) => x.status !== "ok")) a.push({ kind: "budget", tone: b.status === "exhausted" ? "bad" : "warn", title: `${String(b.budget.resource).replace(/_/g, " ")} budget ${b.status === "exhausted" ? "used up" : "nearly used"}`, detail: `${b.used} of ${b.limit} ${b.budget.unit}${b.status === "exhausted" ? " — non-critical work waits" : ""}`, href: "/automation?view=budgets" });
  const attention = i.pendingProposals + i.waitingApproval;
  if (attention) a.push({ kind: "attention", tone: "warn", title: `${attention} item${attention === 1 ? "" : "s"} need your decision`, detail: `${i.pendingProposals} change(s) to review, ${i.waitingApproval} run(s) waiting for approval.`, href: "/approvals" });
  if (i.delayedRuns.length) a.push({ kind: "delayed", tone: "warn", title: `${i.delayedRuns.length} workflow${i.delayedRuns.length === 1 ? " is" : "s are"} delayed`, detail: i.delayedRuns.slice(0, 3).map((r) => r.name ?? r.definition_key).join(", "), href: "/automation?view=history&status=delayed" });
  const stale = i.marks.filter((m) => m.mark === "stale").length;
  const outdated = i.marks.filter((m) => m.mark !== "stale").length;
  if (stale) a.push({ kind: "stale", tone: "warn", title: `${stale} record${stale === 1 ? "" : "s"} may be stale`, detail: "Their source was unavailable; figures may be out of date.", href: "/approvals/outdated" });
  if (outdated) a.push({ kind: "stale", tone: "warn", title: `${outdated} output${outdated === 1 ? "" : "s"} need a refresh`, detail: "Information they depend on changed.", href: "/approvals/outdated" });
  for (const n of i.infoChanges.slice(0, 3)) a.push({ kind: "info_change", tone: "neutral", title: n.title, detail: n.body ?? "", href: n.href ?? "/automation?view=notifications" });
  return a.sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind));
}

// ------------------------------------------------------------------ budget categories (UI F)
export const CATEGORIES = [["research", "Research"], ["enrichment", "Contact enrichment"], ["transcription", "Transcription"], ["model_tokens", "AI"]] as const;
export interface CategoryUsage { resource: string; label: string; limit: number | null; used: number; remaining: number | null; unit: string; period: string | null; status: "ok" | "near" | "exhausted" | "no_limit" }
/** One row per category, always shown: the tightest configured budget, or "no limit" with this month's usage. */
export function categoryUsage(states: { status: string; budget: Row; used: number; limit: number; pct: number }[], monthUsed: Record<string, { used: number; unit: string }>): CategoryUsage[] {
  return CATEGORIES.map(([resource, label]) => {
    const mine = states.filter((s) => s.budget.resource === resource).sort((a, b) => b.pct - a.pct);
    const s = mine[0];
    if (!s) { const u = monthUsed[resource] ?? { used: 0, unit: "usd" }; return { resource, label, limit: null, used: u.used, remaining: null, unit: u.unit, period: "monthly", status: "no_limit" as const }; }
    return { resource, label, limit: s.limit, used: s.used, remaining: Math.max(0, Math.round((s.limit - s.used) * 10_000) / 10_000), unit: s.budget.unit, period: s.budget.period, status: s.status as CategoryUsage["status"] };
  });
}

// ------------------------------------------------------------------ routed-work tracking (§2.4)
/** Map a legacy chain run status to the routed status; no run after 2 h ⇒ delayed. */
export function routedStatus(run: Row | null, eventAt: string, now = new Date()): "pending" | "running" | "completed" | "failed" | "delayed" {
  if (!run) return mins(eventAt, now) > 120 ? "delayed" : "pending";
  if (run.status === "done" || run.status === "completed" || run.status === "skipped") return "completed";
  if (run.status === "failed") return "failed";
  return "running";
}
