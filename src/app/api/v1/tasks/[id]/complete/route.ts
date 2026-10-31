import { requireContext } from "@/lib/auth/context";
import { parseJson, route, uuid } from "@/lib/util/http";
import { completeTask, completeSchema } from "@/modules/brief/tasks-service";


/** POST /api/v1/tasks/:id/complete — body {expectedVersion, evidence} — completion evidence required. Optimistic concurrency: stale expectedVersion => 409. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  const body = await parseJson(req, completeSchema);
  return { task: await completeTask(ctx.db, ctx.workspaceId, id, body) };
}, { requireIdempotency: true });
