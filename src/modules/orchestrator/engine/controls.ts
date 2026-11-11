import "server-only";
import type { Db } from "@/lib/supabase/server";
import { audit } from "./audit";
import { definition, ensureDefinitionRow, registeredWorkflows } from "./registry";
import { startExecution } from "./runner";
import { FINAL, type ExecStatus, type Ref } from "./types";

type Row = Record<string, any>;

async function load(db: Db, ws: string, runId: string): Promise<Row> {
  const { data } = await db.from("workflow_run").select("*").eq("workspace_id", ws).eq("id", runId).maybeSingle();
  if (!data) throw new Error("Execution not found.");
  if (data.kind !== "orchestrated") throw new Error("Only orchestrated executions can be controlled here.");
  return data as Row;
}
async function flip(db: Db, run: Row, patch: Row) {
  const { data, error } = await db.from("workflow_run").update(patch).eq("id", run.id).eq("row_version", run.row_version).select("id").maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("The execution changed meanwhile; reload and try again.");
}

export async function pauseExecution(db: Db, ws: string, runId: string, actor: string | null = null) {
  const run = await load(db, ws, runId);
  if (FINAL.includes(run.status) || run.status === "paused") throw new Error(`Cannot pause an execution that is ${run.status}.`);
  await flip(db, run, { status: "paused", paused_from: run.status === "running" ? "queued" : run.status });
  await audit(db, ws, { runId, key: run.definition_key, action: "paused", actor });
}
export async function resumeExecution(db: Db, ws: string, runId: string, actor: string | null = null) {
  const run = await load(db, ws, runId);
  if (run.status !== "paused") throw new Error("Only a paused execution can be resumed.");
  await flip(db, run, { status: run.paused_from ?? "queued", paused_from: null, next_attempt_at: new Date().toISOString() });
  await audit(db, ws, { runId, key: run.definition_key, action: "resumed", actor });
}
/** Cancel: pending steps become cancelled; completed steps and their outputs stay (history is never deleted). */
export async function cancelExecution(db: Db, ws: string, runId: string, actor: string | null = null) {
  const run = await load(db, ws, runId);
  if (FINAL.includes(run.status)) throw new Error(`Execution already ${run.status}.`);
  await flip(db, run, { status: "cancelled", finished_at: new Date().toISOString(), next_attempt_at: null });
  await db.from("workflow_step").update({ status: "cancelled", next_attempt_at: null }).eq("workspace_id", ws).eq("run_id", runId).in("status", ["queued", "waiting_dependency", "waiting_approval", "failed"]);
  await audit(db, ws, { runId, key: run.definition_key, action: "cancelled", actor });
}
/** Retry failed/dead steps only (done steps keep their results); the execution is queued again. */
export async function retryExecution(db: Db, ws: string, runId: string, actor: string | null = null) {
  const run = await load(db, ws, runId);
  if (!["failed", "partially_completed", "queued"].includes(run.status)) throw new Error(`Nothing to retry in a ${run.status} execution.`);
  const { data: steps } = await db.from("workflow_step").select("id, step_key, attempts, max_attempts").eq("workspace_id", ws).eq("run_id", runId).in("status", ["failed", "dead"]);
  for (const s of (steps ?? []) as Row[]) {
    await db.from("workflow_step").update({ status: "queued", error_class: null, next_attempt_at: null, max_attempts: Math.max(s.max_attempts ?? 1, (s.attempts ?? 0) + 1) }).eq("id", s.id);
  }
  const def = definition(run.definition_key);
  await flip(db, run, { status: "queued", finished_at: null, error: null, next_attempt_at: new Date().toISOString(), timeout_at: def.timeoutMs ? new Date(Date.now() + def.timeoutMs).toISOString() : null });
  await audit(db, ws, { runId, key: run.definition_key, action: "manual_retry", actor, detail: { steps: (steps ?? []).map((s: Row) => s.step_key) } });
  return { retried: (steps ?? []).length };
}
export async function changePriority(db: Db, ws: string, runId: string, priority: number, actor: string | null = null) {
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) throw new Error("Priority must be 0–100.");
  const run = await load(db, ws, runId);
  await flip(db, run, { priority });
  await audit(db, ws, { runId, key: run.definition_key, action: "priority_changed", actor, detail: { from: run.priority, to: priority } });
}

// ------------------------------------------------------------------ read side

