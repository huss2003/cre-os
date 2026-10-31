import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { parseJson, route, uuid } from "@/lib/util/http";
import { decideCandidate } from "@/modules/imports/service";

const Body = z.object({ decision: z.enum(["link", "keep_separate", "related"]) });

/** POST /api/v1/imports/matches/[id] — link (=> merge proposal for approval), keep separate, or related (group/campus link proposal). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  return decideCandidate(ctx, uuid.parse(params.id), b.decision);
}, { requireIdempotency: true });
