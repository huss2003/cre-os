import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute, asHttp } from "@/modules/deals/api";
import { compareFinancingOffers, FinanceInputError } from "@/modules/deals/finance/engine";
import { DealsError } from "@/modules/deals/ctx";
import type { FinanceInput, FinancingInput } from "@/modules/deals/finance/types";

const Body = z.object({
  base: z.custom<FinanceInput>((v) => typeof v === "object" && v !== null),
  offers: z.array(z.custom<FinancingInput>((v) => typeof v === "object" && v !== null)).min(1).max(10),
});

/** Fit-out financing offers (tenant-configured partners) vs paying cash, on equal terms. Every offer is shown. */
export const POST = dealsRoute({}, async (req) => {
  const b = await parseJson(req, Body);
  try {
    const r = compareFinancingOffers(b.base, b.offers);
    return { cash: { npv: r.cash.totals.npv, nominalTco: r.cash.totals.nominalTco, outputHash: r.cash.outputHash }, offers: r.offers };
  } catch (e) {
    if (e instanceof FinanceInputError) asHttp(new DealsError(400, e.message, { field: e.field }));
    throw e;
  }
});
