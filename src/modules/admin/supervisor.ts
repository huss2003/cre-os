/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import type { SupabaseClient } from "@supabase/supabase-js";
import { notify } from "@/modules/brief/db";
import { sha256 } from "@/lib/util/crypto";
import { fmt } from "@/lib/util/time";
import { spendSummary } from "./health";

/**
 * System Supervisor (workflow 22). Runs inside every scheduler tick (service role, every query workspace-filtered):
 * evaluates each workspace's health, keeps a deduplicated failure queue in `supervisor_alert`, and sends PRIVATE in-app
 * notifications (outbox → /today "Urgent (private alerts)") to that workspace's owners/admins. Never external.
 * Alerts carry an actionable, non-sensitive title only — no stack traces, message bodies or e-mail content.
 * Controls: a check that errors is reported as an error and its open alerts are NOT auto-resolved (never claim a
 * source is healthy when it was not checked).
 */
type Admin = SupabaseClient<any, any, any>;
type Row = Record<string, any>;

export const SUPERVISOR = {
  heartbeatStaleMinutes: 15,
  backupMissedHours: 26,
  backupStuckHours: 2,
  connectorStaleHours: 26,
  deadJobLookbackDays: 14,
  budgetWarnPct: 80,
  budgetHardPct: 100,
  notifyWindowHours: 48,
} as const;

export type AlertKind = "dead_job" | "backup_missed" | "backup_failed" | "restore_failed" | "ai_budget_80" | "ai_budget_100"
  | "connector_failed" | "connector_stale" | "scheduler_gap";
export interface AlertCandidate {
  kind: AlertKind;
  subject: string;
  severity: "critical" | "warning";
  title: string;
  href: string;
  detail?: Record<string, unknown>;
}

const hoursSince = (iso: string | null | undefined, now: Date) => (iso ? (now.getTime() - Date.parse(iso)) / 3_600_000 : null);
const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

// ------------------------------------------------------------------ pure candidate builders (unit-tested)
export function deadJobCandidates(jobs: Row[]): AlertCandidate[] {
  return jobs.filter((j) => j.state === "dead").map((j) => ({
    kind: "dead_job", subject: String(j.id), severity: "critical",
    title: `Background job "${j.job_type}" failed permanently after ${j.attempts} attempt(s) — review and retry on /admin`,
    href: "/admin#failures", detail: { job_id: j.id, job_type: j.job_type, attempts: j.attempts },
  }));
}

/** runs: backup_run rows for one workspace, newest first. */
export function backupCandidates(runs: Row[], workspaceCreatedAt: string, now: Date): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const exports = runs.filter((r) => r.kind === "logical_export");
  const lastOk = exports.find((r) => r.status === "succeeded" || r.status === "warning");
  const okAge = hoursSince(lastOk?.finished_at ?? lastOk?.started_at, now);
  const wsAge = hoursSince(workspaceCreatedAt, now) ?? 0;
  if ((okAge === null && wsAge > SUPERVISOR.backupMissedHours) || (okAge !== null && okAge > SUPERVISOR.backupMissedHours)) {
    out.push({
      kind: "backup_missed", subject: "logical_export", severity: "critical",
      title: okAge === null ? `No successful backup yet (workspace is ${Math.round(wsAge)} h old) — check the nightly export on /admin`
        : `No successful backup in the last ${SUPERVISOR.backupMissedHours} h (last ${Math.round(okAge)} h ago) — check the nightly export on /admin`,
      href: "/admin#backups", detail: { last_success_id: lastOk?.id ?? null, hours_since: okAge === null ? null : Math.round(okAge) },
    });
  }
  const latest = exports[0];
  if (latest && latest.status === "failed") {
    out.push({ kind: "backup_failed", subject: String(latest.id), severity: "critical",
      title: "The latest nightly backup failed — see Backups on /admin", href: "/admin#backups", detail: { backup_run_id: latest.id } });
  } else if (latest && latest.status === "running" && (hoursSince(latest.started_at, now) ?? 0) > SUPERVISOR.backupStuckHours) {
    out.push({ kind: "backup_failed", subject: String(latest.id), severity: "critical",
      title: `The latest nightly backup has been running for over ${SUPERVISOR.backupStuckHours} h (probably crashed) — see /admin`,
      href: "/admin#backups", detail: { backup_run_id: latest.id, stuck: true } });
  }
  const sample = runs.find((r) => r.kind === "restore_sample" && r.status !== "running");
  if (sample && sample.status === "failed") {
    out.push({ kind: "restore_failed", subject: String(sample.id), severity: "critical",
      title: "The monthly restore test failed — backups may not be restorable; see Backups on /admin", href: "/admin#backups",
      detail: { backup_run_id: sample.id } });
  }
  return out;
}

