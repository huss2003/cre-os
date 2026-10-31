import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { recalculateScenario } from "@/modules/deals/finance/service";
import type { FinanceInput } from "@/modules/deals/finance/types";

const Body = z.object({ input: z.custom<FinanceInput>((v) => typeof v === "object" && v !== null) });

/** Recalculate with changed inputs as a new immutable version (unchanged assumption approvals carry over). */
export const POST = dealsRoute<{ id: string }>({ mutation: true, scope: "finance.recalculate" }, async (req, ctx, p) => {
  const b = await parseJson(req, Body);
  const r = await recalculateScenario(ctx, z.string().uuid().parse(p.id), b.input);
  return { scenarioId: r.scenarioId, version: r.version, carriedApprovals: r.carriedApprovals, totals: r.result.totals, gaps: r.result.gaps, complete: r.result.complete, quoteIssues: r.quoteIssues };
});
