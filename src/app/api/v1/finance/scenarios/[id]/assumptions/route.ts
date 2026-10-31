import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { approveAssumptions, listAssumptions } from "@/modules/deals/finance/service";

const Body = z.object({ keys: z.array(z.string().min(1).max(100)).min(1).max(100), note: z.string().max(1000).nullish() });

/** Assumptions register for a scenario version (key, label, value, source, approval state). */
export const GET = dealsRoute<{ id: string }>({}, async (_req, ctx, p) => ({ assumptions: await listAssumptions(ctx, z.string().uuid().parse(p.id)) }));

/** Approve assumptions (admin). An approval binds to the value hash: a changed value needs a new approval. */
export const POST = dealsRoute<{ id: string }>({ role: "admin", mutation: true, scope: "finance.assumptions.approve" }, async (req, ctx, p) => {
  const b = await parseJson(req, Body);
  return approveAssumptions(ctx, z.string().uuid().parse(p.id), b.keys, b.note ?? null);
});
