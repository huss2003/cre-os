import { z } from "zod";
import { route, parseJson, uuid } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { revokeIntroConsent } from "@/modules/intelligence/network/relationships";

type P = { id: string };
export const POST = route<P>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, z.object({ reason: z.string().max(300).optional().nullable() }));
  return guard(revokeIntroConsent(ctx.db, ctx.workspaceId, uuid.parse(params.id), b.reason ?? null));
}, { requireIdempotency: true });
