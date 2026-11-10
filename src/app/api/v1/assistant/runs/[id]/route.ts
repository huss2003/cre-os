import { HttpError, requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";

/** GET /api/v1/assistant/runs/:id — run row + tool executions + approvals (execution history). */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext();
  const id = uuid.parse(params.id);
  const { data: run } = await ctx.db.from("assistant_run").select("*").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle();
  if (!run) throw new HttpError(404, "run not found");
  const [{ data: executions }, { data: approvals }] = await Promise.all([
    ctx.db.from("assistant_tool_execution").select("id, step, tool_id, category, input, output_summary, status, error, duration_ms, created_at").eq("workspace_id", ctx.workspaceId).eq("run_id", id).order("step"),
    ctx.db.from("assistant_approval").select("id, tool_id, title, status, decided_at, created_at").eq("workspace_id", ctx.workspaceId).eq("run_id", id).order("created_at"),
  ]);
  return { run, executions: executions ?? [], approvals: approvals ?? [] };
});
