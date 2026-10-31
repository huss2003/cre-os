import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { getRequirementDetail, updateRequirementFields } from "@/modules/deals/requirements/service";

const Patch = z.object({
  expectedVersion: z.number().int(),
  reason: z.string().max(1000).default(""),
  changes: z.array(z.object({ key: z.string(), value: z.unknown().optional(), status: z.enum(["client_confirmed", "estimated", "unknown"]).optional() })).min(1).max(60),
});

export const GET = dealsRoute<{ id: string }>({}, async (_req, ctx, p) => getRequirementDetail(ctx, z.string().uuid().parse(p.id)));

/** Estimated fields are written directly; confirmed fields return change proposals awaiting approval. */
export const PATCH = dealsRoute<{ id: string }>({ mutation: true, scope: "requirements.patch" }, async (req, ctx, p) => {
  const b = await parseJson(req, Patch);
  return updateRequirementFields(ctx, z.string().uuid().parse(p.id), b.expectedVersion, b.changes, b.reason, req.headers.get("idempotency-key"));
});
