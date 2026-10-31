import { requireContext } from "@/lib/auth/context";
import { parseJson, route } from "@/lib/util/http";
import { loadSettings } from "@/modules/brief/db";
import { createManualTask, createTaskSchema, listTasks, taskFilterSchema } from "@/modules/brief/tasks-service";


/** GET /api/v1/tasks?state=open|overdue|snoozed|stale|done|all&scope=mine|all&q=&source= */
export const GET = route(async (req) => {
  const ctx = await requireContext();
  const sp = req.nextUrl.searchParams;
  const f = taskFilterSchema.parse({ state: sp.get("state") ?? undefined, scope: sp.get("scope") ?? undefined, q: sp.get("q") ?? undefined, source: sp.get("source") ?? undefined });
  const settings = await loadSettings(ctx.db, ctx.workspaceId, ctx.userId);
  return { tasks: await listTasks(ctx.db, ctx.workspaceId, ctx.userId, f, { staleAfterDays: settings.staleTaskAfterDays }) };
});

/** POST /api/v1/tasks — manual task (Idempotency-Key => same task on retry). */
export const POST = route(async (req, { idempotencyKey }) => {
  const ctx = await requireContext("editor");
  const body = await parseJson(req, createTaskSchema);
  return { task: await createManualTask(ctx.db, ctx.workspaceId, ctx.userId, body, idempotencyKey) };
}, { requireIdempotency: true });
