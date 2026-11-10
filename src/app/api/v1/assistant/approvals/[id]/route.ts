import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { parseJson, route, uuid } from "@/lib/util/http";
import { decideApproval } from "@/modules/assistant/engine/approvals";

const Body = z.object({ decision: z.enum(["approve", "reject"]) });

/** POST /api/v1/assistant/approvals/:id {decision} → {status, blocks}. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const { decision } = await parseJson(req, Body);
  const r = await decideApproval(ctx, uuid.parse(params.id), decision);
  return { status: r.status, blocks: r.blocks, newApprovalId: r.newApprovalId ?? null };
}, { requireIdempotency: true });
