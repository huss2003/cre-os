import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { createOpportunity, listBoard } from "@/modules/deals/pipeline/service";

const Body = z.object({
  name: z.string().min(1).max(300), orgId: z.string().uuid().nullish(), requirementId: z.string().uuid().nullish(), stage: z.string().optional(),
  temperature: z.enum(["cold", "warm", "hot"]).nullish(), mandateStatus: z.enum(["none", "non_exclusive", "exclusive", "support", "unknown"]).nullish(),
  expectedFee: z.number().nonnegative().nullish(), creditShare: z.number().min(0).max(1).nullish(), expectedClose: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  nextAction: z.string().max(500).nullish(), nextActionDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), crmExternalId: z.string().max(100).nullish(),
});

export const GET = dealsRoute({}, async (req, ctx) => ({ opportunities: await listBoard(ctx, { includeClosed: req.nextUrl.searchParams.get("all") === "1" }) }));

export const POST = dealsRoute({ mutation: true, scope: "opportunities.create" }, async (req, ctx) => {
  const b = await parseJson(req, Body);
  return { opportunity: await createOpportunity(ctx, b) };
});
