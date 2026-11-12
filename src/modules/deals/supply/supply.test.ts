/** Module 14 — pure rules: statuses, terms, hierarchy, hard filters before scoring, explanation, reconfirmation. */
import { describe, it, expect } from "vitest";
import { availabilityStatus, canDivide, combineSpaces, commercialTerms, reconfirmationChecks, SUPPLY_STATUSES } from "./supply";
import { matchCandidates } from "./service";
import type { Candidate } from "../matching/match";
import type { RequirementRow } from "../requirements/contract";

const AS_OF = "2026-11-12";
const av = (o: Record<string, unknown> = {}) => ({ id: "av", as_of: "2026-11-05", status: "available" as const, available_from: "2026-11-01", valid_until: "2026-12-31",
  fact_status: "currently_confirmed", last_verified_on: "2026-11-05", asking_rent_max: 80, rent_basis: "chargeable" as const, cam_psf_month: 12, ...o });
const cand = (id: string, o: { av?: Record<string, unknown> | null; category?: string | null; status?: string; completion?: string; specs?: Record<string, unknown> } = {}): Candidate => ({
  space: { id, asset_id: `a-${id}`, chargeable_sf: 20000, floor_text: "4" },
  asset: { id: `a-${id}`, name: `Tower ${id}`, locality_id: "baner", category: o.category === undefined ? "conventional_office" : o.category, status: o.status ?? "ready",
    completion_date: o.completion ?? null, specs: o.specs ?? { power_kva: 800, car_parks: 50 }, certifications: [{ name: "IGBC Gold" }] },
  availability: o.av === null ? null : (av(o.av) as never),
});
const req: RequirementRow = { area_min_sf: 15000, area_max_sf: 25000, area_basis: "chargeable", budget_max: 100, budget_basis: "per_sf_month",
  preferred_geography_ids: ["baner"], occupation_date: "2027-01-01" };

describe("E · availability statuses", () => {
  it("supports all nine statuses", () => {
    expect(SUPPLY_STATUSES).toHaveLength(9);
    for (const s of SUPPLY_STATUSES) expect(availabilityStatus(av({ supply_status: s, available_from: null }), { asOf: AS_OF }).status).toBe(s);
  });
  it("lease expiry does not establish vacancy", () => {
    const r = availabilityStatus(null, { asOf: AS_OF, leaseExpiry: "2026-12-31" });
    expect(r.status).toBe("unconfirmed"); expect(r.leaseExpiryOnly).toBe(true); expect(r.immediate).toBe(false); expect(r.confidence).toBe("none");
  });
  it("future supply is not immediate availability (future date or under-construction building)", () => {
    expect(availabilityStatus(av({ available_from: "2027-03-01" }), { asOf: AS_OF }).status).toBe("future_available");
    const uc = availabilityStatus(av({ available_from: null }), { asOf: AS_OF, assetStatus: "under_construction", assetCompletion: "2027-06-30" });
    expect(uc.immediate).toBe(false); expect(uc.availableFrom).toBe("2027-06-30");
  });
  it("confidence: confirmed+fresh → high; stale → low; reported → low", () => {
    expect(availabilityStatus(av(), { asOf: AS_OF }).confidence).toBe("high");
    expect(availabilityStatus(av({ valid_until: "2026-10-01" }), { asOf: AS_OF }).stale).toBe(true);
    expect(availabilityStatus(av({ fact_status: "reported" }), { asOf: AS_OF }).confidence).toBe("low");
  });
});

