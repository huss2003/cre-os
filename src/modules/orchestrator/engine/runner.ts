import "server-only";
import type { Db } from "@/lib/supabase/server";
import { audit } from "./audit";
import { backoffMs, classifyError, deriveStatus, readySteps, isTerminalFailure, type StepRow } from "./plan";
import { definition, ensureDefinitionRow } from "./registry";
import { DEFAULT_RETRY, FINAL, type ExecStatus, type Ref, type StepCtx, type StepDef, type TriggerType } from "./types";

type Row = Record<string, any>;
const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e)).slice(0, 1000);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
}

export interface StartOpts {
  input?: Record<string, unknown>; dedupeKey?: string; trigger?: TriggerType; triggerRef?: Record<string, unknown>;
  subjectType?: string; subjectId?: string; orgId?: string | null; priority?: number; actor?: string | null; now?: Date;
}

/**
 * Create one execution of a registered workflow (workflow_run kind 'orchestrated' + one workflow_step per step).
 * Unique (workspace, dedupe_key): the same trigger twice returns the existing execution and records the duplicate.
 */
export async function startExecution(db: Db, ws: string, key: string, o: StartOpts = {}): Promise<{ id: string; duplicate: boolean }> {
  const def = definition(key);
  const now = o.now ?? new Date();
  const defRow = await ensureDefinitionRow(db, ws, key, now);
  const dedupeKey = o.dedupeKey ?? `${key}:${crypto.randomUUID()}`;
  const { data: prev } = await db.from("workflow_run").select("id").eq("workspace_id", ws).eq("dedupe_key", dedupeKey).maybeSingle();
  if (prev) {
    await audit(db, ws, { runId: prev.id, key, action: "duplicate_trigger", actor: o.actor, detail: { dedupeKey, trigger: o.trigger ?? def.trigger.type } });
    return { id: prev.id, duplicate: true };
  }
  const ins = await db.from("workflow_run").insert({
    workspace_id: ws, kind: "orchestrated", definition_key: key, definition_version: defRow.version,
    subject_type: o.subjectType ?? "workflow_definition", subject_id: o.subjectId ?? defRow.id, org_id: o.orgId ?? null,
    dedupe_key: dedupeKey, status: "queued", trigger_type: o.trigger ?? def.trigger.type, trigger_ref: o.triggerRef ?? {},
    priority: o.priority ?? defRow.priority ?? def.priority ?? 50, input: o.input ?? {}, summary: def.name,
    timeout_at: def.timeoutMs ? new Date(+now + def.timeoutMs).toISOString() : null,
    actor_user_id: o.actor ?? null, owner_user_id: o.actor ?? null, started_at: now.toISOString(),
  }).select("id").single();
  if (ins.error) {
    if (ins.error.code === "23505") {
      const { data: again } = await db.from("workflow_run").select("id").eq("workspace_id", ws).eq("dedupe_key", dedupeKey).single();
      await audit(db, ws, { runId: again!.id, key, action: "duplicate_trigger", actor: o.actor, detail: { dedupeKey } });
      return { id: again!.id, duplicate: true };
    }
    throw new Error(ins.error.message);
  }
  const runId = ins.data.id as string;
  const retry = { ...DEFAULT_RETRY, ...def.retry };
  const { error } = await db.from("workflow_step").insert(def.steps.map((s, i) => ({
    workspace_id: ws, run_id: runId, seq: i + 1, step_key: s.key, label: s.label, module: s.module,
    depends_on: s.dependsOn ?? [], status: s.dependsOn?.length ? "waiting_dependency" : "queued",
    max_attempts: s.retry?.maxAttempts ?? retry.maxAttempts, owner_user_id: o.actor ?? null,
  })));
  if (error) throw new Error(error.message);
  await audit(db, ws, { runId, key, action: "started", actor: o.actor, detail: { dedupeKey, trigger: o.trigger ?? def.trigger.type, input: o.input ?? {} } });
  return { id: runId, duplicate: false };
}

const CLAIMABLE: ExecStatus[] = ["queued", "waiting_dependency", "waiting_approval", "partially_completed"];

/**
 * Run every ready step of an execution, wave by wave (independent steps in parallel), until nothing more can run now.
 * Done steps are never re-executed. Temporary failures get exponential backoff; permanent ones (or exhausted retries →
 * dead letter) stop dependants. A paused/cancelled execution stops before its next wave.
 */
