import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { seedClosingChecklist } from "@/modules/deals/pipeline/service";
import { updateMilestoneDetails } from "@/modules/deals/pipeline/closing-service";

const Body = z.union([
  z.object({ action: z.literal("seed") }),
  z.object({ action: z.literal("update"), milestoneId: z.string().uuid(), status: z.enum(["open", "in_progress", "done", "blocked", "waived", "not_applicable"]).optional(), proofText: z.string().max(2000).nullish(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), assigneeUserId: z.string().uuid().nullish(), ownerNote: z.string().max(200).nullish(), dependsOn: z.string().uuid().nullish() }),
]);

export const POST = dealsRoute<{ id: string }>({ mutation: true, scope: "opportunities.checklist" }, async (req, ctx, p) => {
  const b = await parseJson(req, Body);
  if (b.action === "seed") return { milestones: await seedClosingChecklist(ctx, z.string().uuid().parse(p.id)) };
  return { milestone: await updateMilestoneDetails(ctx, b.milestoneId, { status: b.status, proofText: b.proofText, dueDate: b.dueDate, assigneeUserId: b.assigneeUserId, ownerNote: b.ownerNote, dependsOn: b.dependsOn }) };
});
