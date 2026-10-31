import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { approveScenario } from "@/modules/deals/finance/service";

const Body = z.object({ acknowledgeGaps: z.boolean().optional(), note: z.string().max(1000).nullish() });

/**
 * Approve a stored scenario (admin). Re-runs the engine; refuses if the hash no longer reproduces, quotes are stale,
 * an assumption is unapproved, or a cost is unknown without `acknowledgeGaps: true` (recorded with the approval).
 */
export const POST = dealsRoute<{ id: string }>({ role: "admin", mutation: true, scope: "finance.approve" }, async (req, ctx, p) => {
  const b = req.headers.get("content-length") === "0" ? {} : await parseJson(req, Body).catch(() => ({}));
  return { scenario: await approveScenario(ctx, z.string().uuid().parse(p.id), { acknowledgeGaps: (b as z.infer<typeof Body>).acknowledgeGaps, note: (b as z.infer<typeof Body>).note ?? null }) };
});
