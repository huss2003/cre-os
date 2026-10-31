import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { reviseQuote } from "@/modules/deals/quotes/service";

const Body = z.object({
  terms: z.record(z.string(), z.unknown()).optional(), validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), evidence: z.string().max(2000).nullish(),
  approvedFloor: z.number().nullish(), approvedCeiling: z.number().nullish(),
});

/** New quote version; the old one is superseded and dependent approvals/documents are invalidated. */
export const POST = dealsRoute<{ id: string; quoteId: string }>({ mutation: true, scope: "quotes.revise" }, async (req, ctx, p) => {
  const b = await parseJson(req, Body);
  return { quote: await reviseQuote(ctx, z.string().uuid().parse(p.quoteId), b) };
});
