import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { moveStage } from "@/modules/deals/pipeline/service";

const Body = z.object({ expectedVersion: z.number().int(), stage: z.string(), evidence: z.string().max(2000).nullish() });

/** Stage machine with gates (confirmed requirement, evidence, closing items, fee records); history written by the DB. */
export const POST = dealsRoute<{ id: string }>({ mutation: true, scope: "opportunities.stage" }, async (req, ctx, p) => {
  const b = await parseJson(req, Body);
  return { opportunity: await moveStage(ctx, z.string().uuid().parse(p.id), b.expectedVersion, b.stage, b.evidence) };
});
