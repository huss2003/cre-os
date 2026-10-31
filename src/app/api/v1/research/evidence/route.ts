import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { addPastedEvidence, EvidenceInput } from "@/modules/intelligence/research/service";

/** Store a user-pasted note/URL as untrusted evidence (status reported). Replays of the same text are deduped. */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, EvidenceInput);
  return guard(addPastedEvidence(ctx.db, ctx.workspaceId, b, ctx.userId));
}, { requireIdempotency: true });
