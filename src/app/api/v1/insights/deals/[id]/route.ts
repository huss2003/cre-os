import { route, uuid } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { strategyFor, saveStrategySnapshot, negotiationHistory } from "@/modules/intelligence/strategy/service";

type P = { id: string };

/** Deal strategist output (suggestions only) plus the negotiation log and concession ladder. */
export const GET = route<P>(async (_req, { params }) => {
  const ctx = await requireContext();
  const id = uuid.parse(params.id);
  const [strategy, history] = await Promise.all([guard(strategyFor(ctx.db, ctx.workspaceId, id)), guard(negotiationHistory(ctx.db, ctx.workspaceId, id))]);
  return { strategy, history };
});

/** Save today's snapshot (idempotent per opportunity per day). */
export const POST = route<P>(async (_req, { params }) => {
  const ctx = await requireContext("editor");
  return guard(saveStrategySnapshot(ctx.db, ctx.workspaceId, uuid.parse(params.id), ctx.userId));
}, { requireIdempotency: true });
