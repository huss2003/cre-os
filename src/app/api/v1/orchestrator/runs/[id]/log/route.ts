import { NextResponse } from "next/server";
import { HttpError } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { exportLog } from "@/modules/orchestrator";
import { apiActor, asApi } from "@/modules/orchestrator/ui/http";

/** GET /api/v1/orchestrator/runs/:id/log — full run log as a JSON download. */
export const GET = route<{ id: string }>(async (_req, { params }) => asApi(async () => {
  const id = uuid.parse(params.id);
  const a = await apiActor();
  const { data } = await a.db.from("workflow_run").select("id").eq("workspace_id", a.ws).eq("id", id).eq("kind", "orchestrated").maybeSingle();
  if (!data) throw new HttpError(404, "Run not found.");
  return new NextResponse(await exportLog(a.db, a.ws, id), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="run-${id}.json"` } });
}));
