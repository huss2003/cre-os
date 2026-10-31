/**
 * Workflow 11 Financial Analyst — round-2 acceptance (pure): "no unknown cost is silently treated as zero",
 * assumptions register, explicit rounding rule, reproducibility, comparison completeness.
 */
import { describe, it, expect } from "vitest";
import { compareScenarios, deriveAssumptions, evaluate, FinanceInputError, resolveCostStates, ROUNDING_RULE } from "./engine";
import { inputFromQuote } from "./service";
import type { FinanceInput } from "./types";

const base = (over: Partial<FinanceInput> = {}): FinanceInput => ({
  name: "Option", kind: "conventional", baseDate: "2027-01-01", horizonMonths: 36, annualDiscountRatePct: 0,
  area: { chargeableSf: 10000 }, tenureMonths: 36, taxes: { treatment: "included" }, rent: { basis: "chargeable", rate: 80 }, ...over,
});
const allKnownOrNone = { cam: "none", parking: "none", deposit: "none", fitout: "none", opex: "none", reinstatement: "none" } as const;

describe("11 · no unknown cost is silently treated as zero (fixture)", () => {
  it("unknown CAM / parking / deposit / fit-out / opex / reinstatement are gaps, excluded from complete totals, with a clear label", () => {
    const r = evaluate(base());
    expect(r.costStates).toEqual({ rent: "known", cam: "unknown", parking: "unknown", deposit: "unknown", fitout: "unknown", opex: "unknown", reinstatement: "unknown" });
    expect(r.gaps.map((g) => g.item)).toEqual(["cam", "parking", "deposit", "fitout", "opex", "reinstatement"]);
    expect(r.complete).toBe(false);
    expect(r.completeTotals).toBeNull();
    expect(r.totalsLabel).toBe("Incomplete — known items only; excludes unknown CAM / maintenance, Parking, Security deposit, Fit-out capex, Other operating costs, Reinstatement");
    // the known-items maths is unchanged (rent only), and no zero-valued CAM/parking flow is invented
    expect(r.totals.nominalTco).toBe("28800000.00");
    expect(r.cashflows.some((c) => ["cam", "parking", "deposit", "fitout_capex"].includes(c.category))).toBe(false);
  });
  it("explicitly none / included is different from unknown: complete totals only when every item is known or none", () => {
    const r = evaluate(base({ costStates: { ...allKnownOrNone } }));
    expect(r.gaps).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.completeTotals).toEqual({ nominalTco: "28800000.00", npv: "28800000.00", equivalentMonthly: "800000.00" });
    const camIncluded = evaluate(base({ cam: { mode: "none" } }));
    expect(camIncluded.costStates.cam).toBe("none");
  });
  it("cost states must agree with the amounts (known needs an amount; none/unknown must not carry one)", () => {
    expect(() => evaluate(base({ costStates: { cam: "known" } }))).toThrow(FinanceInputError);
    expect(() => evaluate(base({ cam: { mode: "per_sf", ratePerSf: 12 }, costStates: { cam: "unknown" } }))).toThrow(/marked unknown but an amount was given/);
    expect(() => evaluate(base({ deposit: { months: 6 }, costStates: { deposit: "none" } }))).toThrow(/marked none/);
  });
  it("a GST-excluded quote without a GST rate is a gap, not zero tax", () => {
    const r = evaluate(base({ taxes: { treatment: "excluded" }, costStates: { ...allKnownOrNone } }));
    expect(r.gaps).toEqual([{ item: "gst", label: "GST", reason: "quoted rates exclude GST but no rate was supplied — GST not modelled" }]);
    expect(r.complete).toBe(false);
  });
  it("adding cost states never changes the numbers of known items", () => {
    const a = evaluate(base({ deposit: { months: 6 } }));
    const b = evaluate(base({ deposit: { months: 6 }, costStates: { deposit: "known", cam: "unknown" } }));
    expect(b.totals).toEqual(a.totals);
    expect(b.periodTotals).toEqual(a.periodTotals);
  });
});

