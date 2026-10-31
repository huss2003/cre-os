import { z } from "zod";
import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { compareDocuments } from "@/modules/intelligence/legal/service";

const Body = z.object({ baseId: z.string().uuid(), compareId: z.string().uuid(), confirmCrossFamily: z.boolean().optional() }).refine((b) => b.baseId !== b.compareId, "documents must differ");

/**
 * Redline (per clause + full document) + exposure checklist; unique per (base, compare, engine version), so replays return the
 * same row. Different document families are refused (400) unless `confirmCrossFamily: true`.
 */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  return guard(compareDocuments(ctx.db, ctx.workspaceId, b.baseId, b.compareId, ctx.userId, { confirmCrossFamily: b.confirmCrossFamily }));
}, { requireIdempotency: true });
