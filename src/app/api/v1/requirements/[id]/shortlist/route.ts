import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { runShortlist } from "@/modules/deals/matching/service";
import { getRequirementDetail } from "@/modules/deals/requirements/service";

const Body = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), note: z.string().max(1000).nullish() });

/** Latest stored shortlist version. */
export const GET = dealsRoute<{ id: string }>({}, async (_req, ctx, p) => (await getRequirementDetail(ctx, z.string().uuid().parse(p.id))).shortlist);

/** Run match-v1 against live space snapshots and store a new shortlist version. */
export const POST = dealsRoute<{ id: string }>({ mutation: true, scope: "requirements.shortlist" }, async (req, ctx, p) => {
  const b = await parseJson(req, Body);
  const run = await runShortlist(ctx, z.string().uuid().parse(p.id), { asOf: b.asOf, note: b.note });
  return { version: run.version, shortlistVersionId: run.shortlistVersionId, asOf: run.asOf, requirementConfirmed: run.requirementConfirmed, warnings: run.warnings, options: run.results.slice(0, 50) };
});