export async function listExecutions(db: Db, ws: string, f: { status?: ExecStatus | ExecStatus[]; key?: string; limit?: number } = {}) {
  let q = db.from("workflow_run").select("id, kind, definition_key, summary, status, priority, progress, trigger_type, subject_type, subject_id, started_at, finished_at, error, next_attempt_at, current_step")
    .eq("workspace_id", ws).eq("kind", "orchestrated");
  if (f.status) q = Array.isArray(f.status) ? q.in("status", f.status) : q.eq("status", f.status);
  if (f.key) q = q.eq("definition_key", f.key);
  const { data } = await q.order("started_at", { ascending: false }).limit(f.limit ?? 50);
  return (data ?? []) as Row[];
}

/** Spec §11.3 failure report, derived from the stored steps (never invented). */
export function failureReport(run: Row, steps: Row[]) {
  const failed = steps.filter((s) => s.status === "failed" || s.status === "dead");
  if (!failed.length) return null;
  const ok = steps.filter((s) => s.status === "done" || s.status === "skipped").map((s) => s.label);
  const willRetry = failed.some((s) => s.status === "failed" && s.error_class === "temporary" && s.next_attempt_at);
  return {
    whatFailed: failed.map((s) => ({ step: s.label, error: s.error, class: s.error_class, attempts: s.attempts })),
    affectedRecords: steps.flatMap((s) => (s.output_refs ?? []) as Ref[]),
    earlierStepsSucceeded: ok,
    mayBeStale: true,
    willRetry,
    nextAttemptAt: willRetry ? failed.map((s) => s.next_attempt_at).filter(Boolean).sort()[0] : null,
    userAction: willRetry ? "Nothing — the system retries automatically." : failed.some((s) => s.status === "dead") ? "Retries exhausted — check the error, then use Retry." : "Fix the cause shown, then use Retry.",
  };
}

export async function getExecution(db: Db, ws: string, runId: string) {
  const { data: run } = await db.from("workflow_run").select("*").eq("workspace_id", ws).eq("id", runId).maybeSingle();
  if (!run) return null;
  const [{ data: steps }, { data: log }, { data: marks }] = await Promise.all([
    db.from("workflow_step").select("*").eq("workspace_id", ws).eq("run_id", runId).order("seq"),
    db.from("workflow_audit_log").select("action, actor_user_id, actor_kind, detail, occurred_at").eq("workspace_id", ws).eq("run_id", runId).order("id").limit(500),
    db.from("reassessment_mark").select("id, entity_type, entity_id, mark, reason, state").eq("workspace_id", ws).eq("run_id", runId).limit(200),
  ]);
  return { run: run as Row, steps: (steps ?? []) as Row[], history: (log ?? []) as Row[], marks: (marks ?? []) as Row[], failure: failureReport(run, (steps ?? []) as Row[]) };
}

export async function affectedRecords(db: Db, ws: string, runId: string): Promise<Ref[]> {
  const x = await getExecution(db, ws, runId);
  if (!x) return [];
  const refs = [...x.steps.flatMap((s) => (s.output_refs ?? []) as Ref[]), ...x.marks.map((m) => ({ type: m.entity_type, id: m.entity_id, label: m.reason }))];
  const seen = new Set<string>();
  return refs.filter((r) => { const k = `${r.type}:${r.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export async function exportLog(db: Db, ws: string, runId: string) {
  return JSON.stringify(await getExecution(db, ws, runId), null, 2);
}

// ------------------------------------------------------------------ recurring workflows

/**
 * Start executions of active scheduled workflows whose next_run_at is due. Paused definitions start nothing.
 * One execution per (workflow, slot) via dedupe key, so overlapping ticks never double-run.
 */
export async function startDueScheduled(db: Db, ws: string, now = new Date()) {
  const started: string[] = [];
  for (const def of registeredWorkflows().filter((d) => d.trigger.type === "schedule")) await ensureDefinitionRow(db, ws, def.key, now);
  const { data } = await db.from("workflow_definition").select("*").eq("workspace_id", ws).eq("status", "active").not("every_minutes", "is", null).lte("next_run_at", now.toISOString());
  for (const row of (data ?? []) as Row[]) {
    let def; try { def = definition(row.key); } catch { continue; }
    if (def.trigger.type !== "schedule") continue;
    const slot = Math.floor(+now / (row.every_minutes * 60_000));
    const r = await startExecution(db, ws, row.key, { trigger: "schedule", dedupeKey: `${row.key}:slot:${slot}`, now, priority: row.priority });
    await db.from("workflow_definition").update({ last_run_at: now.toISOString(), next_run_at: new Date(+now + row.every_minutes * 60_000).toISOString(), updated_at: now.toISOString() }).eq("id", row.id);
    if (!r.duplicate) started.push(r.id);
  }
  return started;
}
