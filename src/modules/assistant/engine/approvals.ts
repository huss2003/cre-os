import "server-only";
import { hasRole, HttpError, type AppContext } from "@/lib/auth/context";
import type { Block, EntityRef, ToolResult } from "../types";
import { getTool } from "../tools";
import { audit, securityEvent } from "./audit";
import { appendMessage } from "./run";

export interface DecisionResult { status: "rejected" | "executed" | "failed" | "expired"; blocks: Block[]; approvalId: string; newApprovalId?: string }

/** Key-order-insensitive (jsonb reorders keys). */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
const sameDiff = (a: unknown, b: unknown) => canon(a ?? []) === canon(b ?? []);

/**
 * Approve or reject a pending category-C action. On approve the plan is re-read first: if the record changed since the
 * approval card was shown (drift), the old approval expires and a fresh one is returned instead of executing.
 */
export async function decideApproval(ctx: AppContext, approvalId: string, decision: "approve" | "reject"): Promise<DecisionResult> {
  if (!hasRole(ctx, "editor")) {
    await securityEvent(ctx, "approval_denied", null, { approval_id: approvalId, role: ctx.role });
    throw new HttpError(403, "requires member role");
  }
  const { data: appr } = await ctx.db.from("assistant_approval").select("*").eq("workspace_id", ctx.workspaceId).eq("id", approvalId).maybeSingle();
  if (!appr) {
    await securityEvent(ctx, "access_denied", null, { where: "approval", approval_id: approvalId });
    throw new HttpError(404, "approval not found");
  }
  if (appr.status !== "pending") throw new HttpError(409, `approval is ${appr.status}`);
  const tool = getTool(appr.tool_id as string);
  if (!tool || tool.category !== "C") throw new HttpError(409, "approval tool unavailable");

  const { data: run } = await ctx.db.from("assistant_run").select("id, conversation_id").eq("workspace_id", ctx.workspaceId).eq("id", appr.run_id as string).maybeSingle();
  const conversationId = (run?.conversation_id as string) ?? null;
  const decided = { decided_by: ctx.userId, decided_at: new Date().toISOString() };
  const update = (patch: Record<string, unknown>) =>
    ctx.db.from("assistant_approval").update(patch).eq("workspace_id", ctx.workspaceId).eq("id", approvalId).eq("status", "pending").select("id");

  const post = async (text: string, blocks: Block[], status = "complete") => {
    if (conversationId) await appendMessage(ctx, conversationId, { role: "assistant", content: text, blocks: [{ kind: "text", markdown: text }, ...blocks], status, runId: run?.id as string });
  };

  if (decision === "reject") {
    const { data: u } = await update({ status: "rejected", ...decided });
    if (!u?.length) throw new HttpError(409, "approval already decided");
    await audit(ctx, "assistant.approval.rejected", "assistant_approval", approvalId, { tool_id: appr.tool_id, title: appr.title });
    const blocks: Block[] = [{ kind: "status", done: [], pending: [], blocked: [`Rejected: ${appr.title}`] }];
    await post(`Rejected — nothing was changed (${appr.title}).`, blocks);
    await settleRun(ctx, appr.run_id as string);
    return { status: "rejected", blocks, approvalId };
  }

  const tctx = { ctx, runId: appr.run_id as string, conversationId, focus: null };
  const input = tool.input.parse(appr.input);
  const plan = await tool.plan!(input, tctx);
  if (!sameDiff(plan.diff, appr.diff) || !sameDiff(plan.affected.map((a: EntityRef) => a.id), (appr.affected as EntityRef[]).map((a) => a.id))) {
    const { data: u } = await update({ status: "expired", ...decided, result: { reason: "drift", new_diff: plan.diff } });
    if (!u?.length) throw new HttpError(409, "approval already decided");
    const { data: fresh } = await ctx.db.from("assistant_approval").insert({
      workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, run_id: appr.run_id, tool_id: tool.id, title: plan.title, explanation: plan.explanation,
      affected: plan.affected as object, diff: plan.diff as object, input: input as object, status: "pending",
    }).select("id").single();
    const card: Block = { kind: "approval", approvalId: fresh!.id as string, title: plan.title, explanation: plan.explanation, affected: plan.affected, diff: plan.diff, status: "pending" };
    await audit(ctx, "assistant.approval.expired", "assistant_approval", approvalId, { reason: "drift", replaced_by: fresh!.id });
    await post("The record changed since this was proposed, so I did not apply it. Please review the updated change.", [card], "waiting_approval");
    return { status: "expired", blocks: [card], approvalId, newApprovalId: fresh!.id as string };
  }

  const { data: claimed } = await update({ status: "approved", ...decided });
  if (!claimed?.length) throw new HttpError(409, "approval already decided");
  let result: ToolResult;
  try { result = await tool.run(input, tctx); }
  catch (e) { result = { ok: false, summary: `${tool.id} failed`, error: String((e as Error).message ?? e).slice(0, 300) }; }
  const final = result.ok ? "executed" : "failed";
  await ctx.db.from("assistant_approval").update({ status: final, result: result as object }).eq("workspace_id", ctx.workspaceId).eq("id", approvalId);
  await ctx.db.from("assistant_tool_execution").insert({
    workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, run_id: appr.run_id, step: 100, tool_id: tool.id, category: "C", input: input as object,
    output_summary: result.summary.slice(0, 500), output: result as object, status: result.ok ? "ok" : "error", error: result.error ?? null,
  });
  await audit(ctx, `assistant.approval.${final}`, "assistant_approval", approvalId, { tool_id: tool.id, title: appr.title, diff: appr.diff, summary: result.summary, affected: appr.affected });
  const blocks: Block[] = [...(result.blocks ?? []), { kind: "status", done: result.ok ? [result.summary] : [], pending: [], blocked: result.ok ? [] : [result.error ?? result.summary] }];
  await post(result.ok ? `Done: ${result.summary}` : `Could not complete: ${result.summary}`, blocks, result.ok ? "complete" : "failed");
  await settleRun(ctx, appr.run_id as string);
  return { status: final, blocks, approvalId };
}

/** When no approval of the run is pending any more, mark it completed. */
async function settleRun(ctx: AppContext, runId: string) {
  const { count } = await ctx.db.from("assistant_approval").select("id", { count: "exact", head: true }).eq("workspace_id", ctx.workspaceId).eq("run_id", runId).eq("status", "pending");
  if (!count) await ctx.db.from("assistant_run").update({ status: "completed" }).eq("workspace_id", ctx.workspaceId).eq("id", runId).eq("status", "waiting_approval");
}
