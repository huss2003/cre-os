import "server-only";
import type { Db } from "@/lib/supabase/server";
import type { RunStatus, StepStatus, WorkflowKind } from "./rules";

type Row = Record<string, any>;
export interface Ref { type: string; id: string; label?: string }
export interface StepResult { status: StepStatus; reason: string; refs?: Ref[] }

/**
 * Run bookkeeping. A run is unique per (workspace, dedupe_key): `start` returns null when the trigger already has a
 * finished run (or another worker owns it), so a chain never runs twice. A run left in `waiting_approval` is resumed:
 * steps already done/skipped/failed are replayed from their stored result, not executed again.
 */
export class Run {
  private steps = new Map<string, Row>();
  private seq = 0;
  constructor(private db: Db, readonly ws: string, readonly id: string, readonly actor: string, existing: Row[] = []) {
    for (const s of existing) { this.steps.set(s.step_key, s); this.seq = Math.max(this.seq, s.seq); }
  }

  static async start(db: Db, ws: string, o: { kind: WorkflowKind; subjectType: string; subjectId: string; orgId: string | null; dedupeKey: string; actor: string }): Promise<Run | null> {
    const { data: prev } = await db.from("workflow_run").select("id, status, attempts").eq("workspace_id", ws).eq("dedupe_key", o.dedupeKey).maybeSingle();
    if (prev) {
      if (prev.status !== "waiting_approval") return null;
      // Claim the resume with optimistic status flip (only one worker wins).
      const { data: claimed } = await db.from("workflow_run").update({ status: "running", attempts: (prev.attempts ?? 1) + 1 })
        .eq("workspace_id", ws).eq("id", prev.id).eq("status", "waiting_approval").select("id").maybeSingle();
      if (!claimed) return null;
      const { data: steps } = await db.from("workflow_step").select("*").eq("workspace_id", ws).eq("run_id", prev.id);
      return new Run(db, ws, prev.id, o.actor, steps ?? []);
    }
    const { data, error } = await db.from("workflow_run").insert({
      workspace_id: ws, kind: o.kind, subject_type: o.subjectType, subject_id: o.subjectId, org_id: o.orgId, dedupe_key: o.dedupeKey,
      status: "running", actor_user_id: o.actor, owner_user_id: o.actor,
    }).select("id").single();
    if (error) { if (error.code === "23505") return null; throw new Error(error.message); }
    return new Run(db, ws, data.id, o.actor);
  }

  /** Execute one step once. Errors become a failed step (the chain decides whether to continue). */
  async step(key: string, label: string, fn: () => Promise<StepResult>): Promise<StepResult> {
    const prev = this.steps.get(key);
    if (prev && prev.status !== "waiting_approval" && prev.status !== "running" && prev.status !== "queued")
      return { status: prev.status, reason: prev.reason ?? "", refs: prev.output_refs ?? [] };
    const started = new Date().toISOString();
    let r: StepResult;
    try { r = await fn(); } catch (e) { r = { status: "failed", reason: String((e as Error)?.message ?? e).slice(0, 500) }; }
    const row = { status: r.status, reason: r.reason, output_refs: r.refs ?? [], started_at: started, finished_at: new Date().toISOString() };
    if (prev) await this.db.from("workflow_step").update(row).eq("workspace_id", this.ws).eq("id", prev.id);
    else {
      const { error } = await this.db.from("workflow_step").insert({ workspace_id: this.ws, run_id: this.id, seq: ++this.seq, step_key: key, label, owner_user_id: this.actor, ...row });
      if (error) throw new Error(error.message);
    }
    this.steps.set(key, { ...prev, step_key: key, ...row });
    return r;
  }

  /** Record a step that will not run because an earlier step stopped the chain. */
  skip(key: string, label: string, reason: string) { return this.step(key, label, async () => ({ status: "skipped", reason })); }

  async finish(status: RunStatus, summary: string) {
    await this.db.from("workflow_run").update({ status, summary, finished_at: status === "waiting_approval" ? null : new Date().toISOString() }).eq("workspace_id", this.ws).eq("id", this.id);
    return { runId: this.id, status, summary };
  }
}

export const refId = (r: StepResult, type: string) => r.refs?.find((x) => x.type === type)?.id ?? null;
