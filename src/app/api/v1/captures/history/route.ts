import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { captureHistory } from "@/modules/capture/input-engine/service";

export const dynamic = "force-dynamic";

/** GET /api/v1/captures/history — notes and files with status, extracted records, corrections, links and errors (§13E). */
export const GET = route(async () => {
  const ctx = await requireContext();
  return { history: await captureHistory(ctx.db, ctx.workspaceId, 100) };
});