describe("11 · inputFromQuote maps a missing quote CAM to unknown, not none", () => {
  const quote = (terms: Record<string, unknown>) => ({ id: "q0000000-0000-4000-8000-000000000001", version: 2, valid_until: "2099-12-31", terms_json: { rent: 85, rent_basis: "chargeable" as const, tenure_months: 60, ...terms } });
  const mk = (terms: Record<string, unknown>, extra: Partial<Parameters<typeof inputFromQuote>[0]> = {}) =>
    inputFromQuote({ name: "Q", baseDate: "2027-01-01", horizonMonths: 60, annualDiscountRatePct: 12, quote: quote(terms), space: { chargeable_sf: 20000 }, ...extra });
  it("CAM: not stated → unknown; included → none; per SF → known", () => {
    expect(resolveCostStates(mk({})).cam).toBe("unknown");
    expect(mk({}).cam).toBeNull();
    expect(resolveCostStates(mk({ cam_included: true })).cam).toBe("none");
    expect(resolveCostStates(mk({ cam_per_sf: 12 })).cam).toBe("known");
  });
  it("deposit 0 months → none; missing → unknown; fit-out/opex/parking unknown unless supplied", () => {
    expect(resolveCostStates(mk({ deposit_months: 0 })).deposit).toBe("none");
    expect(resolveCostStates(mk({})).deposit).toBe("unknown");
    const s = resolveCostStates(mk({ parking_per_slot: 3000 }, { parkingSlots: 20, fitoutCost: 0, opexMonthly: 150000 }));
    expect(s).toMatchObject({ parking: "known", fitout: "none", opex: "known", reinstatement: "unknown" });
    const r = evaluate(mk({ parking_per_slot: 3000, cam_per_sf: 10, deposit_months: 6, gst: "included" }, { parkingSlots: 20, fitoutCost: 5000000, opexMonthly: 0, reinstatement: { amount: 0, period: 60 } }));
    expect(r.complete).toBe(true);
    expect(Number(r.categoryTotals.parking)).toBe(20 * 3000 * 60);
  });
  it("assumptions from the quote carry the quote as their source", () => {
    const a = deriveAssumptions(mk({ cam_included: true, escalation_pct: 15, escalation_every_months: 36 }));
    expect(a.find((x) => x.key === "rent_escalation")!.source).toBe("quote q0000000 v2");
    expect(a.find((x) => x.key === "none:cam")!.source).toBe("quote q0000000 v2 (CAM included)");
    expect(a.find((x) => x.key === "discount_rate")!.source).toBe("user input");
  });
});

describe("11 · assumptions register, rounding rule, reproducibility", () => {
  it("lists every assumption with a value hash that changes exactly when the value changes", () => {
    const i = base({ annualDiscountRatePct: 12, rent: { basis: "chargeable", rate: 80, escalation: { pct: 15, everyMonths: 36 }, rentFreeMonths: 3 }, taxes: { treatment: "excluded", gstRatePct: 18 }, assumptionSources: { discount_rate: "client WACC (CFO email)" } });
    const a = deriveAssumptions(i);
    expect(a.map((x) => x.key)).toEqual(["discount_rate", "horizon", "tenure", "rent_terms", "rent_escalation", "rent_free", "area", "gst"]);
    expect(a[0]).toMatchObject({ label: "Discount rate (% p.a.)", value: "12", source: "client WACC (CFO email)" });
    const b = deriveAssumptions({ ...i, annualDiscountRatePct: 13 });
    const changed = a.filter((x, k) => x.valueHash !== b[k].valueHash).map((x) => x.key);
    expect(changed).toEqual(["discount_rate"]);
    expect(deriveAssumptions(i)).toEqual(a); // deterministic
  });
  it("stores the rounding rule explicitly with each result", () => {
    const r = evaluate(base());
    expect(r.roundingRule).toEqual(ROUNDING_RULE);
    expect(r.roundingRule.money).toMatch(/half-up to 0\.01/);
    expect(r.roundingRule.engineVersion).toBe(r.engineVersion);
  });
  it("outputs can be reproduced from stored inputs (JSON round-trip gives the same hash and result)", () => {
    const i = base({ annualDiscountRatePct: 12, deposit: { months: 6 }, costStates: { cam: "none" } });
    const r1 = evaluate(i);
    const r2 = evaluate(JSON.parse(JSON.stringify(i)));
    expect(r2.outputHash).toBe(r1.outputHash);
    expect(r2.totals).toEqual(r1.totals);
    expect(r2.gaps).toEqual(r1.gaps);
  });
  it("comparison rows say which scenarios are incomplete", () => {
    const c = compareScenarios([base({ name: "A", costStates: { ...allKnownOrNone } }), base({ name: "B", rent: { basis: "chargeable", rate: 70 } })]);
    expect(c.rows.map((r) => [r.name, r.complete])).toEqual([["A", true], ["B", false]]);
    expect(c.rows[1].gaps).toContain("CAM / maintenance");
    expect(c.warnings.join(" ")).toMatch(/B: incomplete — excludes unknown CAM/);
  });
});
