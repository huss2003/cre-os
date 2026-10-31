import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { recordIntroConsent, ConsentInput } from "@/modules/intelligence/network/relationships";

/** Record introduction consent for a relationship edge (who gave it, how, when; recorded by the caller). */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, ConsentInput);
  return guard(recordIntroConsent(ctx.db, ctx.workspaceId, b, ctx.userId));
}, { requireIdempotency: true });
