/** Pure helpers: errors, backoff, dependency ordering, status derivation. No I/O. */
import type { ErrorClass, ExecStatus, RetryConfig, StepDef, StepState } from "./types";

export class TemporaryError extends Error { readonly errorClass = "temporary" as const }
export class PermanentError extends Error { readonly errorClass = "permanent" as const }

const TEMP_PATTERNS = /(timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|fetch failed|rate limit|too many requests|\b429\b|\b502\b|\b503\b|\b504\b|temporarily|unavailable|overloaded|deadlock|could not serialize)/i;

/** Temporary = worth retrying (network, provider 429/5xx, timeouts). Everything else is permanent (validation, permissions, missing data). */
export function classifyError(e: unknown): ErrorClass {
  if (e instanceof TemporaryError) return "temporary";
  if (e instanceof PermanentError) return "permanent";
  const status = typeof e === "object" && e && "status" in e ? Number((e as { status: unknown }).status) : NaN;
  if (status === 429 || (status >= 500 && status < 600)) return "temporary";
  if (status >= 400 && status < 500) return "permanent";
  return TEMP_PATTERNS.test(e instanceof Error ? e.message : String(e)) ? "temporary" : "permanent";
}

/** Exponential backoff: base × 2^(attempt-1), capped. attempt is 1-based (the attempt that just failed). */
export function backoffMs(attempt: number, cfg: Pick<RetryConfig, "baseMs" | "maxMs">): number {
  return Math.min(cfg.maxMs, cfg.baseMs * 2 ** Math.max(0, attempt - 1));
}

/** Validate a step graph: unknown dependencies and cycles throw. Returns keys in dependency waves. */
export function planWaves(steps: Pick<StepDef, "key" | "dependsOn">[]): string[][] {
  const keys = new Set(steps.map((s) => s.key));
  if (keys.size !== steps.length) throw new Error("duplicate step key");
  for (const s of steps) for (const d of s.dependsOn ?? []) if (!keys.has(d)) throw new Error(`step ${s.key} depends on unknown step ${d}`);
  const done = new Set<string>(); const waves: string[][] = [];
  while (done.size < steps.length) {
    const wave = steps.filter((s) => !done.has(s.key) && (s.dependsOn ?? []).every((d) => done.has(d))).map((s) => s.key);
    if (!wave.length) throw new Error("dependency cycle");
    wave.forEach((k) => done.add(k)); waves.push(wave);
  }
  return waves;
}

export interface StepRow { step_key: string; status: StepState; depends_on: string[]; error_class: ErrorClass | null; attempts: number; max_attempts: number; next_attempt_at: string | null }

const SATISFIED: StepState[] = ["done", "skipped"];
export const isTerminalFailure = (s: StepRow) => s.status === "dead" || (s.status === "failed" && s.error_class === "permanent");

/** Steps that may run now: prerequisites satisfied and (pending, or a temporary failure whose backoff has elapsed). */
export function readySteps(rows: StepRow[], now: Date): StepRow[] {
  const by = new Map(rows.map((r) => [r.step_key, r]));
  return rows.filter((r) => {
    const depsOk = r.depends_on.every((d) => SATISFIED.includes(by.get(d)?.status as StepState));
    if (!depsOk) return false;
    if (r.status === "queued" || r.status === "waiting_dependency" || r.status === "waiting_approval") return true;
    return r.status === "failed" && r.error_class === "temporary" && r.next_attempt_at !== null && Date.parse(r.next_attempt_at) <= +now;
  });
}

/** Execution status from its steps (spec §3 states). Partial completion stays visible until resolved. */
export function deriveStatus(rows: StepRow[]): { status: ExecStatus; nextAttemptAt: string | null; progress: number } {
  const total = rows.length || 1;
  const ok = rows.filter((r) => SATISFIED.includes(r.status)).length;
  const progress = Math.round((ok / total) * 100);
  const retries = rows.filter((r) => r.status === "failed" && r.error_class === "temporary" && r.next_attempt_at).map((r) => r.next_attempt_at!).sort();
  if (rows.some((r) => r.status === "cancelled") && ok < total && !rows.some((r) => r.status === "failed" || r.status === "dead")) return { status: "cancelled", nextAttemptAt: null, progress };
  if (ok === rows.length) return { status: "completed", nextAttemptAt: null, progress: 100 };
  const failed = rows.some((r) => r.status === "failed" || r.status === "dead");
  if (failed) return { status: ok > 0 ? "partially_completed" : retries.length ? "queued" : "failed", nextAttemptAt: retries[0] ?? null, progress };
  if (rows.some((r) => r.status === "waiting_approval")) return { status: "waiting_approval", nextAttemptAt: null, progress };
  if (rows.some((r) => r.status === "queued" || r.status === "running")) return { status: "queued", nextAttemptAt: null, progress };
  return { status: "waiting_dependency", nextAttemptAt: null, progress };
}