describe("D · commercial terms", () => {
  it("missing CAM is not zero", () => {
    const t = commercialTerms(av({ cam_psf_month: null }) as never, null, { asOf: AS_OF });
    expect(t.terms.cam).toEqual({ value: null, status: "missing", source: null });
    expect(t.notes.join()).toMatch(/not assumed to be zero/);
  });
  it("historical pricing is not current pricing", () => {
    const t = commercialTerms(av({ fact_status: "historical_observed" }) as never, null, { asOf: AS_OF });
    expect(t.terms.rent.status).toBe("historical"); expect(t.pricingCurrent).toBe(false);
    const old = commercialTerms(av({ last_verified_on: "2026-01-01", as_of: "2026-01-01" }) as never, null, { asOf: AS_OF });
    expect(old.terms.rent.status).toBe("historical");
  });
  it("expired/superseded quotes are preserved but not used as current pricing", () => {
    const t = commercialTerms(av() as never, { id: "q", version: 2, valid_until: "2026-10-01", terms_json: { rent: 70 } }, { asOf: AS_OF });
    expect(t.quoteStatus).toBe("expired"); expect(t.terms.rent.source).toBe("availability");
    const cur = commercialTerms(av() as never, { id: "q", version: 3, valid_until: "2026-12-01", terms_json: { rent: 70, cam_included: true } }, { asOf: AS_OF });
    expect(cur.terms.rent).toMatchObject({ value: 70, source: "quote" }); expect(cur.terms.cam.value).toBe(0);
  });
});

describe("A · hierarchy", () => {
  it("never combines non-contiguous inventory", () => {
    const { groups, refused } = combineSpaces([
      { id: "s1", asset_id: "A", contiguous_group: "F4-5", chargeable_sf: 10000 }, { id: "s2", asset_id: "A", contiguous_group: "F4-5", chargeable_sf: 9000 },
      { id: "s3", asset_id: "A", contiguous_group: null, chargeable_sf: 8000 }, { id: "s4", asset_id: "B", contiguous_group: "F4-5", chargeable_sf: 5000 },
    ]);
    expect(groups.find((g) => g.spaceIds.includes("s1"))!.spaceIds).toEqual(["s1", "s2"]);
    expect(groups.find((g) => g.spaceIds.includes("s1"))!.chargeableSf).toBe(19000);
    expect(groups.find((g) => g.spaceIds.includes("s3"))!.spaceIds).toEqual(["s3"]);
    expect(groups.find((g) => g.spaceIds.includes("s4"))!.spaceIds).toEqual(["s4"]); // same group name, different building
    expect(refused.join()).toMatch(/non-contiguous/);
  });
  it("divisible space: unknown stays unknown", () => {
    expect(canDivide({ id: "x", asset_id: "A", chargeable_sf: 20000, divisible: true, min_divisible_sf: 8000 }, 10000)).toBe(true);
    expect(canDivide({ id: "x", asset_id: "A", chargeable_sf: 20000, divisible: false }, 10000)).toBe(false);
    expect(canDivide({ id: "x", asset_id: "A", chargeable_sf: 20000 }, 10000)).toBeNull();
  });
});

describe("G/H · matching: hard filters before scoring, explanation", () => {
  it("never hides hard-filter failures behind a high score; failures are listed, not dropped", () => {
    const r = matchCandidates(req, [cand("occ", { av: { supply_status: "occupied" } }), cand("cw", { category: "coworking" }), cand("ok", { av: { asking_rent_max: 99 } })],
      { asOf: AS_OF, propertyTypes: ["conventional_office", "managed_office"] });
    expect(r.map((x) => [x.spaceId, x.eligibility])).toEqual([["ok", "eligible"], ["cw", "ineligible"], ["occ", "ineligible"]]);
    expect(r[1].fitScore).toBeGreaterThan(r[0].fitScore);
    expect(r[1].explanation.fails.join()).toMatch(/coworking not in/);
    expect(r[2].explanation.fails.join()).toMatch(/occupied/);
    expect(r[2].flags.clientReleaseBlocked).toBe(true);
  });
  it("explanation has every section; missing CAM and unknown category are surfaced", () => {
    const [x] = matchCandidates(req, [cand("m", { category: null, av: { cam_psf_month: null } })], { asOf: AS_OF, propertyTypes: ["conventional_office"] });
    const e = x.explanation;
    for (const k of ["why", "satisfies", "fails", "advantages", "disadvantages", "missing", "availabilityConfidence", "verificationRequired"]) expect(e).toHaveProperty(k);
    expect(x.eligibility).toBe("needs_verification");
    expect(e.verificationRequired.join()).toMatch(/category unknown/);
    expect(e.missing.join()).toMatch(/cam/);
    expect(x.criteria.cost.detail).toMatch(/CAM unknown/);
  });
  it("under negotiation / tentatively held need verification; historical asking rent needs verification", () => {
    const r = matchCandidates(req, [cand("n", { av: { supply_status: "under_negotiation" } }), cand("h", { av: { fact_status: "historical_observed" } })], { asOf: AS_OF });
    expect(r.every((x) => x.eligibility === "needs_verification")).toBe(true);
    expect(r.find((x) => x.spaceId === "h")!.verification.map((v) => v.code)).toContain("pricing_historical");
  });
  it("future supply is shown as future, not immediate", () => {
    const [x] = matchCandidates(req, [cand("f", { status: "under_construction", completion: "2027-06-30", av: { available_from: null } })], { asOf: AS_OF });
    expect(x.supplyStatus.status).toBe("future_available");
    expect(x.explanation.disadvantages.join()).toMatch(/Future availability/);
  });
});

