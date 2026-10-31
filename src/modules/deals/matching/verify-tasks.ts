/**
 * Verification tasks from a shortlist run (workflow 09 "verify live availability and terms before client use").
 *
 * For the top non-ineligible options, every coded verification item becomes one task linked to the requirement,
 * deduped by idempotency_key `deals.verify:<requirement>:<space>:<code>` (codes carry no dates, so re-runs and the
 * rematch job never duplicate). Items that no longer apply on a later run close their open task ("resolved by
 * shortlist vN"); items that re-appear reopen it. Options that became ineligible close their tasks too.
 */
import type { DealsCtx } from "../ctx";
import { dbError, owned } from "../ctx";
import type { RequirementRow } from "../requirements/contract";
import type { OptionResult } from "./match";

export const VERIFY_TASK_SOURCE = "deals.shortlist_verification";
export const MAX_VERIFY_OPTIONS = 10;
export const verifyTaskKey = (requirementId: string, spaceId: string, code: string) => `deals.verify:${requirementId}:${spaceId}:${code}`;

export interface VerifyTaskRow { key: string; title: string; description: string }
export interface ExistingTask { id: string; idempotency_key: string | null; status: string }

/** Pure: which verification tasks should exist after this run, and which existing ones to close / reopen. */
export function planVerificationTasks(requirementId: string, results: OptionResult[], existing: ExistingTask[]) {
  const wanted = new Map<string, VerifyTaskRow>();
  const top = results.filter((r) => r.eligibility !== "ineligible").slice(0, MAX_VERIFY_OPTIONS);
  for (const r of top) {
    for (const v of r.verification) {
      const key = verifyTaskKey(requirementId, r.spaceId, v.code);
      if (wanted.has(key)) continue;
      wanted.set(key, { key, title: `Verify: ${r.label} — ${v.text}`.slice(0, 300), description: `Shortlist rank ${r.rank}. Verify before client use: ${v.text}` });
    }
  }
  const byKey = new Map(existing.filter((t) => t.idempotency_key).map((t) => [t.idempotency_key!, t]));
  const create = [...wanted.values()].filter((w) => !byKey.has(w.key));
  const reopen = [...wanted.values()].filter((w) => { const t = byKey.get(w.key); return t && (t.status === "done" || t.status === "stale"); })
    .map((w) => ({ id: byKey.get(w.key)!.id, title: w.title, description: w.description }));
  const close = existing.filter((t) => t.idempotency_key && !wanted.has(t.idempotency_key) && (t.status === "open" || t.status === "snoozed" || t.status === "stale")).map((t) => t.id);
  return { create, reopen, close };
}

export async function syncVerificationTasks(ctx: DealsCtx, req: RequirementRow & { id: string; classification?: unknown; owner_user_id?: unknown }, results: OptionResult[], version?: number) {
  const ex = await ctx.db.from("task").select("id, idempotency_key, status").eq("workspace_id", ctx.workspaceId)
    .eq("linked_entity_type", "requirement").eq("linked_entity_id", req.id).eq("source", VERIFY_TASK_SOURCE).limit(2000);
  if (ex.error) throw dbError(ex.error, "tasks");
  const plan = planVerificationTasks(req.id, results, (ex.data ?? []) as ExistingTask[]);
  const cls = String(req.classification ?? "corporate_confidential");
  const assignee = (req.owner_user_id as string | null | undefined) ?? ctx.userId;
  const rows = plan.create.map((c) => ({
    ...owned(ctx, cls), owner_user_id: assignee, assigned_user_id: assignee, title: c.title, description: c.description, status: "open", priority: 55,
    linked_entity_type: "requirement", linked_entity_id: req.id, source: VERIFY_TASK_SOURCE, idempotency_key: c.key,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const ins = await ctx.db.from("task").insert(chunk);
    if (ins.error?.code === "23505") {
      for (const r of chunk) { const one = await ctx.db.from("task").insert(r); if (one.error && one.error.code !== "23505") throw dbError(one.error, "task"); }
    } else if (ins.error) throw dbError(ins.error, "task");
  }
  for (const r of plan.reopen) {
    const u = await ctx.db.from("task").update({ status: "open", completed_at: null, completion_evidence: null, title: r.title, description: r.description }).eq("id", r.id).eq("workspace_id", ctx.workspaceId);
    if (u.error) throw dbError(u.error, "task");
  }
  if (plan.close.length) {
    const u = await ctx.db.from("task").update({ status: "done", completed_at: new Date().toISOString(), completion_evidence: `Resolved: no longer flagged by shortlist${version ? ` v${version}` : ""}` })
      .eq("workspace_id", ctx.workspaceId).in("id", plan.close);
    if (u.error) throw dbError(u.error, "task");
  }
  return { created: plan.create.length, reopened: plan.reopen.length, closed: plan.close.length };
}
