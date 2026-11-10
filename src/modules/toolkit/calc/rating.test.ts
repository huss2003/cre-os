import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, occupancyCost, rateProperties, RatingModelError, validateModel, type RatingProperty, type RatingRequirement } from "./rating";

// Spec test data: client needs 25,000 sf in Kharadi.
const req: RatingRequirement = { areaMinSf: 25000, areaTargetSf: 25000, areaBasis: "chargeable", microMarkets: ["Kharadi"] };
const base = { source: "db" as const, microMarket: "Kharadi", areaBasis: "chargeable" as const, escalationEveryMonths: 36, evidence: "quoted" as const };
const A: RatingProperty = { ...base, key: "A", name: "A", areaSf: 25000, rent: 100, cam: 12, depositMonths: 6, rentFreeMonths: 2, escalationPct: 15 };
const B: RatingProperty = { ...base, key: "B", name: "B", areaSf: 28000, rent: 95, cam: 10, depositMonths: 6, rentFreeMonths: 3, escalationPct: 12 };
const C: RatingProperty = { ...base, key: "C", name: "C", areaSf: 24000, rent: 110, cam: 8, depositMonths: 4, rentFreeMonths: 1, escalationPct: 15 };
const asOf = "2026-11-10";

describe("rating-1.0", () => {
  it("validates weights sum to 100", () => {
    expect(validateModel(DEFAULT_MODEL)).toEqual([]);
    const bad = { ...DEFAULT_MODEL, factors: DEFAULT_MODEL.factors.map((f, i) => i === 0 ? { ...f, weight: 25 } : f) };
    expect(validateModel(bad).join()).toMatch(/add up to 100 \(currently 105\)/);
    expect(() => rateProperties(bad, req, [A])).toThrow(RatingModelError);
  });

  it("effective occupancy cost over 60 months (hand computed)", () => {
    // A: (100×36 + 115×24 − 2×100)/60 + 12 = 6160/60 + 12 = 114.6667
    expect(occupancyCost(A, 60)).toBeCloseTo(114.6667, 4);
    // B: (95×36 + 106.4×24 − 3×95)/60 + 10 = 5688.6/60 + 10 = 104.81
    expect(occupancyCost(B, 60)).toBeCloseTo(104.81, 4);
    // C: (110×36 + 126.5×24 − 110)/60 + 8 = 6886/60 + 8 = 122.7667
    expect(occupancyCost(C, 60)).toBeCloseTo(122.7667, 4);
  });

  it("spec case: scores, unknowns excluded not zeroed, C fails area minimum", () => {
    const r = rateProperties(DEFAULT_MODEL, req, [A, B, C], { asOf });
    const [a, b, c] = r.properties;
    // known factors: location 20, area 20, commercial 25 = 65 → coverage 0.65
    expect(a.coverage).toBe(0.65);
    // A = (20 + 20 + 25×104.81/114.6667)/65 = 96.7
    expect(a.score).toBe(96.7);
    // B = (20 + 20×0.76 + 25)/65 = 92.6
    expect(b.score).toBe(92.6);
    // C = (20 + 20×0.92 + 25×104.81/122.7667)/65 = 91.9
    expect(c.score).toBe(91.9);
    expect(a.factors.find((f) => f.key === "quality")!.score).toBeNull();
    expect(a.missing.join()).toMatch(/Grade unknown/);
    expect(c.eligibility).toBe("not_eligible");
    expect(c.disadvantages[0]).toMatch(/Area ≥ requirement minimum/);
    expect(r.recommendation.key).toBe("A");
    expect(r.termAssumed).toBe(true);
    expect(a.limitations.join()).toMatch(/Term assumed 60/);
    expect(c.advantages.join()).toMatch(/Lowest refundable deposit \(4/);
  });

  it("mandatory failure beats a high score", () => {
    const D: RatingProperty = { ...A, key: "D", name: "D", areaSf: 24500, rent: 60, grade: "A+", metroKm: 0.2, amenities: ["gym", "cafe", "creche", "ev", "parking"] };
    const r = rateProperties(DEFAULT_MODEL, req, [A, D], { asOf });
    const d = r.properties[1];
    expect(d.score!).toBeGreaterThan(95);
    expect(d.eligibility).toBe("not_eligible");
    expect(r.recommendation.key).toBe("A");
    expect(r.recommendation.explanation).toMatch(/Higher-scoring D excluded/);
  });

  it("disqualifying rule, unknown mandatory data, tie explanation, stale/manual verification", () => {
    const model = { ...DEFAULT_MODEL, rules: [...DEFAULT_MODEL.rules, { kind: "disqualify" as const, field: "grade" as const, op: "in" as const, value: ["C"], label: "No grade C" }] };
    const E: RatingProperty = { ...A, key: "E", name: "E", grade: "C" };
    const F: RatingProperty = { ...A, key: "F", name: "F", microMarket: null };
    const G: RatingProperty = { ...A, key: "G", name: "G", source: "manual", availabilityAsOf: "2026-01-01" };
    const r = rateProperties(model, req, [A, E, F, G], { asOf });
    expect(r.properties[1].eligibility).toBe("not_eligible");
    expect(r.properties[2].eligibility).toBe("unconfirmed");
    expect(r.properties[3].verification.join()).toMatch(/manually[\s\S]*old/);
    expect(r.recommendation.tie).toBe(true);
    expect(r.recommendation.explanation).toMatch(/Tied with/);
  });

  it("area basis mismatch without efficiency stays unknown; with efficiency converts", () => {
    const H: RatingProperty = { ...A, key: "H", name: "H", areaBasis: "carpet" };
    expect(rateProperties(DEFAULT_MODEL, req, [H], { asOf }).properties[0].factors.find((f) => f.key === "area")!.score).toBeNull();
    const I: RatingProperty = { ...H, key: "I", efficiency: 0.8, areaSf: 20000 }; // 20000 carpet / 0.8 = 25000 chargeable
    expect(rateProperties(DEFAULT_MODEL, req, [I], { asOf }).properties[0].factors.find((f) => f.key === "area")!.score).toBe(1);
  });
});
