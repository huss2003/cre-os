import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { recordFeeMilestone, updateFeeMilestone } from "@/modules/deals/pipeline/service";

const money = z.number().nonnegative().nullish();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish();
const Body = z.object({
  milestoneId: z.string().uuid().optional(), gross_fee: money, credit_share: z.number().min(0).max(1).nullish(), milestone: z.string().max(200).nullish(),
  invoiced_amount: money, invoiced_on: date, recognised_amount: money, recognised_on: date, collected_amount: money, collected_on: date,
  evidence: z.string().max(2000).nullish(), tax_basis: z.string().max(200).nullish(), exclusions: z.string().max(1000).nullish(),
});

/** Gross / credit / invoiced / recognised / collected recorded separately, each with evidence (DB-enforced). */
export const POST = dealsRoute<{ id: string }>({ mutation: true, scope: "opportunities.fees" }, async (req, ctx, p) => {
  const { milestoneId, ...b } = await parseJson(req, Body);
  if (milestoneId) return { fee: await updateFeeMilestone(ctx, milestoneId, b) };
  return { fee: await recordFeeMilestone(ctx, z.string().uuid().parse(p.id), b) };
});