export function budgetCandidates(spentInr: number, budgetInr: number, monthStartIso: string): AlertCandidate[] {
  if (!(budgetInr > 0)) return [];
  const pct = (spentInr / budgetInr) * 100;
  const month = monthStartIso.slice(0, 7);
  if (pct >= SUPERVISOR.budgetHardPct) {
    return [{ kind: "ai_budget_100", subject: month, severity: "critical", href: "/admin#spend",
      title: `AI spend reached ${Math.floor(pct)}% of the monthly budget (${rupees(spentInr)} of ${rupees(budgetInr)}) — pause AI or ask the platform admin to raise the budget`,
      detail: { month, pct: Math.floor(pct) } }];
  }
  if (pct >= SUPERVISOR.budgetWarnPct) {
    return [{ kind: "ai_budget_80", subject: month, severity: "warning", href: "/admin#spend",
      title: `AI spend is at ${Math.floor(pct)}% of the monthly budget (${rupees(spentInr)} of ${rupees(budgetInr)})`,
      detail: { month, pct: Math.floor(pct) } }];
  }
  return [];
}

export function connectorCandidates(accounts: Row[], cursors: Row[], now: Date): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  for (const a of accounts) {
    if (["expired", "revoked", "error"].includes(a.status)) {
      out.push({ kind: "connector_failed", subject: String(a.id), severity: "critical", href: "/settings/connections",
        title: `${a.provider} connector is ${a.status} — reconnect it in Settings → Connections`, detail: { connector_account_id: a.id, status: a.status } });
      continue;
    }
    for (const c of cursors.filter((x) => x.connector_account_id === a.id)) {
      const subject = `${a.id}:${c.resource}`;
      const failing = !!c.last_error && (!c.last_success_at || (c.last_attempt_at && Date.parse(c.last_attempt_at) > Date.parse(c.last_success_at)));
      const age = hoursSince(c.last_success_at, now);
      if (failing) {
        out.push({ kind: "connector_failed", subject, severity: "critical", href: "/admin#connectors",
          title: `${a.provider} ${c.resource} sync is failing — sections that use it are shown as stale`, detail: { connector_account_id: a.id, resource: c.resource } });
      } else if ((age === null && (hoursSince(a.created_at, now) ?? 0) > SUPERVISOR.connectorStaleHours) || (age !== null && age > SUPERVISOR.connectorStaleHours)) {
        out.push({ kind: "connector_stale", subject, severity: "warning", href: "/admin#connectors",
          title: age === null ? `${a.provider} ${c.resource} has never synced successfully` : `${a.provider} ${c.resource} last synced ${Math.round(age)} h ago`,
          detail: { connector_account_id: a.id, resource: c.resource, hours_since: age === null ? null : Math.round(age) } });
      }
    }
  }
  return out;
}

export function heartbeatState(lastTickAt: string | null | undefined, now: Date) {
  const minutes = lastTickAt ? (now.getTime() - Date.parse(lastTickAt)) / 60_000 : null;
  return { lastTickAt: lastTickAt ?? null, minutesSince: minutes, stale: minutes === null || minutes > SUPERVISOR.heartbeatStaleMinutes };
}

