import { HttpError } from "@/lib/auth/context";
import { parseJson, route } from "@/lib/util/http";
import { apiActor, asApi, startBody } from "@/modules/orchestrator/ui/http";
import { dateForRequest, startWorkflow, workflowForRequest } from "@/modules/orchestrator/ui/service";

/** POST /api/v1/orchestrator/start — {request | workflowKey, date?}: start an authorised user workflow. Idempotency-Key required. */
export const POST = route(async (req, { idempotencyKey }) => {
  const b = await parseJson(req, startBody);
  return asApi(async () => {
    const a = await apiActor();
    const key = b.workflowKey ?? workflowForRequest(b.request ?? "");
    if (!key) throw new HttpError(422, "No workflow matches this request.");
    const tz = a.timezone ?? "Asia/Kolkata";
    return startWorkflow(a, key, { date: b.date ?? dateForRequest(b.request ?? "", tz), tz, generateBriefs: true }, `api:${idempotencyKey}`);
  });
}, { requireIdempotency: true });
