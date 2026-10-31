import { describe, it, expect } from "vitest";
import { rankOptions, evaluateOption, effectiveWeights, RUBRIC_VERSION, type Candidate } from "./match";
import type { RequirementRow } from "../requirements/contract";

const AS_OF = "2026-11-01";
const req = (over: Partial<RequirementRow> = {}): RequirementRow => ({
  area_min_sf: 15000, area_target_sf: 20000, area_max_sf: 25000, area_basis: "chargeable",
  budget_min: 70, budget_max: 90, budget_basis: "per_sf_month",
  preferred_geography_ids: ["baner"], excluded_geography_ids: ["hinjewadi-3"],
  occupation_date: "2027-03-01",
  constraints: { required_specs: { min_power_kva: 500 } },
  ...over,
});
const cand = (id: string, o: { area?: number; status?: Candidate["availability"] extends infer A ? A extends { status: infer S } ? S : never : never; rent?: number; locality?: string; power?: number | null; validUntil?: string | null; asOf?: string; certs?: { name: string }[]; noAvailability?: boolean; fact?: string; quote?: Candidate["quote"]; buildingTotal?: number } = {}): Candidate => ({
  space: { id, asset_id: `a-${id}`, chargeable_sf: o.area ?? 20000, floor_text: "3" },
  asset: {
    id: `a-${id}`, name: `Tower ${id}`, locality_id: o.locality ?? "baner",
    specs: o.power === null ? {} : { power_kva: o.power ?? 800 }, certifications: o.certs ?? [{ name: "IGBC Platinum" }],
    total_area_sf: o.buildingTotal ?? 500000,
  },
  availability: o.noAvailability ? null : {
    id: `av-${id}`, as_of: o.asOf ?? "2026-10-25", status: o.status ?? "available", available_from: "2027-01-01",
    asking_rent_min: o.rent ?? 80, asking_rent_max: o.rent ?? 80, rent_basis: "chargeable", valid_until: o.validUntil === undefined ? "2026-12-31" : o.validUntil,
    fact_status: o.fact ?? "currently_confirmed",
  },
  quote: o.quote ?? null,
});

