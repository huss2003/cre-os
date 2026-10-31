import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { draftMarketNote, listMarketNotes, MarketNoteInput } from "@/modules/intelligence/market/service";

export const GET = route(async () => {
  const ctx = await requireContext();
  return { notes: await guard(listMarketNotes(ctx.db, ctx.workspaceId)) };
});

export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, MarketNoteInput);
  return guard(draftMarketNote(ctx.db, ctx.workspaceId, b, { userId: ctx.userId }));
}, { requireIdempotency: true });