export async function advanceExecution(db: Db, ws: string, runId: string, opts: { now?: Date; maxWaves?: number } = {}): Promise<{ status: ExecStatus; ranSteps: string[] }> {
  const now = opts.now ?? new Date();
  const { data: run } = await db.from("workflow_run").select("*").eq("workspace_id", ws).eq("id", runId).maybeSingle();
  if (!run) throw new Error("Execution not found.");
  if (run.kind !== "orchestrated") throw new Error("Not an orchestrated execution.");
  if (!CLAIMABLE.includes(run.status)) return { status: run.status, ranSteps: [] };
  // Claim (one worker wins): optimistic flip on row_version.
  const { data: claimed } = await db.from("workflow_run").update({ status: "running", current_step: null })
    .eq("workspace_id", ws).eq("id", runId).eq("row_version", run.row_version).select("row_version").maybeSingle();
  if (!claimed) return { status: run.status, ranSteps: [] };
  await audit(db, ws, { runId, key: run.definition_key, action: "advance", detail: { from: run.status } });

  const def = definition(run.definition_key);
  const stepDefs = new Map<string, StepDef>(def.steps.map((s) => [s.key, s]));
  const retryDefault = { ...DEFAULT_RETRY, ...def.retry };
  const ranSteps: string[] = [];
  let steps: Row[] = [];
  const load = async () => { steps = ((await db.from("workflow_step").select("*").eq("workspace_id", ws).eq("run_id", runId).order("seq")).data ?? []) as Row[]; };
  await load();

  for (let wave = 0; wave < (opts.maxWaves ?? 50); wave++) {
    const { data: cur } = await db.from("workflow_run").select("status").eq("id", runId).single();
    if (cur?.status !== "running") break; // paused or cancelled meanwhile
    // Each step runs at most once per pass (a temporary failure waits for its backoff; waiting_approval re-checks next pass).
    const ready = readySteps(steps as StepRow[], now).filter((r) => !ranSteps.includes(r.step_key));
    if (!ready.length) break;
    const outputs: Record<string, unknown> = Object.fromEntries(steps.filter((s) => s.status === "done").map((s) => [s.step_key, s.output]));
    await Promise.all(ready.map(async (r) => {
      const row = steps.find((s) => s.step_key === r.step_key)!;
      const sd = stepDefs.get(r.step_key);
      const attempt = (row.attempts ?? 0) + 1;
      const ctx: StepCtx = { db, ws, runId, stepKey: r.step_key, attempt, now, input: run.input ?? {}, outputs, actor: run.actor_user_id ?? null, idempotencyKey: `${run.dedupe_key}:${r.step_key}` };
      const started = new Date().toISOString();
      ranSteps.push(r.step_key);
      if (!sd) {
        await db.from("workflow_step").update({ status: "dead", error: "Step no longer exists in the workflow definition.", error_class: "permanent", finished_at: started }).eq("id", row.id);
        return;
      }
      const cond = sd.condition?.(ctx);
      if (cond === false || typeof cond === "string") {
        await db.from("workflow_step").update({ status: "skipped", reason: typeof cond === "string" ? cond : "Condition not met.", started_at: started, finished_at: started }).eq("id", row.id);
        await audit(db, ws, { runId, key: def.key, action: "step_skipped", detail: { step: r.step_key } });
        return;
      }
      await db.from("workflow_step").update({ status: "running", started_at: started, attempts: attempt }).eq("id", row.id);
      await db.from("workflow_run").update({ current_step: r.step_key }).eq("id", runId);
      try {
        const out = await withTimeout(sd.run(ctx), sd.timeoutMs ?? 25_000, `step ${r.step_key}`);
        await db.from("workflow_step").update({ status: out.status, reason: out.reason, output_refs: out.refs ?? [], output: (out.output ?? null) as never, error: null, error_class: null, next_attempt_at: null, finished_at: new Date().toISOString() }).eq("id", row.id);
        await audit(db, ws, { runId, key: def.key, action: `step_${out.status}`, detail: { step: r.step_key, attempt, reason: out.reason } });
      } catch (e) {
        const cls = classifyError(e);
        const retry = { ...retryDefault, ...sd.retry };
        const max = row.max_attempts ?? retry.maxAttempts;
        const canRetry = cls === "temporary" && attempt < max && !sd.consequential;
        const exhausted = cls === "temporary" && attempt >= max;
        const next = canRetry ? new Date(+now + backoffMs(attempt, retry)).toISOString() : null;
        await db.from("workflow_step").update({ status: exhausted ? "dead" : "failed", error: errText(e), error_class: cls, next_attempt_at: next, finished_at: new Date().toISOString() }).eq("id", row.id);
        await audit(db, ws, { runId, key: def.key, action: exhausted ? "dead_letter" : canRetry ? "retry_scheduled" : "step_failed", detail: { step: r.step_key, attempt, error: errText(e), class: cls, next_attempt_at: next, consequential: !!sd.consequential } });
      }
    }));
    await load();
  }

  const d = deriveStatus(steps as StepRow[]);
  const { data: cur } = await db.from("workflow_run").select("status").eq("id", runId).single();
  const interrupted = cur?.status === "paused" || cur?.status === "cancelled";
  const status: ExecStatus = interrupted ? cur!.status : d.status;
  const failedStep = steps.find((s) => s.status === "dead" || s.status === "failed");
  const refs: Ref[] = steps.flatMap((s) => (s.output_refs ?? []) as Ref[]);
  const finished = FINAL.includes(status);
  if (!interrupted) {
    await db.from("workflow_run").update({
      status, progress: d.progress, next_attempt_at: d.nextAttemptAt, output_refs: refs.slice(0, 200), current_step: null,
      error: failedStep ? `${failedStep.label}: ${failedStep.error ?? ""}`.slice(0, 1000) : null,
      finished_at: finished ? new Date().toISOString() : null,
    }).eq("id", runId);
  } else {
    await db.from("workflow_run").update({ progress: d.progress, output_refs: refs.slice(0, 200) }).eq("id", runId);
  }
  await audit(db, ws, { runId, key: def.key, action: `status_${status}`, detail: { progress: d.progress, next_attempt_at: d.nextAttemptAt, terminal_failures: steps.filter((s) => isTerminalFailure(s as StepRow)).map((s) => s.step_key) } });
  return { status, ranSteps };
}

