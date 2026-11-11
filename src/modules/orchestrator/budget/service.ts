import "server-only";
/**
 * Budgets and usage (spec §12). Usage = mudar.model_usage (AI tokens, web-search calls, transcription seconds — logged
 * by the AI gateway) + mudar.resource_usage (non-model consumption: enrichment credits, document pages, external API
 * calls, background job runs; with module / workflow / user). The workspace's existing monthly_ai_budget_inr cap in
 * the gateway still applies; these budgets add daily/monthly limits per resource / provider / module.
 *
 * When a budget is exhausted: non-critical jobs are paused (deferred to the next period, completed work preserved),
 * critical internal operations continue, authorised users are notified, admins can adjust the limit. A budget never
 * switches to another provider — the guard only answers allowed / paused for the provider that was requested.
 */
import type { Db } from "@/lib/supabase/server";
import type { Job, JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyAdmins } from "../notify/service";
import { isAny, norm, usageRowMatches } from "./rules";
import { evaluate, jobResource, type JobResource, matches, moduleOf, periodWindow, RESOURCES, UNITS, workflowResource, type BudgetRow, type BudgetState, type Period, type Resource, type Unit } from "./rules";

async function wsTz(db: Db, ws: string) {
  const { data } = await db.from("workspace").select("timezone").eq("id", ws).maybeSingle();
  return (data?.timezone as string) || "Asia/Kolkata";
}

export async function listBudgets(db: Db, ws: string): Promise<BudgetRow[]> {
  const { data, error } = await db.from("resource_budget").select("*").eq("workspace_id", ws).order("resource");
  if (error) throw error;
  return (data ?? []) as BudgetRow[];
}

/** Units consumed for one budget in its current window. */
export async function usageFor(db: Db, ws: string, b: BudgetRow, win: { start: Date; end: Date }): Promise<number> {
  const from = win.start.toISOString(), to = win.end.toISOString();
  let total = 0;
  // model_usage (gateway log)
  if (["model_tokens", "research", "transcription", "documents", "enrichment"].includes(b.resource)) {
    let q = db.from("model_usage").select("workflow, provider, estimated_usd, search_calls, audio_seconds, input_tokens, output_tokens").eq("workspace_id", ws).gte("occurred_at", from).lt("occurred_at", to);
    if (!isAny(b.provider)) q = q.eq("provider", b.provider.trim());
    const { data, error } = await q.limit(20_000);
    if (error) throw error;
    for (const r of (data ?? []) as any[]) {
      if (workflowResource(r.workflow, r.search_calls, Number(r.audio_seconds)) !== b.resource) continue;
      if (!isAny(b.module) && norm(moduleOf(r.workflow)) !== norm(b.module)) continue;
      total += b.unit === "usd" ? Number(r.estimated_usd) : b.unit === "calls" ? (b.resource === "research" ? Math.max(1, r.search_calls) : 1) : b.unit === "seconds" ? Number(r.audio_seconds) : 0;
    }
  }
  // resource_usage (non-model consumption recorded by modules / the job guard)
  // Match in code (normalised) so a budget saved as "Research"/" research "/"call" still counts rows recorded as research/calls.
  const { data: ru, error: e2 } = await db.from("resource_usage").select("resource, units, unit, module, provider").eq("workspace_id", ws).gte("occurred_at", from).lt("occurred_at", to).limit(20_000);
  if (e2) throw e2;
  for (const r of (ru ?? []) as any[]) if (usageRowMatches(b, r)) total += Number(r.units);
  return total;
}

export async function budgetStates(db: Db, ws: string, now = new Date()): Promise<BudgetState[]> {
  const tz = await wsTz(db, ws);
  const out: BudgetState[] = [];
  for (const b of await listBudgets(db, ws)) {
    if (!b.enabled) continue;
    const win = periodWindow(b.period, now, tz);
    out.push(evaluate(b, await usageFor(db, ws, b, win), win));
  }
  return out;
}

export interface GuardResult { allowed: boolean; critical: boolean; provider: string | null; exhausted: BudgetState[]; near: BudgetState[]; resumeAt: string | null; reason: string | null }

