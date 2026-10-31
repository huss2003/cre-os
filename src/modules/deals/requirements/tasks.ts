/**
 * Follow-up tasks from the requirement contract (workflow 08 "missing-information checklist → follow-up tasks").
 *
 * One task per open MANDATORY question, linked to the requirement (linked_entity_type = "requirement") and deduped by
 * idempotency_key `deals.req.q:<requirement>:<field>`. Re-running is a no-op. As answers arrive the tasks are refreshed:
 * - a question that is answered (value known and client-confirmed, or marked not applicable) closes its task as done
 *   with the answer state as completion evidence;
 * - a question whose reason changes (missing → estimate needs confirmation) gets its title updated;
 * - a question that re-opens (value cleared / downgraded) reopens its task.
 * Helpful (non-mandatory) questions stay on the checklist only, so the task list is not flooded.
 * Tasks the user closed manually as `cancelled` are left alone.
 */
import type { DealsCtx } from "../ctx";
import { dbError, owned } from "../ctx";
import { FIELD_STATUS_LABEL, fieldStatus, missingQuestions, type MissingQuestion, type RequirementRow } from "./contract";

export const QUESTION_TASK_SOURCE = "deals.requirement_question";
export const questionTaskKey = (requirementId: string, field: string) => `deals.req.q:${requirementId}:${field}`;

export interface TaskPlanRow { key: string; field: string; title: string; description: string }
export interface TaskRowLite { id: string; idempotency_key: string | null; status: string; title: string }
export interface TaskPlan {
  create: TaskPlanRow[];
  retitle: { id: string; title: string; description: string }[];
  reopen: { id: string; title: string; description: string }[];
  close: { id: string; evidence: string }[];
}

export function questionTitle(q: MissingQuestion, reqTitle: string): string {
  return q.reason === "missing" ? `Ask: ${q.label} — ${reqTitle}` : `Confirm with client: ${q.label} — ${reqTitle}`;
}

/** Pure diff between the open mandatory questions and the existing question tasks. Deterministic. */
export function planQuestionTasks(req: RequirementRow & { id: string }, existing: TaskRowLite[]): TaskPlan {
  const reqTitle = req.title ?? "requirement";
  const open = missingQuestions(req).filter((q) => q.priority === "mandatory");
  const wanted = new Map(open.map((q) => [questionTaskKey(req.id, q.key), q]));
  const byKey = new Map(existing.filter((t) => t.idempotency_key).map((t) => [t.idempotency_key!, t]));
  const plan: TaskPlan = { create: [], retitle: [], reopen: [], close: [] };
  for (const [key, q] of wanted) {
    const title = questionTitle(q, reqTitle);
    const description = `${q.question}${q.reason === "missing" ? "" : " (current value is an estimate/report — not a client instruction yet)"}`;
    const t = byKey.get(key);
    if (!t) plan.create.push({ key, field: q.key, title, description });
    else if (t.status === "done" || t.status === "stale") plan.reopen.push({ id: t.id, title, description });
    else if (t.status !== "cancelled" && t.title !== title) plan.retitle.push({ id: t.id, title, description });
  }
  const na = new Set(req.constraints?.not_applicable ?? []);
  for (const [key, t] of byKey) {
    if (wanted.has(key) || !key.startsWith(`deals.req.q:${req.id}:`)) continue;
    if (t.status === "done" || t.status === "cancelled") continue;
    const field = key.slice(`deals.req.q:${req.id}:`.length);
    const evidence = na.has(field) ? `Answered: marked not applicable` : `Answered: ${field} is now ${FIELD_STATUS_LABEL[fieldStatus(req, field)]}`;
    plan.close.push({ id: t.id, evidence });
  }
  return plan;
}

/** Apply the plan with the caller's client (user RLS, or the service role inside the deals jobs with explicit workspace filters). */
export async function syncQuestionTasks(ctx: DealsCtx, req: RequirementRow & { id: string; classification?: unknown; owner_user_id?: unknown }) {
  const ex = await ctx.db.from("task").select("id, idempotency_key, status, title").eq("workspace_id", ctx.workspaceId)
    .eq("linked_entity_type", "requirement").eq("linked_entity_id", req.id).eq("source", QUESTION_TASK_SOURCE);
  if (ex.error) throw dbError(ex.error, "tasks");
  const plan = planQuestionTasks(req, (ex.data ?? []) as TaskRowLite[]);
  const cls = String(req.classification ?? "corporate_confidential");
  const assignee = (req.owner_user_id as string | null | undefined) ?? ctx.userId;
  if (plan.create.length) {
    const rows = plan.create.map((c) => ({
      ...owned(ctx, cls), owner_user_id: assignee, assigned_user_id: assignee, title: c.title, description: c.description,
      status: "open", priority: 60, linked_entity_type: "requirement", linked_entity_id: req.id, source: QUESTION_TASK_SOURCE, idempotency_key: c.key,
    }));
    const ins = await ctx.db.from("task").insert(rows);
    if (ins.error && ins.error.code === "23505") {
      // a concurrent sync created some of them: insert one by one, ignoring duplicates
      for (const r of rows) { const one = await ctx.db.from("task").insert(r); if (one.error && one.error.code !== "23505") throw dbError(one.error, "task"); }
    } else if (ins.error) throw dbError(ins.error, "task");
  }
  const now = new Date().toISOString();
  for (const r of plan.reopen) {
    const u = await ctx.db.from("task").update({ status: "open", completed_at: null, completion_evidence: null, title: r.title, description: r.description }).eq("id", r.id).eq("workspace_id", ctx.workspaceId);
    if (u.error) throw dbError(u.error, "task");
  }
  for (const r of plan.retitle) {
    const u = await ctx.db.from("task").update({ title: r.title, description: r.description }).eq("id", r.id).eq("workspace_id", ctx.workspaceId);
    if (u.error) throw dbError(u.error, "task");
  }
  for (const r of plan.close) {
    const u = await ctx.db.from("task").update({ status: "done", completed_at: now, completion_evidence: r.evidence }).eq("id", r.id).eq("workspace_id", ctx.workspaceId);
    if (u.error) throw dbError(u.error, "task");
  }
  return { created: plan.create.length, reopened: plan.reopen.length, retitled: plan.retitle.length, closed: plan.close.length };
}
