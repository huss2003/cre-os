/**
 * Budget rules (pure, spec §12): which resource a job / AI workflow consumes, whether it is critical, period windows.
 * Budgets only ever ALLOW or PAUSE work on the configured provider — they never select another provider.
 */
import { atLocal, localDate } from "@/lib/util/time";
import { addDays } from "@/modules/brief/dates";

export const RESOURCES = ["model_tokens", "research", "enrichment", "transcription", "documents", "external_api", "jobs"] as const;
export type Resource = (typeof RESOURCES)[number];
export const UNITS = ["usd", "calls", "credits", "seconds", "pages", "runs"] as const;
export type Unit = (typeof UNITS)[number];
export type Period = "daily" | "monthly";

export interface JobResource { resource: Resource; module: string; critical: boolean }

/**
 * Background job → resource. Critical = user-facing or internal operations that must continue when a budget is
 * exhausted (briefs, meetings, captures the user submitted, approvals, the orchestrator itself, admin).
 * Unknown job types are not budget-guarded.
 */
const JOB_MAP: [RegExp, Resource, boolean][] = [
  [/^intelligence\.(research|research_org|patrol|strategy)$/, "research", false],
  [/^signals\.scan$/, "research", false],
  [/^contacts\.reverify$/, "enrichment", false],
  [/^capture\.document$/, "documents", true],
  [/^capture\.process$/, "transcription", true],
  [/^(scoring\.bulk|deals\.rematch|imports\.steward_stale|tutorials\.sync)$/, "jobs", false],
];
export function jobResource(jobType: string): JobResource | null {
  for (const [re, resource, critical] of JOB_MAP) if (re.test(jobType)) return { resource, module: jobType.split(".")[0], critical };
  return null;
}

/** AI workflow name (model_usage.workflow) → resource. */
export function workflowResource(workflow: string, searchCalls = 0, audioSeconds = 0): Resource {
  if (workflow === "transcribe" || audioSeconds > 0) return "transcription";
  if (searchCalls > 0 || /^(research\.|signals\.(research|discover)|assistant\.web_research)/.test(workflow)) return "research";
  if (/^contacts\.enrich/.test(workflow)) return "enrichment";
  if (/(ocr|document|legal\.extract|lease_terms)/.test(workflow)) return "documents";
  return "model_tokens";
}
export const moduleOf = (workflow: string) => workflow.split(".")[0];

/** [start, end) of the current period in the workspace timezone, plus a stable key. */
export function periodWindow(period: Period, now: Date, tz: string): { start: Date; end: Date; key: string } {
  const today = localDate(now, tz);
  if (period === "daily") return { start: atLocal(today, "00:00", tz), end: atLocal(addDays(today, 1), "00:00", tz), key: today };
  const [y, m] = today.split("-").map(Number);
  const first = `${y}-${String(m).padStart(2, "0")}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { start: atLocal(first, "00:00", tz), end: atLocal(next, "00:00", tz), key: first.slice(0, 7) };
}

export interface BudgetRow { id: string; resource: Resource; provider: string; module: string; period: Period; limit_units: number | string; unit: Unit; alert_pct: number; enabled: boolean }
export interface BudgetState { budget: BudgetRow; used: number; limit: number; pct: number; status: "ok" | "near" | "exhausted"; periodKey: string; resetsAt: string }

export function evaluate(b: BudgetRow, used: number, win: { key: string; end: Date }): BudgetState {
  const limit = Number(b.limit_units);
  const pct = limit > 0 ? Math.round((used / limit) * 1000) / 10 : used > 0 ? 100 : 0;
  const status = used >= limit ? "exhausted" : pct >= b.alert_pct ? "near" : "ok";
  return { budget: b, used: Math.round(used * 10_000) / 10_000, limit, pct, status, periodKey: win.key, resetsAt: win.end.toISOString() };
}

/** Does a budget apply to this consumption? '*' matches anything. */
export function matches(b: Pick<BudgetRow, "resource" | "provider" | "module" | "enabled">, r: { resource: Resource; provider?: string | null; module?: string | null }) {
  return b.enabled && b.resource === r.resource && (b.provider === "*" || b.provider === (r.provider ?? "")) && (b.module === "*" || b.module === (r.module ?? ""));
}

export const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
export const normUnit = (v: unknown) => { const u = norm(v); return u === "call" ? "calls" : u === "credit" ? "credits" : u === "page" ? "pages" : u === "run" ? "runs" : u === "second" ? "seconds" : u; };
export const isAny = (v: unknown) => { const n = norm(v); return n === "" || n === "*"; };
/** Does a resource_usage row count against this budget? (wildcards: "*" or blank). */
export function usageRowMatches(b: { resource: string; unit: string; module: string; provider: string }, r: { resource: string; unit: string; module?: string | null; provider?: string | null }) {
  return norm(r.resource) === norm(b.resource) && normUnit(r.unit) === normUnit(b.unit)
    && (isAny(b.module) || norm(r.module) === norm(b.module)) && (isAny(b.provider) || norm(r.provider) === norm(b.provider));
}