/** Ask before consuming. Exhausted + non-critical ⇒ not allowed (paused). Critical ⇒ allowed, with the state reported. */
export async function checkBudget(admin: Db, ws: string, r: { resource: Resource; provider?: string | null; module?: string | null; critical?: boolean; now?: Date }): Promise<GuardResult> {
  const now = r.now ?? new Date();
  const tz = await wsTz(admin, ws);
  const budgets = (await listBudgets(admin, ws)).filter((b) => matches(b, r));
  const exhausted: BudgetState[] = [], near: BudgetState[] = [];
  for (const b of budgets) {
    const win = periodWindow(b.period, now, tz);
    const st = evaluate(b, await usageFor(admin, ws, b, win), win);
    if (st.status === "exhausted") exhausted.push(st); else if (st.status === "near") near.push(st);
  }
  const critical = !!r.critical;
  const allowed = !exhausted.length || critical;
  const resumeAt = exhausted.length ? exhausted.map((e) => e.resetsAt).sort().reverse()[0] : null;
  return {
    allowed, critical, provider: r.provider ?? null, exhausted, near, resumeAt,
    reason: exhausted.length ? `${exhausted.map((e) => `${e.budget.resource}${e.budget.module !== "*" ? `/${e.budget.module}` : ""} ${e.budget.period} budget used (${e.used}/${e.limit} ${e.budget.unit})`).join("; ")}${critical ? " — critical operation continues" : " — paused until the budget resets or an admin raises it"}` : null,
  };
}

/** Record non-model consumption (idempotent by dedupeKey). */
export async function recordUsage(admin: Db, ws: string, u: { resource: Resource; module: string; units: number; unit: Unit; provider?: string; workflow?: string | null; userId?: string | null; jobId?: string | null; dedupeKey?: string | null; at?: Date }) {
  const row = { workspace_id: ws, resource: u.resource, module: u.module, units: u.units, unit: u.unit, provider: u.provider ?? "internal", workflow: u.workflow ?? null, user_id: u.userId ?? null, job_id: u.jobId ?? null, dedupe_key: u.dedupeKey ?? null, occurred_at: (u.at ?? new Date()).toISOString() };
  const { error } = u.dedupeKey
    ? await admin.from("resource_usage").upsert(row, { onConflict: "workspace_id,dedupe_key", ignoreDuplicates: true })
    : await admin.from("resource_usage").insert(row);
  if (error) throw error;
}

/** Hourly: alert admins when usage approaches (alert_pct) or reaches the limit — once per budget per period per level. */
export async function budgetAlerts(admin: Db, ws: string, now = new Date()) {
  let sent = 0;
  for (const st of await budgetStates(admin, ws, now)) {
    if (st.status === "ok") continue;
    const b = st.budget;
    const label = `${b.resource.replace(/_/g, " ")}${b.module !== "*" ? ` (${b.module})` : ""}${b.provider !== "*" ? ` via ${b.provider}` : ""}`;
    const res = await notifyAdmins(admin, ws, {
      category: "budget", eventKey: `budget:${b.id}:${st.periodKey}:${st.status}`, severity: st.status === "exhausted" ? "urgent" : "info",
      title: st.status === "exhausted" ? `${label} ${b.period} budget exhausted — non-critical work paused` : `${label} ${b.period} budget at ${st.pct}%`,
      body: `${st.used} of ${st.limit} ${b.unit} used; resets ${st.resetsAt}. No other provider is used.`, href: "/automation?view=budgets", now,
    });
    sent += res.filter((r) => r.created).length;
  }
  return { sent };
}

/**
 * Wrap job handlers with the budget guard. Unmapped job types pass straight through (no DB call). A paused job is
 * re-queued for when the budget resets (dedupe per original job) and completes with a `paused` result — completed
 * work is never undone. Each budgeted run is counted as `jobs` usage (background job execution tracking).
 */
export function guardHandlers(handlers: Record<string, JobHandler>, adminFactory: () => Db = createAdminClient, resolve: (type: string) => JobResource | null = jobResource): Record<string, JobHandler> {
  const out: Record<string, JobHandler> = {};
  for (const [type, h] of Object.entries(handlers)) {
    const spec = resolve(type);
    out[type] = !spec ? h : async (job: Job) => {
      if (!job.workspace_id) return h(job);
      const admin = adminFactory();
      const g = await checkBudget(admin, job.workspace_id, { resource: spec.resource, module: spec.module, critical: spec.critical });
      if (!g.allowed) return pauseJob(admin, job, g);
      const result = await h(job);
      await recordUsage(admin, job.workspace_id, { resource: "jobs", module: spec.module, units: 1, unit: "runs", workflow: type, jobId: job.id, dedupeKey: `job:${job.id}:${job.attempts}` }).catch(() => undefined);
      return result;
    };
  }
  return out;
}

