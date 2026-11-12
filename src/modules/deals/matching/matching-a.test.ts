/**
 * Workflow 09 Property Adviser — round-2 acceptance (pure): hard-filter toggles, "why it qualifies", coded
 * verification items → deduped tasks, settable matching configuration.
 */
import { describe, it, expect } from "vitest";
import { rankOptions, evaluateOption, type Candidate } from "./match";
import { buildMatchingConfig } from "./config";
import { planVerificationTasks, verifyTaskKey } from "./verify-tasks";
import type { RequirementRow } from "../requirements/contract";
import { DealsError } from "../ctx";

const AS_OF = "2026-11-01";
const req = (over: Partial<RequirementRow> = {}): RequirementRow => ({
  area_min_sf: 15000, area_target_sf: 20000, area_max_sf: 25000, area_basis: "chargeable",
  budget_min: 70, budget_max: 90, budget_basis: "per_sf_month",
  preferred_geography_ids: ["baner"], excluded_geography_ids: ["hinjewadi-3"],
  occupation_date: "2027-03-01",
  constraints: { required_specs: { min_power_kva: 500 } },
  ...over,
});
const cand = (id: string, o: { rent?: number; locality?: string | null; power?: number | null; from?: string | null; asOf?: string; validUntil?: string } = {}): Candidate => ({
  space: { id, asset_id: `a-${id}`, chargeable_sf: 20000, floor_text: "3" },
  asset: { id: `a-${id}`, name: `Tower ${id}`, locality_id: o.locality === null ? null : o.locality ?? "baner", specs: o.power === null ? {} : { power_kva: o.power ?? 800 }, certifications: [{ name: "IGBC Platinum" }] },
  availability: {
    id: `av-${id}`, as_of: o.asOf ?? "2026-10-25", status: "available", available_from: o.from === null ? null : o.from ?? "2027-01-01",
    asking_rent_min: o.rent ?? 80, asking_rent_max: o.rent ?? 80, rent_basis: "chargeable", valid_until: o.validUntil ?? "2026-12-31", fact_status: "currently_confirmed",
  },
});

describe("09 · optional hard filters (default off = scored)", () => {
  it("budget ceiling: off → over-budget option is scored, on → ineligible and ranked below a cheaper eligible one", () => {
    const pricey = cand("pricey", { rent: 120 });
    const off = evaluateOption(req(), pricey, { asOf: AS_OF });
    expect(off.eligibility).toBe("eligible");
    expect(off.criteria.cost.score).toBe(0);
    const on = req({ constraints: { required_specs: { min_power_kva: 500 }, hard_filters: { budget_ceiling: true } } });
    const ranked = rankOptions(on, [pricey, cand("cheap", { rent: 85, locality: "wakad" })], { asOf: AS_OF });
    const p = ranked.find((r) => r.spaceId === "pricey")!;
    expect(p.eligibility).toBe("ineligible");
    expect(p.disqualifiers.join()).toMatch(/above budget ceiling 90/);
    expect(ranked[0].spaceId).toBe("cheap");
  });
  it("hard constraints cannot be overridden by a high weighted score (latest occupation + preferred-only)", () => {
    const r = req({ constraints: { required_specs: { min_power_kva: 500 }, hard_filters: { latest_occupation: true, preferred_only: true }, weights: { location: 100, cost: 0, readiness: 0, technical: 0, flexibility: 0, sustainability: 0 } } });
    const late = cand("late", { from: "2027-06-01" });           // perfect location, available too late
    const outside = cand("outside", { locality: "wakad" });       // outside preferred
    const fine = cand("fine", { rent: 89, from: "2027-02-01" });
    const ranked = rankOptions(r, [late, outside, fine], { asOf: AS_OF });
    expect(ranked.map((x) => [x.spaceId, x.eligibility])).toEqual([["fine", "eligible"], ["late", "ineligible"], ["outside", "ineligible"]]);
    expect(ranked[1].fitScore).toBe(100);
    expect(ranked[1].disqualifiers.join()).toMatch(/after the required occupation date 2027-03-01/);
    expect(ranked[2].disqualifiers.join()).toMatch(/Outside the preferred locations/);
  });
  it("missing data under a hard filter is 'needs verification', never a match", () => {
    const r = req({ constraints: { required_specs: { min_power_kva: 500 }, hard_filters: { latest_occupation: true, preferred_only: true } } });
    const o = evaluateOption(r, cand("x", { from: null, locality: null }), { asOf: AS_OF });
    expect(o.eligibility).toBe("needs_verification");
    expect(o.verification.map((v) => v.code).sort()).toEqual(["available_from_unknown", "geo_unknown"]);
  });
});

