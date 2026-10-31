import { route, uuid } from "@/lib/util/http";
import { requireAdminApi } from "@/modules/admin/guard";
import { asHttp } from "@/modules/admin/http";
import { acknowledgeAlert } from "@/modules/admin/health";

/** POST /api/v1/admin/alerts/:id/ack — acknowledge a System Supervisor alert (admin+): no further notifications for it. */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireAdminApi("admin");
  const id = uuid.parse(params.id);
  await asHttp(() => acknowledgeAlert(ctx.db, ctx.workspaceId, id, ctx.userId));
  return { ok: true, id };
}, { requireIdempotency: true });
