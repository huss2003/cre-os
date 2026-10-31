import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { createExperiment, experimentsData, ExperimentInput } from "@/modules/intelligence/insights/service";

export const GET = route(async () => {
  const ctx = await requireContext();
  return { experiments: await guard(experimentsData(ctx.db, ctx.workspaceId)) };
});

export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, ExperimentInput);
  return guard(createExperiment(ctx.db, ctx.workspaceId, b, ctx.userId));
}, { requireIdempotency: true });