export async function pauseJob(admin: Db, job: Job, g: GuardResult) {
  const resumeAt = g.resumeAt ? new Date(g.resumeAt) : new Date(Date.now() + 3600e3);
  const root = (job.payload as any)?._budgetDeferredFrom ?? job.id;
  await enqueue({ workspaceId: job.workspace_id, type: job.job_type, payload: { ...job.payload, _budgetDeferredFrom: root }, dueAt: resumeAt, dedupeKey: `budget-deferred:${root}:${resumeAt.toISOString().slice(0, 13)}`, maxAttempts: 3 });
  await notifyAdmins(admin, job.workspace_id!, {
    category: "budget", eventKey: `budget_paused:${g.exhausted.map((e) => `${e.budget.id}:${e.periodKey}`).join(",")}`, severity: "urgent",
    title: "Non-critical background work paused — budget exhausted", body: g.reason ?? undefined, href: "/automation?view=budgets",
  });
  return { paused: "budget_exhausted", reason: g.reason, resumeAt: resumeAt.toISOString(), provider: g.provider };
}

export class BudgetError extends Error {}

/** Admin adjust (user client; RLS = admin). */
export async function setBudget(db: Db, ws: string, userId: string, b: { resource: string; provider?: string; module?: string; period: string; limitUnits: number; unit: string; alertPct?: number; enabled?: boolean }) {
  if (!(RESOURCES as readonly string[]).includes(b.resource)) throw new BudgetError("Unknown resource.");
  if (!(UNITS as readonly string[]).includes(b.unit)) throw new BudgetError("Unknown unit.");
  if (b.period !== "daily" && b.period !== "monthly") throw new BudgetError("Period must be daily or monthly.");
  if (!(Number.isFinite(b.limitUnits) && b.limitUnits >= 0)) throw new BudgetError("Limit must be zero or more.");
  const { data, error } = await db.from("resource_budget").upsert({
    workspace_id: ws, resource: b.resource, provider: b.provider?.trim() || "*", module: b.module?.trim() || "*", period: b.period as Period, limit_units: b.limitUnits, unit: b.unit,
    alert_pct: b.alertPct ?? 80, enabled: b.enabled ?? true, updated_by: userId, updated_at: new Date().toISOString(),
  }, { onConflict: "workspace_id,resource,provider,module,period" }).select("*").single();
  if (error) throw error;
  return data;
}

/** Usage report for admins: by module, by workflow and (where recorded) by user for the current month. */
export async function usageReport(db: Db, ws: string, now = new Date()) {
  const tz = await wsTz(db, ws);
  const win = periodWindow("monthly", now, tz);
  const [{ data: mu }, { data: ru }] = await Promise.all([
    db.from("model_usage").select("workflow, provider, estimated_usd, search_calls, audio_seconds").eq("workspace_id", ws).gte("occurred_at", win.start.toISOString()).lt("occurred_at", win.end.toISOString()).limit(20_000),
    db.from("resource_usage").select("resource, module, workflow, user_id, units, unit").eq("workspace_id", ws).gte("occurred_at", win.start.toISOString()).lt("occurred_at", win.end.toISOString()).limit(20_000),
  ]);
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  const byModuleUsd = new Map<string, number>(), byWorkflowUsd = new Map<string, number>(), byResource = new Map<string, number>(), byUser = new Map<string, number>();
  for (const r of (mu ?? []) as any[]) { add(byModuleUsd, moduleOf(r.workflow), Number(r.estimated_usd)); add(byWorkflowUsd, r.workflow, Number(r.estimated_usd)); add(byResource, `${workflowResource(r.workflow, r.search_calls, Number(r.audio_seconds))}:usd`, Number(r.estimated_usd)); }
  for (const r of (ru ?? []) as any[]) { add(byResource, `${r.resource}:${r.unit}`, Number(r.units)); if (r.user_id) add(byUser, `${r.user_id}:${r.resource}:${r.unit}`, Number(r.units)); }
  const obj = (m: Map<string, number>) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v * 10_000) / 10_000]));
  return { month: win.key, byModuleUsd: obj(byModuleUsd), byWorkflowUsd: obj(byWorkflowUsd), byResource: obj(byResource), byUser: obj(byUser), note: "AI usage is logged per workflow, not per user (gateway log has no user column); per-user figures cover recorded non-model usage." };
}
