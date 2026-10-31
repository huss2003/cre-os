import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { seedClosingChecklist, updateMilestone } from "@/modules/deals/pipeline/service";

const Body = z.union([
  z.object({ action: z.literal("seed") }),
  z.object({ action: z.literal("update"), milestoneId: z.string().uuid(), status: z.enum(["open", "in_progress", "done", "blocked", "waived", "not_applicable"]), proofText: z.string().max(2000).nullish(), dueDate: z.string().nullish() }),
]);

export const POST = dealsRoute<{ id: string }>({ mutation: true, scope: "opportunities.checklist" }, async (req, ctx, p) => {
  const b = await parseJson(req, Body);
  if (b.action === "seed") return { milestones: await seedClosingChecklist(ctx, z.string().uuid().parse(p.id)) };
  return { milestone: await updateMilestone(ctx, b.milestoneId, b) };
});
