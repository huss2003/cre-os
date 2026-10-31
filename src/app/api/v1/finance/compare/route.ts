import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { compare, compareStoredScenarios } from "@/modules/deals/finance/service";
import type { FinanceInput } from "@/modules/deals/finance/types";

const Body = z.union([
  z.object({ inputs: z.array(z.custom<FinanceInput>((v) => typeof v === "object" && v !== null)).min(1).max(12) }),
  z.object({ scenarioIds: z.array(z.string().uuid()).min(1).max(12) }),
]);

/**
 * Equal-horizon comparison of raw inputs or stored scenario versions (first = baseline); unequal horizons/base
 * dates/discount rates are refused. Rows carry completeness (unknown costs). Pure (no writes).
 */
export const POST = dealsRoute({}, async (req, ctx) => {
  const b = await parseJson(req, Body);
  if ("scenarioIds" in b) {
    const c = await compareStoredScenarios(ctx, b.scenarioIds);
    return { scenarios: c.scenarios, error: c.error, baseline: c.comparison?.baseline ?? null, rows: c.comparison?.rows ?? [], warnings: c.comparison?.warnings ?? [], drivers: c.drivers };
  }
  const c = compare(b.inputs);
  return { baseline: c.baseline, rows: c.rows, warnings: c.warnings };
});
