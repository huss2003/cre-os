import { requireContext } from "@/lib/auth/context";
import { parseJson, route, uuid } from "@/lib/util/http";
import { reopenTask, reopenSchema } from "@/modules/brief/tasks-service";


/** POST /api/v1/tasks/:id/reopen — body {expectedVersion}. Optimistic concurrency: stale expectedVersion => 409. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  const body = await parseJson(req, reopenSchema);
  return { task: await reopenTask(ctx.db, ctx.workspaceId, id, body) };
}, { requireIdempotency: true });
