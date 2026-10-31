import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { asHttp, dealsRoute } from "@/modules/deals/api";
import { DealsError } from "@/modules/deals/ctx";
import { funnel } from "@/modules/deals/pipeline/stages";

const Body = z.object({
  annualFeeTarget: z.number().positive().nullish(), closuresPerYear: z.number().int().positive().nullish(), feePerClosure: z.number().positive(),
  cohort: z.object({ approached: z.number().positive(), discussions: z.number().positive(), closures: z.number().positive() }),
  workdaysPerYear: z.number().int().positive().optional(), workdaysPerMonth: z.number().int().positive().optional(), lagMonths: z.number().int().positive().optional(),
});

/** Funnel / revenue feasibility calculator (spec §12). Pure; no writes. */
export const POST = dealsRoute({}, async (req) => {
  const b = await parseJson(req, Body);
  try { return funnel(b); } catch (e) { asHttp(new DealsError(400, (e as Error).message)); }
});
