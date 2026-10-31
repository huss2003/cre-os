import { z } from "zod";
import { route, parseJson } from "@/lib/util/http";
import { requireAdminApi } from "@/modules/admin/guard";
import { asHttp } from "@/modules/admin/http";
import { pauseState, setAiPaused } from "@/modules/admin/killswitch";

const body = z.object({ paused: z.boolean().default(true), reason: z.string().trim().max(500).optional().nullable() });

/**
 * POST /api/v1/admin/pause { paused: true|false, reason? } — workspace kill switch (admin+, audited).
 * Paused => AI gateway refuses (AiUnavailableError 'paused') and ingestion jobs stop (assertIngestionAllowed);
 * internal records, tasks, approvals and the deterministic brief fallback keep working.
 */
export const POST = route(async (req) => {
  const ctx = await requireAdminApi("admin");
  const v = await parseJson(req, body);
  await asHttp(() => setAiPaused(ctx.db, ctx.workspaceId, v.paused, v.reason ?? null));
  return pauseState(ctx.db, ctx.workspaceId);
}, { requireIdempotency: true });
