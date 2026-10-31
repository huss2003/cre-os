import { z } from "zod";
import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { draftReconnect } from "@/modules/intelligence/network/service";

const Body = z.object({ personId: z.string().uuid(), orgId: z.string().uuid(), channel: z.enum(["email", "linkedin"]).default("email") });

/** Creates a DRAFT only (S3). Suppressed recipients are refused. */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  return guard(draftReconnect(ctx.db, ctx.workspaceId, { ...b, userId: ctx.userId }));
}, { requireIdempotency: true });
