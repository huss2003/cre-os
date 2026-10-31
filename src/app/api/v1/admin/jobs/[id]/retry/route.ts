import { route, uuid } from "@/lib/util/http";
import { requireAdminApi } from "@/modules/admin/guard";
import { asHttp } from "@/modules/admin/http";
import { retryJob } from "@/modules/admin/health";

/** POST /api/v1/admin/jobs/:id/retry — requeue a failed/dead/cancelled job (admin+, audited by app.retry_job). */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireAdminApi("admin");
  const id = uuid.parse(params.id);
  await asHttp(() => retryJob(ctx.db, id));
  return { ok: true, id };
}, { requireIdempotency: true });
