import { route } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { planWeek } from "@/modules/intelligence/content/service";

/** Idempotent per week + topic. */
export const POST = route(async () => {
  const ctx = await requireContext("editor");
  return guard(planWeek(ctx.db, ctx.workspaceId, ctx.userId));
}, { requireIdempotency: true });
