import { z } from "zod";
import { route, parseJson, uuid } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { verifyJobMove } from "@/modules/intelligence/network/service";

type P = { id: string };
/** Human confirmation of a candidate job move (claim id). Closes the verification task; employment changes stay in Approvals. */
export const POST = route<P>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, z.object({ note: z.string().max(1000).optional().nullable() }));
  return guard(verifyJobMove(ctx.db, ctx.workspaceId, uuid.parse(params.id), b.note ?? null));
}, { requireIdempotency: true });
