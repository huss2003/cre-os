import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, parseJson } from "@/lib/util/http";
import { asHttp } from "@/modules/changes/http";
import { loadPermissions, savePermissions } from "@/modules/capture/input-engine/service";

export const dynamic = "force-dynamic";

/** GET/POST /api/v1/captures/settings — what the Input Engine may do automatically (rule 14). Admins change it. */
export const GET = route(async () => {
  const ctx = await requireContext();
  return { permissions: await loadPermissions(ctx.db, ctx.workspaceId) };
});
const Body = z.object({ auto_save_internal_observations: z.boolean(), auto_create_tasks: z.boolean(), auto_associate_high_confidence: z.boolean() }).partial();
export const POST = route(async (req: NextRequest) => {
  const ctx = await requireContext("admin");
  const b = await parseJson(req, Body);
  try { return { permissions: await savePermissions(ctx.db, ctx.workspaceId, b) }; } catch (e) { asHttp(e); }
}, { requireIdempotency: true });
