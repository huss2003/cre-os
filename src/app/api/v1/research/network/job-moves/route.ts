import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { recordJobMove, JobMoveInput } from "@/modules/intelligence/network/service";

/** Record a job move as evidence + proposals (never a direct write). Proposal idempotency keys derive from the claim. */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, JobMoveInput);
  return guard(recordJobMove(ctx.db, ctx.workspaceId, b, ctx.userId));
}, { requireIdempotency: true });
