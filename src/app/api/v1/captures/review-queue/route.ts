import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { reviewQueue } from "@/modules/capture/input-engine/service";

export const dynamic = "force-dynamic";

/** GET /api/v1/captures/review-queue — items needing attention, grouped by the §13D categories. */
export const GET = route(async () => {
  const ctx = await requireContext();
  return { queue: await reviewQueue(ctx.db, ctx.workspaceId) };
});
