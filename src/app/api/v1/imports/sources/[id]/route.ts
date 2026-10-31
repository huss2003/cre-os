import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { approveSource, revokeSource } from "@/modules/imports/service";

const Body = z.object({ decision: z.enum(["approve", "revoke"]) });

/** POST /api/v1/imports/sources/:id {decision} — admin approves (then quarantined files are processed) or revokes a source. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("admin");
  const id = uuid.parse(params.id);
  const { decision } = Body.parse(await req.json());
  return decision === "approve" ? approveSource(ctx, id) : revokeSource(ctx, id);
}, { requireIdempotency: true });
