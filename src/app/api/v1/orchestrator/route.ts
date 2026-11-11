import { route } from "@/lib/util/http";
import { apiActor, asApi } from "@/modules/orchestrator/ui/http";
import { loadDashboard } from "@/modules/orchestrator/ui/service";

/** GET /api/v1/orchestrator — Automation dashboard data (workflows, scheduled, runs by state, health, usage). */
export const GET = route(async () => asApi(async () => loadDashboard(await apiActor())));