export function gapCandidate(gap: { gapMinutes: number | null; prevStartedAt: string | null }, tz = "Asia/Kolkata"): AlertCandidate | null {
  if (gap.gapMinutes === null || gap.prevStartedAt === null || gap.gapMinutes <= SUPERVISOR.heartbeatStaleMinutes) return null;
  const g = gap.gapMinutes >= 120 ? `${Math.round(gap.gapMinutes / 60)} h` : `${Math.round(gap.gapMinutes)} min`;
  return {
    kind: "scheduler_gap", subject: new Date(gap.prevStartedAt).toISOString(), severity: "critical", href: "/admin",
    title: `Background processing was stopped for ${g} (last run before that: ${fmt(gap.prevStartedAt, "dd MMM HH:mm", tz)}) — briefs, syncs and backups may be late`,
    detail: { gap_minutes: gap.gapMinutes, prev_started_at: gap.prevStartedAt },
  };
}

// ------------------------------------------------------------------ evaluation + reconciliation (service role)
export interface WorkspaceRow { id: string; created_at: string; monthly_ai_budget_inr: number | string | null; timezone: string | null }

/** Evaluate one workspace. Each check is independent; a failed check is reported, its kinds are not "checked". */
export async function evaluateWorkspace(admin: Admin, ws: WorkspaceRow, now: Date) {
  const candidates: AlertCandidate[] = [];
  const checked: AlertKind[] = [];
  const errors: string[] = [];
  const since = new Date(now.getTime() - SUPERVISOR.deadJobLookbackDays * 86_400_000).toISOString();
  const checks: [AlertKind[], () => Promise<AlertCandidate[]>][] = [
    [["dead_job"], async () => {
      const { data, error } = await admin.from("job").select("id, job_type, state, attempts, updated_at")
        .eq("workspace_id", ws.id).eq("state", "dead").gte("updated_at", since).order("updated_at", { ascending: false }).limit(200);
      if (error) throw error;
      return deadJobCandidates(data ?? []);
    }],
    [["backup_missed", "backup_failed", "restore_failed"], async () => {
      const { data, error } = await admin.from("backup_run").select("id, kind, status, started_at, finished_at")
        .eq("workspace_id", ws.id).order("started_at", { ascending: false }).limit(50);
      if (error) throw error;
      return backupCandidates(data ?? [], ws.created_at, now);
    }],
    [["ai_budget_80", "ai_budget_100"], async () => {
      const s = await spendSummary(admin, ws.id, Number(ws.monthly_ai_budget_inr ?? 0), now);
      return budgetCandidates(s.spentInr, s.budgetInr, s.monthStart);
    }],
    [["connector_failed", "connector_stale"], async () => {
      const [acc, cur] = await Promise.all([
        admin.from("connector_account").select("id, provider, status, created_at").eq("workspace_id", ws.id),
        admin.from("connector_cursor").select("connector_account_id, resource, last_success_at, last_attempt_at, last_error").eq("workspace_id", ws.id),
      ]);
      if (acc.error) throw acc.error;
      if (cur.error) throw cur.error;
      return connectorCandidates(acc.data ?? [], cur.data ?? [], now);
    }],
  ];
  await Promise.all(checks.map(async ([kinds, run]) => {
    try {
      candidates.push(...(await run()));
      checked.push(...kinds);
    } catch (e) {
      errors.push(`${kinds[0]}: ${e instanceof Error ? e.message : (e as any)?.message ?? String(e)}`);
    }
  }));
  return { candidates, checked, errors };
}

export async function reconcileAlerts(admin: Admin, workspaceId: string, checked: AlertKind[], candidates: AlertCandidate[]) {
  const { data, error } = await admin.schema("mudar_app").rpc("reconcile_supervisor_alerts", {
    p_workspace: workspaceId, p_checked: checked, p_alerts: candidates,
  });
  if (error) throw new Error(`reconcile_supervisor_alerts: ${error.message}`);
  return ((data ?? []) as unknown[]).map((r) => (typeof r === "string" ? r : Object.values(r as object)[0] as string));
}

const KIND_LABEL: Record<AlertKind, string> = {
  dead_job: "background jobs failed permanently", backup_missed: "backup alerts", backup_failed: "backup failures",
  restore_failed: "restore test failures", ai_budget_80: "AI budget warnings", ai_budget_100: "AI budget alerts",
  connector_failed: "connectors failing", connector_stale: "connectors stale", scheduler_gap: "scheduler gaps",
};

