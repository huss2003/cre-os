import { z } from "zod";
import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { compareDocuments } from "@/modules/intelligence/legal/service";

const Body = z.object({ baseId: z.string().uuid(), compareId: z.string().uuid() }).refine((b) => b.baseId !== b.compareId, "documents must differ");

/** Redline + exposure checklist; unique per (base, compare, engine version), so replays return the same row. */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  return guard(compareDocuments(ctx.db, ctx.workspaceId, b.baseId, b.compareId, ctx.userId));
}, { requireIdempotency: true });
