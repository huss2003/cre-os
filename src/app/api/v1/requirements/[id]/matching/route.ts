import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { updateMatchingConfig } from "@/modules/deals/matching/config";
import { getRequirementDetail } from "@/modules/deals/requirements/service";

const Weight = z.number().min(0).max(100).nullable();
const Body = z.object({
  expectedVersion: z.number().int(),
  reason: z.string().max(1000).default(""),
  weights: z.object({ location: Weight, cost: Weight, readiness: Weight, technical: Weight, flexibility: Weight, sustainability: Weight }).partial().optional(),
  requiredSpecs: z.object({
    min_power_kva: z.number().min(0).nullable(), min_car_parks: z.number().min(0).nullable(), min_two_wheeler_parks: z.number().min(0).nullable(),
    max_metro_km: z.number().min(0).nullable(), certifications: z.array(z.string()).nullable(), fitout_basis: z.array(z.enum(["bare", "warm_shell", "fitted", "managed"])).nullable(),
    operating_24x7: z.boolean().nullable(),
  }).partial().optional(),
  catchments: z.array(z.object({ label: z.string().min(1).max(200), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), weight: z.number().positive().optional() })).max(20).optional(),
  hardFilters: z.object({ budget_ceiling: z.boolean(), latest_occupation: z.boolean(), preferred_only: z.boolean() }).partial().optional(),
  resetDerived: z.array(z.enum(["min_power_kva", "min_car_parks", "min_two_wheeler_parks", "max_metro_km", "certifications", "fitout_basis", "operating_24x7"])).optional(),
});

/** Current matching configuration (weights, structured specs + provenance, catchments, hard filters). */
export const GET = dealsRoute<{ id: string }>({}, async (_req, ctx, p) => {
  const d = await getRequirementDetail(ctx, z.string().uuid().parse(p.id));
  const c = (d.requirement.constraints ?? {}) as Record<string, unknown>;
  return { weights: c.weights ?? {}, requiredSpecs: c.required_specs ?? {}, specSources: c.spec_sources ?? {}, catchments: c.catchments ?? [], hardFilters: c.hard_filters ?? {}, hardConstraints: d.hardConstraints };
});

/** Save matching configuration. Hard-constraint changes on a client-confirmed requirement return a change proposal. */
export const PATCH = dealsRoute<{ id: string }>({ mutation: true, scope: "requirements.matching" }, async (req, ctx, p) => {
  const b = await parseJson(req, Body);
  return updateMatchingConfig(ctx, z.string().uuid().parse(p.id), b.expectedVersion, b, b.reason, req.headers.get("idempotency-key"));
});
