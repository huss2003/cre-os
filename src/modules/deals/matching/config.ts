/**
 * Matching configuration per requirement (workflow 09 "configurable criteria"): criterion weights, structured hard
 * specs (constraints.required_specs), catchment points and the optional hard-filter toggles. match-v1 reads all of
 * these from requirement.constraints.
 *
 * - Weights and catchment points are adviser configuration: written directly (optimistic concurrency).
 * - Required specs and hard filters are hard constraints: on a client-confirmed requirement they change only through
 *   proposeChange() → approval (S4); the SQL guards enforce the same.
 * - A spec set here is marked spec_sources[key] = "manual" so free-text answers never overwrite it;
 *   `resetDerived` hands keys back to the free-text parser.
 */
import { proposeChange } from "@/lib/services/changes";
import { type DealsCtx, DealsError, dbError, must } from "../ctx";
import {
  SPEC_DERIVATION, applyDerivedSpecs, type HardFilters, type RequiredSpecs, type RequirementConstraints, type RequirementRow, type SpecKey,
} from "../requirements/contract";
import { CRITERIA, type Criterion } from "./match";

export interface CatchmentPoint { label: string; lat: number; lon: number; weight?: number }
export interface MatchingConfigInput {
  /** null = back to the default weight for that criterion. */
  weights?: Partial<Record<Criterion, number | null>>;
  /** null clears a spec (kept cleared: marked manual). */
  requiredSpecs?: { [K in SpecKey]?: RequiredSpecs[K] | null };
  /** Replaces the whole list when given. */
  catchments?: CatchmentPoint[];
  hardFilters?: HardFilters;
  /** Spec keys to hand back to the free-text parser (power/parking/transit/... answers). */
  resetDerived?: SpecKey[];
}

const SPEC_KEYS: SpecKey[] = ["min_power_kva", "min_car_parks", "min_two_wheeler_parks", "max_metro_km", "certifications", "fitout_basis", "operating_24x7"];
const FITOUT = ["bare", "warm_shell", "fitted", "managed"];

function validSpec(k: SpecKey, v: unknown): unknown {
  if (v === null) return null;
  switch (k) {
    case "certifications": {
      const list = (Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean);
      return list.length ? list : null;
    }
    case "fitout_basis": {
      const list = (Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean);
      for (const x of list) if (!FITOUT.includes(x)) throw new DealsError(400, `fit-out basis must be one of ${FITOUT.join(", ")}`);
      return list.length ? list : null;
    }
    case "operating_24x7": return v === true || v === "true" ? true : v === false || v === "false" ? false : (() => { throw new DealsError(400, "operating_24x7 must be true/false"); })();
    default: {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new DealsError(400, `${k} must be a non-negative number`);
      return n;
    }
  }
}

/** Pure: new constraints + which parts changed. Validates every value; never invents one. */
export function buildMatchingConfig(req: RequirementRow, input: MatchingConfigInput): { constraints: RequirementConstraints; changed: Set<"weights" | "required_specs" | "catchments" | "hard_filters"> } {
  const c: RequirementConstraints = JSON.parse(JSON.stringify(req.constraints ?? {}));
  const changed = new Set<"weights" | "required_specs" | "catchments" | "hard_filters">();
  const before = JSON.stringify(req.constraints ?? {});
  if (input.weights) {
    const w = { ...(c.weights ?? {}) } as Record<string, number>;
    for (const [k, v] of Object.entries(input.weights)) {
      if (!CRITERIA.includes(k as Criterion)) throw new DealsError(400, `unknown criterion: ${k}`);
      if (v === null || v === undefined) delete w[k];
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 100) throw new DealsError(400, `weight for ${k} must be between 0 and 100`);
        w[k] = n;
      }
    }
    c.weights = w;
    if (JSON.stringify(c.weights) !== JSON.stringify(req.constraints?.weights ?? {})) changed.add("weights");
  }
  if (input.requiredSpecs || input.resetDerived?.length) {
    c.required_specs = { ...(c.required_specs ?? {}) };
    c.spec_sources = { ...(c.spec_sources ?? {}) };
    for (const [k, raw] of Object.entries(input.requiredSpecs ?? {})) {
      const key = k as SpecKey;
      if (!SPEC_KEYS.includes(key)) throw new DealsError(400, `unknown spec: ${k}`);
      if (raw === undefined) continue;
      const v = validSpec(key, raw);
      if (v === null) delete (c.required_specs as Record<string, unknown>)[key];
      else (c.required_specs as Record<string, unknown>)[key] = v;
      c.spec_sources[key] = "manual";
    }
    if (input.resetDerived?.length) {
      const fields = new Set<string>();
      for (const k of input.resetDerived) {
        if (!SPEC_KEYS.includes(k)) throw new DealsError(400, `unknown spec: ${k}`);
        delete c.spec_sources[k];
        delete (c.required_specs as Record<string, unknown>)[k];
        for (const [f, keys] of Object.entries(SPEC_DERIVATION)) if (keys.includes(k)) fields.add(f);
      }
      applyDerivedSpecs(c, [...fields]);
    }
    if (JSON.stringify([c.required_specs, c.spec_sources]) !== JSON.stringify([req.constraints?.required_specs ?? {}, req.constraints?.spec_sources ?? {}])) changed.add("required_specs");
  }
  if (input.catchments) {
    if (input.catchments.length > 20) throw new DealsError(400, "at most 20 catchment points");
    c.catchments = input.catchments.map((p, i) => {
      const lat = Number(p.lat), lon = Number(p.lon);
      if (!p.label?.trim()) throw new DealsError(400, `catchment ${i + 1}: label is required`);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) throw new DealsError(400, `catchment “${p.label}”: latitude/longitude out of range`);
      const weight = p.weight === undefined || p.weight === null ? undefined : Number(p.weight);
      if (weight !== undefined && (!Number.isFinite(weight) || weight <= 0)) throw new DealsError(400, `catchment “${p.label}”: weight must be > 0`);
      return { label: p.label.trim(), lat, lon, ...(weight !== undefined ? { weight } : {}) };
    });
    if (JSON.stringify(c.catchments) !== JSON.stringify(req.constraints?.catchments ?? [])) changed.add("catchments");
  }
  if (input.hardFilters) {
    c.hard_filters = { budget_ceiling: !!input.hardFilters.budget_ceiling, latest_occupation: !!input.hardFilters.latest_occupation, preferred_only: !!input.hardFilters.preferred_only };
    if (JSON.stringify(c.hard_filters) !== JSON.stringify({ budget_ceiling: false, latest_occupation: false, preferred_only: false, ...(req.constraints?.hard_filters ?? {}) })) changed.add("hard_filters");
  }
  if (JSON.stringify(c) === before) changed.clear();
  return { constraints: c, changed };
}

