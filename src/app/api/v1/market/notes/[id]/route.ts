import { z } from "zod";
import { route, parseJson, uuid } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { setMarketNoteStatus } from "@/modules/intelligence/market/service";

const Body = z.object({ status: z.enum(["draft", "in_review", "approved", "published_manually", "discarded"]), confidentialityChecked: z.boolean().optional() });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  return guard(setMarketNoteStatus(ctx.db, ctx.workspaceId, uuid.parse(params.id), b.status, b.confidentialityChecked));
}, { requireIdempotency: true });
