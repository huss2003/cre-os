import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { addStakeholder } from "@/modules/deals/requirements/service";

const Body = z.object({ personId: z.string().uuid().nullish(), personName: z.string().max(200).nullish(), role: z.string(), influenceBasis: z.string().max(500).nullish(), accessStatus: z.string().max(200).nullish() });

export const POST = dealsRoute<{ id: string }>({ mutation: true, scope: "requirements.stakeholder" }, async (req, ctx, p) => {
  const b = await parseJson(req, Body);
  return { stakeholder: await addStakeholder(ctx, z.string().uuid().parse(p.id), b) };
});
