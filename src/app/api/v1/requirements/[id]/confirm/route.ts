import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { confirmRequirement } from "@/modules/deals/requirements/service";

const Body = z.object({ expectedVersion: z.number().int(), evidence: z.string().min(3).max(2000), confirmedByPersonId: z.string().uuid().nullish() });

export const POST = dealsRoute<{ id: string }>({ mutation: true, scope: "requirements.confirm" }, async (req, ctx, p) => {
  const b = await parseJson(req, Body);
  return { requirement: await confirmRequirement(ctx, z.string().uuid().parse(p.id), b.expectedVersion, b) };
});
