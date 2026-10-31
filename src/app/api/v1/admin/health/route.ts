import { route } from "@/lib/util/http";
import { requireAdminApi } from "@/modules/admin/guard";
import { getHealth } from "@/modules/admin/health";

/** GET /api/v1/admin/health — jobs, connectors, AI spend vs budget, imports, backups, kill-switch state (admin+). */
export const GET = route(async () => {
  const ctx = await requireAdminApi("admin");
  return getHealth(ctx.db, ctx.workspaceId);
});