/**
 * Send private in-app notifications for alerts not yet notified (one per kind per pass, grouped), to every owner/admin
 * of the workspace. Idempotent: the outbox dedupe key is derived from the alert ids, and notified_at is set after.
 * Acknowledged alerts and alerts that resolved before anyone was told (except scheduler gaps) are not sent.
 */
export async function notifyPending(admin: Admin, workspaceId: string, now: Date) {
  const since = new Date(now.getTime() - SUPERVISOR.notifyWindowHours * 3_600_000).toISOString();
  const { data, error } = await admin.from("supervisor_alert").select("id, kind, severity, title, resolved_at")
    .eq("workspace_id", workspaceId).is("notified_at", null).is("acknowledged_at", null).gte("opened_at", since).order("opened_at");
  if (error) throw new Error(`supervisor_alert: ${error.message}`);
  const pending = ((data ?? []) as Row[]).filter((a) => !a.resolved_at || a.kind === "scheduler_gap");
  if (!pending.length) return 0;
  const { data: members, error: me } = await admin.from("membership").select("user_id, role").eq("workspace_id", workspaceId).in("role", ["owner", "admin"]);
  if (me) throw new Error(`membership: ${me.message}`);
  const groups = new Map<string, Row[]>();
  for (const a of pending) groups.set(a.kind, [...(groups.get(a.kind) ?? []), a]);
  let sent = 0;
  for (const [kind, alerts] of groups) {
    const ids = alerts.map((a) => a.id as string).sort();
    const critical = alerts.some((a) => a.severity === "critical");
    const title = alerts.length === 1 ? alerts[0].title : `${alerts.length} ${KIND_LABEL[kind as AlertKind] ?? kind} — e.g. ${alerts[0].title}`;
    const key = sha256(ids.join(",")).slice(0, 20);
    for (const m of (members ?? []) as Row[]) {
      await notify(admin, workspaceId, m.user_id, critical ? "urgent_alert" : "brief_alert", `sys:${kind}:${key}:${m.user_id}`, {
        title, source: "system_supervisor", alert_kind: kind, severity: critical ? "critical" : "warning", count: alerts.length, href: "/admin",
      });
      sent++;
    }
    const { error: ue } = await admin.from("supervisor_alert").update({ notified_at: now.toISOString() }).eq("workspace_id", workspaceId).in("id", ids);
    if (ue) throw new Error(`supervisor_alert notified_at: ${ue.message}`);
  }
  return sent;
}

export interface SupervisorSummary { workspaces: number; opened: number; notifications: number; checkErrors: string[] }

/**
 * One supervisor pass (called from every tick). `heartbeat` = gap since the previous tick: if > 15 min, every workspace
 * gets a scheduler_gap alert — so a stopped pg_cron is reported by the next tick that does run (at the latest the daily
 * Vercel cron at 00:30 UTC).
 */
export async function runSupervisor(admin: Admin, opts: { now?: Date; heartbeat?: { gapMinutes: number | null; prevStartedAt: string | null }; workspaceIds?: string[] } = {}): Promise<SupervisorSummary> {
  const now = opts.now ?? new Date();
  let q = admin.from("workspace").select("id, created_at, monthly_ai_budget_inr, timezone").in("status", ["active", "paused"]);
  if (opts.workspaceIds) q = q.in("id", opts.workspaceIds);
  const { data: list, error } = await q;
  if (error) throw new Error(`workspace list: ${error.message}`);
  const summary: SupervisorSummary = { workspaces: 0, opened: 0, notifications: 0, checkErrors: [] };
  for (const ws of (list ?? []) as WorkspaceRow[]) {
    try {
      const { candidates, checked, errors } = await evaluateWorkspace(admin, ws, now);
      const gap = opts.heartbeat ? gapCandidate(opts.heartbeat, ws.timezone || "Asia/Kolkata") : null;
      if (gap) candidates.push(gap);
      summary.opened += (await reconcileAlerts(admin, ws.id, checked, candidates)).length;
      summary.notifications += await notifyPending(admin, ws.id, now);
      summary.checkErrors.push(...errors.map((e) => `${ws.id}: ${e}`));
      summary.workspaces++;
    } catch (e) {
      summary.checkErrors.push(`${ws.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return summary;
}
