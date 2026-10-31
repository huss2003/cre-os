import { z } from "zod";
import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { detectSignalsForOrg } from "@/modules/intelligence/research/service";

/** Rule-based signal detection over a company's stored evidence. Creates deduped hypotheses only. */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, z.object({ orgId: z.string().uuid() }));
  return guard(detectSignalsForOrg(ctx.db, ctx.workspaceId, b.orgId, ctx.userId));
}, { requireIdempotency: true });
