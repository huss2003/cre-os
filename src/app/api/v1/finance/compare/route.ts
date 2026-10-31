import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { compare } from "@/modules/deals/finance/service";
import type { FinanceInput } from "@/modules/deals/finance/types";

const Body = z.object({ inputs: z.array(z.custom<FinanceInput>((v) => typeof v === "object" && v !== null)).min(1).max(12) });

/** Equal-horizon comparison; unequal horizons/base dates/discount rates are refused. Pure (no writes). */
export const POST = dealsRoute({}, async (req) => {
  const b = await parseJson(req, Body);
  const c = compare(b.inputs);
  return { baseline: c.baseline, rows: c.rows, warnings: c.warnings };
});
