import type { SupabaseClient } from "@supabase/supabase-js";
import { AiUnavailableError } from "@/lib/ai/gateway";
import { PRICING } from "@/lib/ai/pricing";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasRole, type Role } from "@/lib/auth/context";
import { estimateUsd } from "../engine/provider";

/**
 * AI usage & budget (Module 12 round 2, item 13). All maths here is deterministic code (S5).
 * Budget lives where the gateway already reads it: workspace.monthly_ai_budget_inr (+ workspace.ai_paused).
 * Months and days follow IST, like gateway.monthSpendUsd.
 */
type Db = SupabaseClient<any, any, any>;
export interface UsageRow { occurred_at: string; workflow: string; model: string; input_tokens: number; output_tokens: number; estimated_usd: number | string; request_id: string | null; ok?: boolean }
export interface RunRow { id: string; conversation_id: string | null; intent: string | null; model_route: string | null; owner_user_id: string | null; request: string; created_at: string; usage: Record<string, unknown> | null }
export interface Slice { key: string; usd: number; calls: number }
export interface TopRun { runId: string; conversationId: string | null; request: string; intent: string | null; route: string | null; usd: number; at: string }
export type Level = 0 | 80 | 100;
export interface UsageSummary {
  todayUsd: number; monthUsd: number; projectedUsd: number; monthStart: string;
  budgetInr: number; budgetUsd: number; pct: number | null; level: Level; paused: boolean;
  byDay: { date: string; usd: number }[];
  byIntent: Slice[]; byRoute: Slice[]; byUser: Slice[]; byWorkflow: Slice[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheReadShare: number; savedByCacheUsd: number };
  topRuns: TopRun[];
}

export class UsageError extends Error { constructor(public status: number, m: string) { super(m); } }

const IST_MS = 330 * 60_000;
const DAY = 86_400_000;
/** yyyy-mm-dd in IST. */
export const istDate = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
/** UTC instant of 00:00 IST on the 1st of the IST month containing `now`. */
export function istMonthStart(now: Date): Date {
  const ist = new Date(now.getTime() + IST_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_MS);
}
function daysInIstMonth(now: Date) {
  const ist = new Date(now.getTime() + IST_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 0)).getUTCDate();
}
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
export function levelFor(pct: number | null): Level { return pct == null ? 0 : pct >= 100 ? 100 : pct >= 80 ? 80 : 0; }

function slices(m: Map<string, Slice>): Slice[] {
  return [...m.values()].map((s) => ({ ...s, usd: r6(s.usd) })).sort((a, b) => b.usd - a.usd || a.key.localeCompare(b.key));
}
function add(m: Map<string, Slice>, key: string, usd: number) {
  const s = m.get(key) ?? { key, usd: 0, calls: 0 }; s.usd += usd; s.calls += 1; m.set(key, s);
}

