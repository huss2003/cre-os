import { z } from "zod";
import { route, parseJson } from "@/lib/util/http";
import { requireAdminApi, requirePlatformApi } from "@/modules/admin/guard";
import { asHttp } from "@/modules/admin/http";
import { jobsPauseState, setJobsPaused } from "@/modules/admin/killswitch";

const body = z.object({
  paused: z.boolean().default(true),
  reason: z.string().trim().max(500).optional().nullable(),
  scope: z.enum(["workspace", "platform"]).default("workspace"),
});

/**
 * POST /api/v1/admin/jobs-pause { paused, reason?, scope? } — stop background job processing (separate from the AI
 * kill switch). scope "workspace" (admin+): claim_jobs skips this workspace's jobs except backups. scope "platform"
 * (platform admin): every workspace. Audited in mudar_app.set_jobs_paused.
 */
export const POST = route(async (req) => {
  const v = await parseJson(req, body);
  if (v.scope === "platform") {
    const ctx = await requirePlatformApi();
    await asHttp(() => setJobsPaused(ctx.db, null, v.paused, v.reason ?? null));
    return { scope: "platform", paused: v.paused };
  }
  const ctx = await requireAdminApi("admin");
  await asHttp(() => setJobsPaused(ctx.db, ctx.workspaceId, v.paused, v.reason ?? null));
  return jobsPauseState(ctx.db, ctx.workspaceId);
}, { requireIdempotency: true });
