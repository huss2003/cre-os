import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { setOutcome } from "@/modules/deals/pipeline/service";

const Body = z.object({ expectedVersion: z.number().int(), outcome: z.enum(["open", "dormant", "lost", "disqualified", "won"]), reason: z.string().max(100).nullish() });

export const POST = dealsRoute<{ id: string }>({ mutation: true, scope: "opportunities.outcome" }, async (req, ctx, p) => {
  const b = await parseJson(req, Body);
  return { opportunity: await setOutcome(ctx, z.string().uuid().parse(p.id), b.expectedVersion, b.outcome, b.reason) };
});