/** Pure aggregation over model_usage rows (+ assistant runs for intent/route/user/cache). */
export function aggregateUsage(rows: UsageRow[], runs: RunRow[], now: Date, budgetInr: number, paused = false): UsageSummary {
  const monthStart = istMonthStart(now), today = istDate(now);
  const runById = new Map(runs.map((r) => [r.id, r]));
  const days: string[] = []; for (let i = 29; i >= 0; i--) days.push(istDate(new Date(now.getTime() - i * DAY)));
  const dayUsd = new Map(days.map((d) => [d, 0]));
  const byIntent = new Map<string, Slice>(), byRoute = new Map<string, Slice>(), byUser = new Map<string, Slice>(), byWorkflow = new Map<string, Slice>();
  const runUsd = new Map<string, number>(), runModel = new Map<string, string>();
  let todayUsd = 0, monthUsd = 0, input = 0, output = 0;
  for (const r of rows) {
    const usd = Number(r.estimated_usd) || 0, at = new Date(r.occurred_at), d = istDate(at);
    if (dayUsd.has(d)) dayUsd.set(d, dayUsd.get(d)! + usd);
    if (d === today) todayUsd += usd;
    if (at < monthStart) continue;
    // Breakdowns, tokens and top runs cover the current month.
    monthUsd += usd; input += r.input_tokens || 0; output += r.output_tokens || 0;
    add(byWorkflow, r.workflow, usd);
    const run = r.request_id ? runById.get(r.request_id) : undefined;
    if (r.workflow.startsWith("assistant.") && run) {
      add(byIntent, run.intent ?? "unclassified", usd);
      add(byRoute, run.model_route ?? r.workflow.slice(10), usd);
      runUsd.set(run.id, (runUsd.get(run.id) ?? 0) + usd);
      if (!runModel.has(run.id)) runModel.set(run.id, r.model);
    } else if (/^assistant\.(fast|deep)$/.test(r.workflow)) add(byRoute, r.workflow.slice(10), usd);
    add(byUser, run?.owner_user_id ?? "system", usd);
  }
  let cacheRead = 0, cacheWrite = 0, saved = 0;
  for (const run of runs) {
    if (new Date(run.created_at) < monthStart) continue;
    const u = run.usage ?? {};
    const cr = Number(u.cacheRead ?? u.cache_read ?? 0) || 0, cw = Number(u.cacheWrite ?? u.cache_write ?? 0) || 0;
    if (!cr && !cw) continue;
    cacheRead += cr; cacheWrite += cw;
    const model = runModel.get(run.id) ?? "claude-haiku";
    // Saved = what those prompt tokens would cost uncached minus what they cost with caching (write premium included).
    saved += estimateUsd(model, cr + cw, 0) - estimateUsd(model, 0, 0, 0, cw, cr);
  }
  const elapsedDays = Math.max((now.getTime() - monthStart.getTime()) / DAY, 1 / 24);
  const projectedUsd = r6((monthUsd / elapsedDays) * daysInIstMonth(now));
  const budgetUsd = budgetInr > 0 ? budgetInr / PRICING.fxInrPerUsd : 0;
  const pct = budgetUsd > 0 ? (monthUsd / budgetUsd) * 100 : null;
  const topRuns = [...runUsd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, usd]) => {
    const run = runById.get(id)!;
    return { runId: id, conversationId: run.conversation_id, request: run.request.slice(0, 140), intent: run.intent, route: run.model_route, usd: r6(usd), at: run.created_at };
  });
  return {
    todayUsd: r6(todayUsd), monthUsd: r6(monthUsd), projectedUsd, monthStart: monthStart.toISOString(),
    budgetInr, budgetUsd: r6(budgetUsd), pct: pct == null ? null : Math.round(pct * 10) / 10, level: levelFor(pct), paused,
    byDay: days.map((d) => ({ date: d, usd: r6(dayUsd.get(d)!) })),
    byIntent: slices(byIntent), byRoute: slices(byRoute), byUser: slices(byUser), byWorkflow: slices(byWorkflow),
    tokens: { input, output, cacheRead, cacheWrite, cacheReadShare: input > 0 ? Math.round((cacheRead / input) * 1000) / 10 : 0, savedByCacheUsd: r6(saved) },
    topRuns,
  };
}

async function fetchAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

/** Loads + aggregates for one workspace. `db` is the user's RLS client (model_usage is admin-only under RLS). */
export async function loadUsage(db: Db, workspaceId: string, now = new Date()): Promise<UsageSummary> {
  const since = new Date(Math.min(istMonthStart(now).getTime(), now.getTime() - 30 * DAY)).toISOString();
  const [rows, runs, ws] = await Promise.all([
    fetchAll<UsageRow>((a, b) => db.from("model_usage").select("occurred_at, workflow, model, input_tokens, output_tokens, estimated_usd, request_id, ok")
      .eq("workspace_id", workspaceId).gte("occurred_at", since).order("id").range(a, b)),
    fetchAll<RunRow>((a, b) => db.from("assistant_run").select("id, conversation_id, intent, model_route, owner_user_id, request, created_at, usage")
      .eq("workspace_id", workspaceId).gte("created_at", since).order("id").range(a, b)),
    db.from("workspace").select("ai_paused, monthly_ai_budget_inr").eq("id", workspaceId).single(),
  ]);
  return aggregateUsage(rows, runs, now, Number(ws.data?.monthly_ai_budget_inr ?? 0), !!ws.data?.ai_paused);
}

