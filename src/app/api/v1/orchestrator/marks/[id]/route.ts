import { parseJson, route, uuid } from "@/lib/util/http";
import { apiActor, asApi, markBody } from "@/modules/orchestrator/ui/http";
import { markControl } from "@/modules/orchestrator/ui/service";

/** POST /api/v1/orchestrator/marks/:id — {action: refresh|dismiss} on a needs-refresh / outdated warning (editor). Idempotency-Key required. */
export const POST = route<{ id: string }>(async (req, { params, idempotencyKey }) => {
  const id = uuid.parse(params.id);
  const body = await parseJson(req, markBody);
  return asApi(async () => markControl(await apiActor(), id, body, idempotencyKey ?? undefined));
}, { requireIdempotency: true });