describe(`property matching ${RUBRIC_VERSION} (acceptance test: Shortlist)`, () => {
  it("default weights are 25/25/20/15/10/5 and per-requirement overrides apply", () => {
    expect(effectiveWeights(req())).toEqual({ location: 25, cost: 25, readiness: 20, technical: 15, flexibility: 10, sustainability: 5 });
    expect(effectiveWeights(req({ constraints: { weights: { location: 40, cost: 10 } } })).location).toBe(40);
  });

  it("hard-ineligible space is never promoted by a high score", () => {
    // 'bad' is cheaper, perfectly located, certified — but in an excluded location; 'ok' is pricier.
    const bad = cand("bad", { locality: "hinjewadi-3", rent: 60 });
    const ok = cand("ok", { rent: 95, certs: [] });
    const ranked = rankOptions(req({ preferred_geography_ids: ["baner", "hinjewadi-3"] }), [bad, ok], { asOf: AS_OF });
    const b = ranked.find((r) => r.spaceId === "bad")!;
    const o = ranked.find((r) => r.spaceId === "ok")!;
    expect(b.eligibility).toBe("ineligible");
    expect(b.fitScore).toBeGreaterThan(o.fitScore);
    expect(ranked[0].spaceId).toBe("ok");
    expect(b.flags.clientReleaseBlocked).toBe(true);
  });

  it("area range is checked on the space snapshot on the typed basis, not the building total", () => {
    const small = cand("small", { area: 8000, buildingTotal: 20000 });
    const r = evaluateOption(req(), small, { asOf: AS_OF });
    expect(r.eligibility).toBe("ineligible");
    expect(r.disqualifiers[0]).toMatch(/chargeable area 8000 SF outside/);
    expect(r.area).toEqual({ value: 8000, basis: "chargeable", derived: false });
  });

  it("carpet-basis requirement uses carpet area (or efficiency conversion flagged for verification)", () => {
    const c = cand("c", { area: 20000 });
    c.space.carpet_sf = null; c.space.efficiency = 0.7; // 14,000 carpet
    const r = evaluateOption(req({ area_basis: "carpet", area_min_sf: 12000, area_target_sf: 14000, area_max_sf: 16000 }), c, { asOf: AS_OF });
    expect(r.area).toEqual({ value: 14000, basis: "carpet", derived: true });
    expect(r.eligibility).toBe("needs_verification");
  });

  it("unknown vacancy is shown as unverified, never eligible", () => {
    const none = evaluateOption(req(), cand("n", { noAvailability: true }), { asOf: AS_OF });
    expect(none.flags.vacancyUnverified).toBe(true);
    expect(none.eligibility).toBe("needs_verification");
    const unv = evaluateOption(req(), cand("u", { status: "unverified" }), { asOf: AS_OF });
    expect(unv.flags.vacancyUnverified).toBe(true);
    expect(unv.eligibility).toBe("needs_verification");
    const reported = evaluateOption(req(), cand("r", { fact: "reported" }), { asOf: AS_OF });
    expect(reported.flags.vacancyUnverified).toBe(true);
    expect(reported.flags.clientReleaseBlocked).toBe(true);
    const leased = evaluateOption(req(), cand("l", { status: "leased" }), { asOf: AS_OF });
    expect(leased.eligibility).toBe("ineligible");
  });

  it("availability decay: past valid_until (or decay window) is stale and blocks client release", () => {
    const expired = evaluateOption(req(), cand("e", { validUntil: "2026-10-30" }), { asOf: AS_OF });
    expect(expired.flags.availabilityStale).toBe(true);
    expect(expired.flags.clientReleaseBlocked).toBe(true);
    const noValidity = evaluateOption(req(), cand("v", { validUntil: null, asOf: "2026-09-01" }), { asOf: AS_OF, availabilityDecayDays: 30 });
    expect(noValidity.flags.availabilityStale).toBe(true);
    const fresh = evaluateOption(req(), cand("f"), { asOf: AS_OF });
    expect(fresh.flags.availabilityStale).toBe(false);
    expect(fresh.eligibility).toBe("eligible");
  });

  it("missing technical data is never scored as meeting a constraint; it needs verification", () => {
    const known = evaluateOption(req(), cand("k", { power: 800 }), { asOf: AS_OF });
    const unknown = evaluateOption(req(), cand("x", { power: null }), { asOf: AS_OF });
    expect(known.criteria.technical.score).toBe(1);
    expect(unknown.criteria.technical.status).toBe("unknown");
    expect(unknown.criteria.technical.score).toBe(0);
    expect(unknown.fitScore).toBeLessThan(known.fitScore);
    expect(unknown.completenessScore).toBeLessThan(known.completenessScore);
    expect(unknown.eligibility).toBe("needs_verification");
    const fails = evaluateOption(req(), cand("f", { power: 300 }), { asOf: AS_OF });
    expect(fails.eligibility).toBe("ineligible");
  });

  it("fit and completeness are separate; rent-only cost (CAM unknown) never gets full cost credit", () => {
    const r = evaluateOption(req(), cand("a", { rent: 80 }), { asOf: AS_OF });
    expect(r.criteria.cost.score).toBe(0.5);
    const withQuote = evaluateOption(req(), cand("q", { rent: 80, quote: { id: "q1", version: 2, valid_until: "2026-12-31", terms_json: { rent: 78, rent_basis: "chargeable", cam_per_sf: 10 } } }), { asOf: AS_OF });
    expect(withQuote.criteria.cost.score).toBe(1); // 88 ≤ 90
    expect(withQuote.allInCostPerUnit).toBe(88);
    expect(withQuote.completenessScore).toBeGreaterThan(r.completenessScore);
  });

  it("expired or superseded quote blocks release and is not used for cost", () => {
    const r = evaluateOption(req(), cand("q", { quote: { id: "q1", version: 1, valid_until: "2026-10-01", terms_json: { rent: 50, rent_basis: "chargeable", cam_per_sf: 5 } } }), { asOf: AS_OF });
    expect(r.flags.quoteExpired).toBe(true);
    expect(r.flags.clientReleaseBlocked).toBe(true);
    expect(r.criteria.cost.detail).toMatch(/asking/);
  });

  it("weights renormalise over applicable criteria only; scores are deterministic", () => {
    const rq = req({ constraints: {}, preferred_geography_ids: [], occupation_date: null });
    const a = rankOptions(rq, [cand("1"), cand("2", { rent: 100 })], { asOf: AS_OF });
    const b = rankOptions(rq, [cand("2", { rent: 100 }), cand("1")], { asOf: AS_OF });
    expect(a.map((x) => [x.spaceId, x.fitScore])).toEqual(b.map((x) => [x.spaceId, x.fitScore]));
    expect(a[0].criteria.location.status).toBe("not_applicable");
    // cost (25, 0.5 — CAM unknown), flexibility (10, unknown → 0: area max 25,000 > space 20,000 so growth room is
    // a constraint but expansion space is unknown) and sustainability (5, 1) apply: (12.5 + 0 + 5)/40 = 43.75
    expect(a[0].criteria.flexibility.status).toBe("unknown");
    expect(a[0].fitScore).toBe(43.75);
  });
});
