import { HttpError } from "@/lib/auth/context";
import { parseJson, route, uuid } from "@/lib/util/http";
import { apiActor, asApi, runBody } from "@/modules/orchestrator/ui/http";
import { loadRun, runControl } from "@/modules/orchestrator/ui/service";

/** GET /api/v1/orchestrator/runs/:id — progress, steps, history, failure report, related records. */
export const GET = route<{ id: string }>(async (_req, { params }) => asApi(async () => {
  const r = await loadRun(await apiActor(), uuid.parse(params.id));
  if (!r) throw new HttpError(404, "Run not found.");
  return r;
}));

/** POST /api/v1/orchestrator/runs/:id — {action: pause|resume|retry|continue (editor) | cancel|priority (admin)}. Idempotency-Key required. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const id = uuid.parse(params.id);
  const body = await parseJson(req, runBody);
  return asApi(async () => runControl(await apiActor(), id, body));
}, { requireIdempotency: true });
