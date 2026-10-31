import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { concessions } from "@/modules/deals/finance/service";
import type { Concession } from "@/modules/deals/finance/engine";
import type { FinanceInput } from "@/modules/deals/finance/types";

const Body = z.object({
  base: z.custom<FinanceInput>((v) => typeof v === "object" && v !== null),
  concessions: z.array(z.custom<Concession>((v) => typeof v === "object" && v !== null && "type" in (v as object))).min(1).max(20),
});

/** Concession equivalence: rent-free / capex support / deposit / escalation / rent → comparable NPV. */
export const POST = dealsRoute({}, async (req) => {
  const b = await parseJson(req, Body);
  return { values: concessions(b.base, b.concessions) };
});