/** Month-to-date spend vs budget (service role; workspace filtered explicitly — S2). */
export async function budgetStatus(workspaceId: string, now = new Date(), admin: Db = createAdminClient()) {
  const { data: ws } = await admin.from("workspace").select("ai_paused, monthly_ai_budget_inr").eq("id", workspaceId).single();
  const rows = await fetchAll<{ estimated_usd: number | string }>((a, b) => admin.from("model_usage").select("estimated_usd")
    .eq("workspace_id", workspaceId).gte("occurred_at", istMonthStart(now).toISOString()).order("id").range(a, b));
  const spentUsd = rows.reduce((s, r) => s + (Number(r.estimated_usd) || 0), 0);
  const budgetInr = Number(ws?.monthly_ai_budget_inr ?? 0);
  const budgetUsd = budgetInr > 0 ? budgetInr / PRICING.fxInrPerUsd : 0;
  const pct = budgetUsd > 0 ? (spentUsd / budgetUsd) * 100 : null;
  return { paused: !!ws?.ai_paused, spentUsd: r6(spentUsd), budgetInr, budgetUsd: r6(budgetUsd), pct, level: levelFor(pct), month: istDate(istMonthStart(now)).slice(0, 7) };
}

/**
 * Same rule as gateway.guard() (not exported there). The assistant engine must call this before every provider call:
 * kill switch → "paused"; month-to-date spend ≥ budget → "budget_exceeded".
 */
export async function assertAssistantBudget(workspaceId: string, now = new Date()): Promise<void> {
  const s = await budgetStatus(workspaceId, now);
  if (s.paused) throw new AiUnavailableError("paused", "AI paused for workspace (kill switch)");
  if (s.budgetUsd > 0 && s.spentUsd >= s.budgetUsd) throw new AiUnavailableError("budget_exceeded", `AI budget reached (${s.spentUsd.toFixed(2)} USD)`);
}

/** Owner-only: set the monthly AI budget (INR). 0 = no cap. Writes the column the gateway enforces. */
export async function setMonthlyBudget(ctx: { db: Db; workspaceId: string; role: Role }, budgetInr: number) {
  if (!hasRole(ctx, "owner")) throw new UsageError(403, "Only the workspace owner can change the AI budget.");
  if (!Number.isFinite(budgetInr) || budgetInr < 0 || budgetInr > 10_000_000) throw new UsageError(400, "Budget must be between ₹0 and ₹1,00,00,000.");
  const value = Math.round(budgetInr * 100) / 100;
  const { data, error } = await ctx.db.from("workspace").update({ monthly_ai_budget_inr: value }).eq("id", ctx.workspaceId).select("monthly_ai_budget_inr");
  if (error) throw error;
  if (!data?.length) throw new UsageError(403, "Only the workspace owner can change the AI budget.");
  return { budgetInr: value };
}

export const thresholdKey = (threshold: 80 | 100, month: string) => `assistant.usage:${threshold}:${month}`;

/**
 * Creates one owner task per threshold per month (dedupe = task.idempotency_key, unique per workspace).
 * Returns the thresholds newly notified.
 */
export async function checkThresholds(workspaceId: string, now = new Date(), admin: Db = createAdminClient()): Promise<{ level: Level; created: number[] }> {
  const s = await budgetStatus(workspaceId, now, admin);
  const created: number[] = [];
  if (s.level === 0) return { level: 0, created };
  const { data: owners } = await admin.from("membership").select("user_id").eq("workspace_id", workspaceId).eq("role", "owner").limit(1);
  const owner = owners?.[0]?.user_id ?? null;
  for (const t of [80, 100] as const) {
    if (s.level < t) continue;
    const key = thresholdKey(t, s.month);
    const { data: existing } = await admin.from("task").select("id").eq("workspace_id", workspaceId).eq("idempotency_key", key).maybeSingle();
    if (existing) continue;
    const pct = Math.floor(s.pct ?? 0);
    const { error } = await admin.from("task").insert({
      workspace_id: workspaceId, owner_user_id: owner, assigned_user_id: owner, idempotency_key: key, source: "assistant.usage",
      priority: t === 100 ? 90 : 70, due_at: now.toISOString(), classification: "corporate_confidential",
      title: t === 100 ? `AI budget used up for ${s.month} — AI features are stopped until you raise it` : `AI spend has reached ${pct}% of this month's budget`,
      description: `Spent about ₹${Math.round(s.spentUsd * PRICING.fxInrPerUsd)} of ₹${s.budgetInr} in ${s.month}. Review or change the budget at /assistant/usage.`,
    });
    if (error && (error as { code?: string }).code !== "23505") throw error;
    if (!error) created.push(t);
  }
  return { level: s.level, created };
}