describe("J · reconfirmation", () => {
  it("flags stale availability, outdated pricing, expired quotes and missing technical details", () => {
    const items = reconfirmationChecks({ availability: av({ valid_until: "2026-09-01", as_of: "2026-06-01", last_verified_on: "2026-06-01" }) as never,
      quote: { id: "q", version: 1, valid_until: "2026-10-01", terms_json: { rent: 80 } }, asset: { specs: { power_kva: 500 } } }, { asOf: AS_OF });
    expect(items.map((i) => i.code).sort()).toEqual(["expired_quote", "missing_technical", "outdated_pricing", "stale_availability"]);
  });
  it("fresh, priced, quoted and specified → nothing to reconfirm", () => {
    expect(reconfirmationChecks({ availability: av() as never, quote: { id: "q", version: 1, valid_until: "2026-12-31", terms_json: { rent: 80 } }, asset: { specs: { power_kva: 1, car_parks: 2 } } }, { asOf: AS_OF })).toEqual([]);
  });
});

describe("B9 · browser test B — ordering and labels", () => {
  it("a low-data option with no area and no availability cannot rank above a well-documented eligible one", () => {
    const sparse: Candidate = { space: { id: "sparse", asset_id: "a-s", floor_text: "Floor 13" }, asset: { id: "a-s", name: "Sparse Tower", category: "conventional_office" }, availability: null } as never;
    const noAreaReq: RequirementRow = { ...req, area_min_sf: null, area_max_sf: null };
    const r = matchCandidates(noAreaReq, [sparse, cand("good")], { asOf: AS_OF });
    expect(r[0].spaceId).toBe("good");
    expect(r.find((x) => x.spaceId === "sparse")!.eligibility).not.toBe("eligible");
  });
  it("eligible options rank by fit, then completeness", () => {
    const r = matchCandidates(req, [cand("x"), cand("y", { av: { cam_psf_month: null } })], { asOf: AS_OF });
    for (let i = 1; i < r.length; i++) if (r[i].eligibility === r[i - 1].eligibility) expect(r[i - 1].fitScore >= r[i].fitScore).toBe(true);
  });
  it("labels never double 'Floor', and contiguous codes are readable", async () => {
    const { floorLabel, unitLabel } = await import("../matching/match");
    const { contiguousLabel } = await import("./supply");
    expect(floorLabel("Floor 13")).toBe("Floor 13"); expect(floorLabel("Floors 5–6")).toBe("Floors 5–6"); expect(floorLabel("13")).toBe("Floor 13");
    expect(unitLabel("Unit 4")).toBe("Unit 4"); expect(unitLabel("4A")).toBe("Unit 4A");
    expect(contiguousLabel("cantonment_house:stack")).toBe("stacked floors"); expect(contiguousLabel(null)).toBeNull();
    const [m] = matchCandidates(req, [{ ...cand("f"), space: { ...cand("f").space, floor_text: "Floor 13", chargeable_sf: 20000 } } as never], { asOf: AS_OF });
    expect(m.label).not.toMatch(/Floor Floor/);
    expect(m.explanation.satisfies.join(" ")).toMatch(/20,000 SF/);
  });
});
