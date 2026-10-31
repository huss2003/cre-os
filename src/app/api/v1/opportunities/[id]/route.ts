import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { getOpportunityDetail, logObjection, updateLabels } from "@/modules/deals/pipeline/service";

const Patch = z.object({
  expectedVersion: z.number().int(), temperature: z.enum(["cold", "warm", "hot"]).nullish(),
  mandateStatus: z.enum(["none", "non_exclusive", "exclusive", "support", "unknown"]).nullish(),
  nextAction: z.string().max(500).nullish(), nextActionDue: z.string().nullish(), expectedClose: z.string().nullish(), risks: z.string().max(2000).nullish(),
  objection: z.object({ category: z.string().optional(), objection: z.string().min(1).max(2000), response: z.string().max(2000).nullish() }).optional(),
});

export const GET = dealsRoute<{ id: string }>({}, async (_req, ctx, p) => getOpportunityDetail(ctx, z.string().uuid().parse(p.id)));

/** Labels (temperature / mandate / next action) are independent of stage; optional objection log entry. */
export const PATCH = dealsRoute<{ id: string }>({ mutation: true, scope: "opportunities.patch" }, async (req, ctx, p) => {
  const id = z.string().uuid().parse(p.id);
  const { expectedVersion, objection, ...labels } = await parseJson(req, Patch);
  const opportunity = await updateLabels(ctx, id, expectedVersion, labels);
  const obj = objection ? await logObjection(ctx, id, objection) : null;
  return { opportunity, objection: obj };
});
