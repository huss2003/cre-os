import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { listInbox } from "@/modules/orchestrator/notify/service";

/** GET /api/v1/orchestrator/notifications?closed=1 — the signed-in user's in-app notifications (quiet-hour deferred ones hidden until due). */
export const GET = route(async (req) => {
  const ctx = await requireContext();
  return { notifications: await listInbox(ctx.db, ctx.workspaceId, ctx.userId, { includeClosed: req.nextUrl.searchParams.get("closed") === "1" }) };
});