/** Start + advance in one go (event consumers, user-triggered runs). */
export async function runWorkflow(db: Db, ws: string, key: string, o: StartOpts = {}) {
  const s = await startExecution(db, ws, key, o);
  if (s.duplicate) return { ...s, status: (await db.from("workflow_run").select("status").eq("id", s.id).single()).data?.status as ExecStatus };
  const r = await advanceExecution(db, ws, s.id, { now: o.now });
  return { ...s, status: r.status };
}

/** Executions that can make progress now (queued, or a retry whose backoff elapsed), highest priority first. */
export async function runnableExecutions(db: Db, ws: string, now = new Date(), limit = 20): Promise<string[]> {
  const { data } = await db.from("workflow_run").select("id, status, next_attempt_at").eq("workspace_id", ws).eq("kind", "orchestrated")
    .in("status", ["queued", "waiting_dependency", "waiting_approval", "partially_completed"]).order("priority", { ascending: false }).order("started_at").limit(200);
  return ((data ?? []) as Row[]).filter((r) => r.status === "waiting_approval" || r.status === "queued" || (r.next_attempt_at && Date.parse(r.next_attempt_at) <= +now)).slice(0, limit).map((r) => r.id);
}

/** Executions past their timeout are failed (running steps marked temporary-failed so a retry can resume them). */
export async function timeoutExecutions(db: Db, ws: string, now = new Date()) {
  const { data } = await db.from("workflow_run").select("id, definition_key").eq("workspace_id", ws).eq("kind", "orchestrated")
    .in("status", ["queued", "running", "waiting_dependency", "partially_completed"]).lt("timeout_at", now.toISOString()).limit(50);
  for (const r of (data ?? []) as Row[]) {
    await db.from("workflow_step").update({ status: "failed", error: "Execution timed out.", error_class: "temporary", next_attempt_at: null }).eq("workspace_id", ws).eq("run_id", r.id).in("status", ["running", "queued", "waiting_dependency"]);
    await db.from("workflow_run").update({ status: "failed", error: "Execution timed out — earlier completed steps are kept; use Retry to resume.", finished_at: now.toISOString() }).eq("id", r.id);
    await audit(db, ws, { runId: r.id, key: r.definition_key, action: "timed_out" });
  }
  return (data ?? []).length;
}
