import { route, parseJson } from "@/lib/util/http";
import { apiActor, asApi, workflowBody } from "@/modules/orchestrator/ui/http";
import { loadWorkflow, workflowControl } from "@/modules/orchestrator/ui/service";

/** GET /api/v1/orchestrator/workflows/:key — definition, state, steps, recent runs, history. */
export const GET = route<{ key: string }>(async (_req, { params }) => asApi(async () => loadWorkflow(await apiActor(), decodeURIComponent(params.key))));

/** POST /api/v1/orchestrator/workflows/:key — {action: pause|resume|schedule|priority (admin) | start (role per workflow)}. Idempotency-Key required. */
export const POST = route<{ key: string }>(async (req, { params, idempotencyKey }) => {
  const body = await parseJson(req, workflowBody);
  return asApi(async () => workflowControl(await apiActor(), decodeURIComponent(params.key), body.action === "start" ? { ...body, dedupeKey: `api:${idempotencyKey}` } : body));
}, { requireIdempotency: true });