export interface MatchingConfigResult { requirement: Record<string, unknown>; applied: string[]; proposalId: string | null }

/**
 * Save matching configuration. On a client-confirmed requirement, spec / hard-filter changes become one change proposal
 * (nothing applied directly); weights and catchments still apply directly.
 */
export async function updateMatchingConfig(ctx: DealsCtx, id: string, expectedVersion: number, input: MatchingConfigInput, reason = "", idempotencyKey?: string | null): Promise<MatchingConfigResult> {
  const req = must(await ctx.db.from("requirement").select("*").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle(), "requirement") as RequirementRow & Record<string, unknown>;
  if (Number(req.row_version) !== Number(expectedVersion)) throw new DealsError(409, "stale_version: the requirement changed, reload and retry");
  const locked = req.status === "client_confirmed";
  const directInput: MatchingConfigInput = locked ? { weights: input.weights, catchments: input.catchments } : input;
  const lockedInput: MatchingConfigInput | null = locked && (input.requiredSpecs || input.hardFilters || input.resetDerived?.length)
    ? { requiredSpecs: input.requiredSpecs, hardFilters: input.hardFilters, resetDerived: input.resetDerived } : null;
  let current: Record<string, unknown> = req;
  const applied: string[] = [];
  const direct = buildMatchingConfig(req, directInput);
  if (direct.changed.size) {
    const upd = await ctx.db.rpc("deals_update_requirement", { p_id: id, p_expected_version: expectedVersion, p_patch: { constraints: direct.constraints } });
    if (upd.error) throw dbError(upd.error, "requirement");
    current = upd.data as Record<string, unknown>;
    applied.push(...direct.changed);
    const { data: last } = await ctx.db.from("requirement_version").select("version").eq("requirement_id", id).order("version", { ascending: false }).limit(1).maybeSingle();
    await ctx.db.from("requirement_version").insert({
      workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, classification: String(current.classification ?? "corporate_confidential"),
      requirement_id: id, version: ((last as { version: number } | null)?.version ?? 0) + 1, snapshot: { constraints: current.constraints },
      field_status: (current.constraints as RequirementConstraints | null)?.field_status ?? {}, change_reason: reason || `matching config: ${[...direct.changed].join(", ")}`,
    });
  }
  let proposalId: string | null = null;
  if (lockedInput) {
    const prop = buildMatchingConfig(current as RequirementRow, lockedInput);
    if (prop.changed.size) {
      const cp = await proposeChange(ctx.db, ctx.workspaceId, {
        targetType: "requirement", targetId: id, operation: "update", expectedVersion: Number(current.row_version),
        patch: [{ op: "replace", path: "/constraints", value: prop.constraints }],
        reason: reason || `Hard-constraint change on a client-confirmed requirement: ${[...prop.changed].join(", ")}`,
        proposedByKind: "user", ownerUserId: ctx.userId, classification: String(current.classification ?? "corporate_confidential"),
        idempotencyKey: idempotencyKey ? `deals.match_cfg:${id}:${idempotencyKey}` : undefined, before: { constraints: current.constraints ?? null },
      });
      proposalId = (cp as { id: string }).id;
    }
  }
  return { requirement: current, applied, proposalId };
}
