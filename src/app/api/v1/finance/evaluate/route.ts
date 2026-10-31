import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { evaluateScenario } from "@/modules/deals/finance/service";
import type { FinanceInput } from "@/modules/deals/finance/types";

const Body = z.object({
  input: z.custom<FinanceInput>((v) => typeof v === "object" && v !== null && !Array.isArray(v), "input must be a finance input object"),
  requirementId: z.string().uuid().nullish(), optionId: z.string().uuid().nullish(), save: z.boolean().default(false),
});

/** Deterministic engine fin-1.0: typed inputs + quote versions → cash flows, TCO, NPV, sensitivities, output hash. */
export const POST = dealsRoute({ mutation: true, scope: "finance.evaluate" }, async (req, ctx) => {
  const b = await parseJson(req, Body);
  return evaluateScenario(ctx, b);
});
