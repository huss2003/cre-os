import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { createQuote, listQuotes } from "@/modules/deals/quotes/service";

const QuoteBody = z.object({
  spaceId: z.string().uuid().nullish(), counterpartyOrgId: z.string().uuid().nullish(),
  terms: z.record(z.string(), z.unknown()), validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), evidence: z.string().max(2000).nullish(),
  approvedFloor: z.number().nullish(), approvedCeiling: z.number().nullish(),
});

export const GET = dealsRoute<{ id: string }>({}, async (_req, ctx, p) => ({ quotes: await listQuotes(ctx, z.string().uuid().parse(p.id)) }));

export const POST = dealsRoute<{ id: string }>({ mutation: true, scope: "quotes.create" }, async (req, ctx, p) => {
  const b = await parseJson(req, QuoteBody);
  return { quote: await createQuote(ctx, { ...b, requirementId: z.string().uuid().parse(p.id) }) };
});
