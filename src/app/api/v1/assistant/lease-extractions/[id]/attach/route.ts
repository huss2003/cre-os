import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { parseJson, route, uuid } from "@/lib/util/http";
import { executeTool } from "@/modules/assistant/engine/execute";
import { getTool } from "@/modules/assistant/tools";

const Body = z.object({ leaseId: uuid, attachDocument: z.boolean().default(false) });

/**
 * POST /api/v1/assistant/lease-extractions/:id/attach {leaseId, attachDocument}
 * Runs save_lease_terms through the normal tool path: it is category C, so nothing is written here —
 * the response is an Approve/Reject card showing the exact before → after diff for that lease.
 */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const { leaseId, attachDocument } = await parseJson(req, Body);
  const extractionId = uuid.parse(params.id);
  const { data: x } = await ctx.db.from("assistant_lease_extraction").select("id, run_id").eq("workspace_id", ctx.workspaceId).eq("id", extractionId).is("archived_at", null).maybeSingle();
  if (!x) throw new HttpError(404, "Extraction not found");
  // Approvals hang off a run: reuse the run that extracted the terms, else open a small one for this action.
  let runId = x.run_id as string | null;
  let conversationId: string | null = null;
  if (runId) {
    const { data: r } = await ctx.db.from("assistant_run").select("conversation_id").eq("workspace_id", ctx.workspaceId).eq("id", runId).maybeSingle();
    conversationId = (r?.conversation_id as string | null) ?? null;
  } else {
    const { data: r, error } = await ctx.db.from("assistant_run").insert({ workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, request: "Attach extracted lease terms", intent: "save_lease_terms", status: "waiting_approval" }).select("id").single();
    if (error || !r) throw new HttpError(500, "Could not start the action");
    runId = r.id as string;
  }
  const tool = getTool("save_lease_terms");
  if (!tool) throw new HttpError(500, "save_lease_terms tool missing");
  const { count } = await ctx.db.from("assistant_tool_execution").select("id", { count: "exact", head: true }).eq("workspace_id", ctx.workspaceId).eq("run_id", runId);
  const o = await executeTool(tool, { extractionId, leaseId, attachDocument }, { ctx, runId, conversationId }, 200 + (count ?? 0));
  if (o.status === "needs_approval" && o.approvalBlock) return { status: "needs_approval", blocks: [o.approvalBlock] };
  if (o.status === "denied") throw new HttpError(404, "Lease not found or you do not have access to it");
  return { status: o.status, blocks: o.result.blocks ?? [], error: o.result.error ?? o.result.summary };
}, { requireIdempotency: true });
