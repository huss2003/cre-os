import { route } from "@/lib/util/http";
import { listExecutions } from "@/modules/orchestrator";
import { apiActor, asApi } from "@/modules/orchestrator/ui/http";

/** GET /api/v1/orchestrator/runs?status=failed&key=… — recent runs (newest first). */
export const GET = route(async (req) => asApi(async () => {
  const a = await apiActor();
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status")?.split(",").filter(Boolean) ?? [];
  return { runs: await listExecutions(a.db, a.ws, { status: status.length ? (status as never) : undefined, key: sp.get("key") ?? undefined, limit: Math.min(100, Number(sp.get("limit") ?? 50) || 50) }) };
}));
