import type { Db } from "@/lib/supabase/server";

export type ExecStatus = "queued" | "running" | "waiting_dependency" | "waiting_approval" | "partially_completed"
  | "completed" | "failed" | "cancelled" | "paused";
export type DefStatus = "draft" | "active" | "paused";
export type StepState = "queued" | "running" | "waiting_dependency" | "waiting_approval" | "done" | "skipped" | "failed" | "cancelled" | "dead";
export type TriggerType = "event" | "schedule" | "user" | "condition";
export type ErrorClass = "temporary" | "permanent";

export interface Ref { type: string; id: string; label?: string }
export interface RetryConfig { maxAttempts: number; baseMs: number; maxMs: number }

export interface StepCtx {
  db: Db; ws: string; runId: string; stepKey: string; attempt: number; now: Date;
  input: Record<string, any>;
  /** Outputs of completed steps (by step key). */
  outputs: Record<string, any>;
  actor: string | null;
  /** Stable per (execution, step): pass to downstream services so a retried step never duplicates rows. */
  idempotencyKey: string;
}
export interface StepOutcome { status: "done" | "skipped" | "waiting_approval"; reason: string; refs?: Ref[]; output?: unknown }

export interface StepDef {
  key: string; label: string; module: string;
  dependsOn?: string[];
  /** false or a string (skip reason) → step skipped. */
  condition?: (c: StepCtx) => boolean | string;
  run: (c: StepCtx) => Promise<StepOutcome>;
  retry?: Partial<RetryConfig>;
  timeoutMs?: number;
  /** Consequential steps are never retried automatically after a temporary failure (spec §11.1). */
  consequential?: boolean;
}

export interface WorkflowDefinition {
  key: string; name: string; description: string; module: string;
  trigger: { type: TriggerType; events?: string[]; everyMinutes?: number; config?: Record<string, unknown> };
  steps: StepDef[];
  permissions?: { role: "viewer" | "editor" | "admin" };
  approvals?: string[];
  retry?: Partial<RetryConfig>;
  timeoutMs?: number;
  priority?: number;
  inputs?: string[];
}

export const DEFAULT_RETRY: RetryConfig = { maxAttempts: 4, baseMs: 60_000, maxMs: 6 * 3600_000 };
export const FINAL: ExecStatus[] = ["completed", "failed", "cancelled"];