describe("09 · each option explains why it qualifies; fit and completeness are separate", () => {
  it("lists the evidence for every hard check passed, plus per-criterion details", () => {
    const o = evaluateOption(req(), cand("ok"), { asOf: AS_OF });
    expect(o.eligibility).toBe("eligible");
    expect(o.qualifies).toEqual([
      "Space snapshot: available as of 2026-10-25 (currently confirmed)",
      "Not in an excluded location",
      "Area 20,000 SF chargeable within 15,000–25,000 SF",
      "Meets power ≥ 500 kVA (building: 800)",
    ]);
    expect(o.criteria.location.detail).toBe("in preferred area");
    expect(typeof o.fitScore).toBe("number");
    expect(typeof o.completenessScore).toBe("number");
    const unknownPower = evaluateOption(req(), cand("u", { power: null }), { asOf: AS_OF });
    expect(unknownPower.fitScore).toBeLessThan(o.fitScore);
    expect(unknownPower.completenessScore).toBeLessThan(o.completenessScore);
  });
});

describe("09 · verification items become deduped verification tasks", () => {
  it("codes are stable across dates; re-runs never duplicate; resolved items close; re-flagged items reopen", () => {
    const r1 = rankOptions(req(), [cand("s", { power: null, asOf: "2026-08-01", validUntil: "2026-09-01" })], { asOf: AS_OF });
    const r2 = rankOptions(req(), [cand("s", { power: null, asOf: "2026-08-15", validUntil: "2026-09-15" })], { asOf: AS_OF });
    expect(r1[0].verification.map((v) => v.code)).toEqual(r2[0].verification.map((v) => v.code));
    expect(r1[0].verificationNeeded[0]).not.toBe(r2[0].verificationNeeded[0]); // texts carry dates, codes do not
    const p1 = planVerificationTasks("REQ", r1, []);
    expect(p1.create.map((c) => c.key).sort()).toEqual([verifyTaskKey("REQ", "s", "availability_stale"), verifyTaskKey("REQ", "s", "spec:power_kva")].sort());
    const existing = p1.create.map((c, i) => ({ id: `t${i}`, idempotency_key: c.key, status: "open" }));
    expect(planVerificationTasks("REQ", r2, existing).create).toEqual([]);
    const fixed = rankOptions(req(), [cand("s", { power: 900 })], { asOf: AS_OF });
    const p3 = planVerificationTasks("REQ", fixed, existing);
    expect(p3.close.sort()).toEqual(["t0", "t1"]);
    const p4 = planVerificationTasks("REQ", r1, existing.map((t) => ({ ...t, status: "done" })));
    expect(p4.reopen).toHaveLength(2);
  });
});

describe("09 · matching configuration is settable", () => {
  it("weights, specs (manual beats derived), catchments and hard filters validate and report what changed", () => {
    const base: RequirementRow = { constraints: { values: { power: "500 kVA" }, required_specs: { min_power_kva: 500 }, spec_sources: { min_power_kva: "derived:power" } } };
    const c = buildMatchingConfig(base, {
      weights: { location: 40, cost: null }, requiredSpecs: { min_power_kva: 650, certifications: ["LEED Gold"], fitout_basis: ["warm_shell"] },
      catchments: [{ label: "Hinjewadi staff", lat: 18.59, lon: 73.74, weight: 2 }], hardFilters: { budget_ceiling: true },
    });
    expect([...c.changed].sort()).toEqual(["catchments", "hard_filters", "required_specs", "weights"]);
    expect(c.constraints.weights).toEqual({ location: 40 });
    expect(c.constraints.required_specs).toEqual({ min_power_kva: 650, certifications: ["LEED Gold"], fitout_basis: ["warm_shell"] });
    expect(c.constraints.spec_sources).toMatchObject({ min_power_kva: "manual", certifications: "manual" });
    expect(c.constraints.hard_filters).toEqual({ budget_ceiling: true, latest_occupation: false, preferred_only: false });
    const reset = buildMatchingConfig({ constraints: c.constraints }, { resetDerived: ["min_power_kva"] });
    expect(reset.constraints.required_specs!.min_power_kva).toBe(500);
    expect(reset.constraints.spec_sources!.min_power_kva).toBe("derived:power");
    expect(buildMatchingConfig(base, { weights: {} }).changed.size).toBe(0);
    expect(() => buildMatchingConfig(base, { weights: { location: 140 } })).toThrow(DealsError);
    expect(() => buildMatchingConfig(base, { catchments: [{ label: "x", lat: 95, lon: 0 }] })).toThrow(/out of range/);
    expect(() => buildMatchingConfig(base, { requiredSpecs: { fitout_basis: ["shell"] } })).toThrow(/fit-out basis/);
  });
  it("the configured weights and catchments drive the score", () => {
    const r = req({ preferred_geography_ids: [], constraints: { required_specs: {}, catchments: [{ label: "Baner office", lat: 18.56, lon: 73.78 }] } });
    const near = cand("near"); near.asset.lat = 18.561; near.asset.lon = 73.781;
    const far = cand("far"); far.asset.lat = 18.9; far.asset.lon = 74.2;
    const ranked = rankOptions(r, [far, near], { asOf: AS_OF });
    expect(ranked[0].spaceId).toBe("near");
    expect(ranked[0].criteria.location.detail).toMatch(/Baner office 0\.\d km/);
  });
});
