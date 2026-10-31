import { describe, it, expect } from "vitest";
import {
  evaluate, compareScenarios, concessionEquivalence, compareFinancingOffers, sensitivities, monthlyRateFromAnnual, FinanceInputError,
} from "./engine";
import type { FinanceInput } from "./types";

/**
 * Spec acceptance test "Finance": independently check zero discount, escalation boundary, deposit/refund,
 * free rent, mixed CAM, financing and equal horizons. Expected values below were hand-computed outside the
 * engine (arithmetic shown in comments; discounted values computed with 40-digit decimal arithmetic).
 */
const base = (over: Partial<FinanceInput> = {}): FinanceInput => ({
  name: "Option", kind: "conventional", baseDate: "2027-01-01", horizonMonths: 36, annualDiscountRatePct: 0,
  area: { chargeableSf: 10000 }, taxes: { treatment: "included" }, ...over,
});
const flow = (r: ReturnType<typeof evaluate>, period: number, category: string) =>
  Number(r.cashflows.find((c) => c.period === period && c.category === category)?.amount ?? 0);

describe("finance engine fin-1.0", () => {
  it("worked synthetic control: zero discount, 6-month deposit out at 0 and back at 36 (spec Part II §5)", () => {
    const r = evaluate(base({
      tenureMonths: 36,
      rent: { basis: "chargeable", rate: 80 },
      deposit: { months: 6 },
    }));
    // rent 10,000 × 80 = 800,000/month; 36 months = 28,800,000; deposit 4,800,000 out and back.
    expect(flow(r, 1, "rent")).toBe(800000);
    expect(flow(r, 0, "deposit")).toBe(4800000);
    expect(flow(r, 36, "deposit_refund")).toBe(-4800000);
    expect(r.categoryTotals.rent).toBe("28800000.00");
    expect(r.totals.nominalTco).toBe("28800000.00");
    expect(r.totals.npv).toBe("28800000.00");
    expect(r.totals.equivalentMonthly).toBe("800000.00");
    expect(r.totals.perChargeableSfMonth).toBe("80.00");
    expect(r.totals.effectiveRentPerSfMonth).toBe("80.00");
  });

  it("same control at 12% p.a.: deposit adds economic cost through the delayed refund, not its full amount", () => {
    const r = evaluate(base({ tenureMonths: 36, annualDiscountRatePct: 12, rent: { basis: "chargeable", rate: 80 }, deposit: { months: 6 } }));
    // r_m = 1.12^(1/12) - 1 = 0.0094887929...
    expect(r.monthlyDiscountRate).toBe("0.0094887929");
    // NPV = 800,000 × a36 + 4,800,000 − 4,800,000 / 1.12^3 ; a36 = 30.374754109781...
    expect(Number(r.totals.npv)).toBeCloseTo(25683258.10, 1);
    expect(Number(r.totals.equivalentMonthly)).toBeCloseTo(845546.21, 1);
    // deposit-only economic cost = 4.8m × (1 − 1/1.404928) = 1,383,454.81 — far below 4.8m
    const noDep = evaluate(base({ tenureMonths: 36, annualDiscountRatePct: 12, rent: { basis: "chargeable", rate: 80 } }));
    expect(Number(r.totals.npv) - Number(noDep.totals.npv)).toBeCloseTo(1383454.81, 1);
  });

  it("monthly discount rate derives from annual (not annual/12) and level rent has equivalent monthly = rent", () => {
    expect(monthlyRateFromAnnual(12).toFixed(12)).toBe("0.009488792935");
    const r = evaluate(base({ horizonMonths: 12, annualDiscountRatePct: 12, area: { chargeableSf: 1000 }, rent: { basis: "chargeable", rate: 100 } }));
    // NPV = 100,000 × Σ_{t=1..12} 1.12^(−t/12) = 100,000 × 11.291515989601 = 1,129,151.60
    expect(r.totals.npv).toBe("1129151.60");
    expect(r.totals.annuityFactor).toBe("11.2915159896");
    expect(r.totals.equivalentMonthly).toBe("100000.00");
  });

  it("escalation boundary: 15% every 36 months applies from lease month 37, not monthly", () => {
    const r = evaluate(base({
      horizonMonths: 60, area: { chargeableSf: 1000 },
      rent: { basis: "chargeable", rate: 100, escalation: { pct: 15, everyMonths: 36 } },
    }));
    expect(flow(r, 1, "rent")).toBe(100000);
    expect(flow(r, 36, "rent")).toBe(100000);
    expect(flow(r, 37, "rent")).toBe(115000);
    expect(flow(r, 60, "rent")).toBe(115000);
    // 36 × 100,000 + 24 × 115,000 = 3,600,000 + 2,760,000
    expect(r.totals.nominalTco).toBe("6360000.00");
  });

  it("escalation boundary respects a later commencement (lease month counted from startPeriod)", () => {
    const r = evaluate(base({
      horizonMonths: 24, area: { chargeableSf: 1000 },
      rent: { basis: "chargeable", rate: 100, startPeriod: 4, escalation: { pct: 5, everyMonths: 12 } },
    }));
    expect(flow(r, 3, "rent")).toBe(0);           // fit-out period, no rent
    expect(flow(r, 15, "rent")).toBe(100000);     // lease month 12
    expect(flow(r, 16, "rent")).toBe(105000);     // lease month 13
  });

  it("deposit/refund: 1.2m at 0, refunded at 36, 12% → NPV = 1.2m − 1.2m/1.12^3 = 345,863.70", () => {
    const r = evaluate(base({ annualDiscountRatePct: 12, deposit: { amount: 1200000, refundPeriod: 36 } }));
    expect(r.totals.nominalTco).toBe("0.00");
    expect(Number(r.totals.npv)).toBeCloseTo(345863.70, 1);
  });

  it("deposit refunded after the horizon is carried at its present value at the horizon", () => {
    const r = evaluate(base({ horizonMonths: 24, annualDiscountRatePct: 12, deposit: { amount: 1200000, refundPeriod: 36 } }));
    // PV at period 24 = 1.2m / 1.12^1 = 1,071,428.57 ; overall NPV identical to refund-at-36 case
    expect(flow(r, 24, "deposit_terminal_value")).toBeCloseTo(-1071428.57, 2);
    expect(Number(r.totals.npv)).toBeCloseTo(345863.70, 1);
    expect(r.warnings.join(" ")).toMatch(/beyond the horizon/);
  });

  it("free rent excludes CAM by default: 3 rent-free months, CAM still payable", () => {
    const r = evaluate(base({
      horizonMonths: 12, area: { chargeableSf: 1000 },
      rent: { basis: "chargeable", rate: 100, rentFreeMonths: 3 },
      cam: { mode: "per_sf", ratePerSf: 10 },
    }));
    expect(flow(r, 1, "rent")).toBe(0);
    expect(flow(r, 1, "cam")).toBe(10000);
    expect(flow(r, 4, "rent")).toBe(100000);
    // rent 9 × 100,000 + CAM 12 × 10,000 = 900,000 + 120,000
    expect(r.categoryTotals.rent).toBe("900000.00");
    expect(r.categoryTotals.cam).toBe("120000.00");
    expect(r.totals.nominalTco).toBe("1020000.00");
    const waived = evaluate(base({
      horizonMonths: 12, area: { chargeableSf: 1000 },
      rent: { basis: "chargeable", rate: 100, rentFreeMonths: 3, rentFreeIncludesCam: true },
      cam: { mode: "per_sf", ratePerSf: 10 },
    }));
    expect(waived.categoryTotals.cam).toBe("90000.00");
  });

  it("deposit months are based on contractual base rent, not the rent-free zero", () => {
    const r = evaluate(base({ horizonMonths: 12, area: { chargeableSf: 1000 }, rent: { basis: "chargeable", rate: 100, rentFreeMonths: 3 }, deposit: { months: 6 } }));
    expect(flow(r, 0, "deposit")).toBe(600000);
  });

  it("mixed CAM: fixed + per-SF components escalate together", () => {
    const r = evaluate(base({
      horizonMonths: 24, area: { chargeableSf: 1000 },
      cam: { mode: "mixed", fixedMonthly: 5000, ratePerSf: 8, escalation: { pct: 5, everyMonths: 12 } },
    }));
    // year 1: 5,000 + 8,000 = 13,000 × 12 = 156,000 ; year 2: 13,650 × 12 = 163,800
    expect(flow(r, 12, "cam")).toBe(13000);
    expect(flow(r, 13, "cam")).toBe(13650);
    expect(r.totals.nominalTco).toBe("319800.00");
  });

  it("financing: lender-paid capex is not counted twice; annuity repayments reconcile", () => {
    const r = evaluate(base({
      capex: { fitoutCost: 10000000 },
      financing: { partnerName: "Partner A", principal: 10000000, annualInterestRate: 12, termMonths: 36 },
    }));
    // period 0: capex 10m out, lender draw 10m in → net 0
    expect(r.periodTotals[0]).toBe("0.00");
    // annuity at 1%/month: 10,000,000 × 0.01 / (1 − 1.01^−36) = 332,143.10 ; total ≈ 11,957,151.53
    expect(Number(r.periodTotals[1])).toBeCloseTo(332143.10, 1);
    expect(Number(r.totals.nominalTco)).toBeCloseTo(11957151.53, 0);
    expect(Number(r.categoryTotals.financing_principal)).toBeCloseTo(10000000, 0);
    expect(Number(r.totals.financingInterestTotal)).toBeCloseTo(1957151.53, 1);
    expect(Number(r.totals.nominalTco)).toBeLessThan(12000000); // not 21.96m (double count)
  });

  it("financing beyond horizon keeps the remaining liability (PV at horizon)", () => {
    const r = evaluate(base({ horizonMonths: 12, capex: { fitoutCost: 1200000 }, financing: { partnerName: "P", principal: 1200000, annualInterestRate: 0, termMonths: 24 } }));
    // 0% loan: 50,000/month; 12 paid inside horizon, remaining 600,000 at period 12 (zero discount)
    expect(r.totals.nominalTco).toBe("1200000.00");
  });

  it("refuses financing principal above net capex (double count guard)", () => {
    expect(() => evaluate(base({ capex: { fitoutCost: 100, landlordContribution: 50 }, financing: { partnerName: "P", principal: 80, annualInterestRate: 10, termMonths: 12 } })))
      .toThrow(FinanceInputError);
  });

  it("equal horizons: comparison refuses 36 vs 60 months; short tenure needs explicit after-tenure assumption", () => {
    const a = base({ name: "3-year", rent: { basis: "chargeable", rate: 80 } });
    const b = base({ name: "5-year", horizonMonths: 60, rent: { basis: "chargeable", rate: 75 } });
    expect(() => compareScenarios([a, b])).toThrow(/unequal horizons/);
    expect(() => evaluate(base({ horizonMonths: 60, tenureMonths: 36, rent: { basis: "chargeable", rate: 80 } }))).toThrow(/afterTenure/);
    const cont = evaluate(base({ horizonMonths: 60, tenureMonths: 36, afterTenure: "continue_same_terms", area: { chargeableSf: 1000 }, rent: { basis: "chargeable", rate: 100 } }));
    expect(cont.totals.nominalTco).toBe("6000000.00");
    const vac = evaluate(base({ horizonMonths: 60, tenureMonths: 36, afterTenure: "vacate", area: { chargeableSf: 1000 }, rent: { basis: "chargeable", rate: 100 } }));
    expect(vac.totals.nominalTco).toBe("3600000.00");
    expect(vac.warnings.join(" ")).toMatch(/not like-for-like/);
  });

  it("managed vs conventional on a common 36-month horizon (zero discount)", () => {
    const managed = base({
      name: "Managed", kind: "managed", area: { chargeableSf: 10000, plannedSeats: 100 },
      rent: { basis: "seat", rate: 12000 }, oneOffs: [{ label: "Setup fee", amount: 200000, period: 0 }],
    });
    const conventional = base({
      name: "Conventional", area: { chargeableSf: 10000, plannedSeats: 100 }, tenureMonths: 36,
      rent: { basis: "chargeable", rate: 80 }, cam: { mode: "per_sf", ratePerSf: 15 },
      capex: { fitoutCost: 20000000 }, deposit: { months: 6 },
    });
    const cmp = compareScenarios([conventional, managed]);
    // managed: 100 × 12,000 × 36 + 200,000 = 43,400,000 ; conventional: 36 × (800,000 + 150,000) + 20,000,000 = 54,200,000
    expect(cmp.results[1].totals.nominalTco).toBe("43400000.00");
    expect(cmp.results[0].totals.nominalTco).toBe("54200000.00");
    // per planned seat per month: 43.4m/36/100 = 12,055.56 ; 54.2m/36/100 = 15,055.56
    expect(cmp.results[1].totals.perPlannedSeatMonth).toBe("12055.56");
    expect(cmp.results[0].totals.perPlannedSeatMonth).toBe("15055.56");
    expect(cmp.rows[1].rank).toBe(1);
    expect(cmp.rows[1].incrementalNpvVsBaseline).toBe("-10800000.00");
    expect(cmp.rows[1].breakEvenPeriodVsBaseline).toBe(0);
  });

  it("renew vs relocate: parallel rent and move cost included; break-even period reported", () => {
    const renew = base({ name: "Renew", kind: "renew", horizonMonths: 60, area: { chargeableSf: 1000 }, rent: { basis: "chargeable", rate: 100 } });
    const relocate = base({
      name: "Relocate", kind: "relocate", horizonMonths: 60, area: { chargeableSf: 1000 },
      rent: { basis: "chargeable", rate: 80, startPeriod: 1 },
      move: { parallelRentMonthly: 100000, parallelFromPeriod: 1, parallelMonths: 2, moveCost: 400000, movePeriod: 0 },
    });
    const cmp = compareScenarios([renew, relocate]);
    // relocate: 60 × 80,000 + 2 × 100,000 + 400,000 = 5,400,000 ; renew 6,000,000
    expect(cmp.results[1].totals.nominalTco).toBe("5400000.00");
    // cumulative: renew 100k·p ; relocate 400k + 180k·p (p≤2) then +80k → equal never before; relocate ≤ renew from p = 30
    // relocate(p) = 400,000 + 200,000 + 80,000p = 600,000 + 80,000p ≤ 100,000p ⇔ p ≥ 30
    expect(cmp.rows[1].breakEvenPeriodVsBaseline).toBe(30);
  });

  it("GST excluded with a supplied rate is added as its own category; missing rate is a visible warning", () => {
    const r = evaluate(base({ horizonMonths: 12, area: { chargeableSf: 1000 }, rent: { basis: "chargeable", rate: 100 }, taxes: { treatment: "excluded", gstRatePct: 18 } }));
    expect(r.categoryTotals.gst).toBe("216000.00");
    const w = evaluate(base({ horizonMonths: 12, area: { chargeableSf: 1000 }, rent: { basis: "chargeable", rate: 100 }, taxes: { treatment: "excluded" } }));
    expect(w.categoryTotals.gst).toBeUndefined();
    expect(w.warnings.join(" ")).toMatch(/GST is NOT modelled/);
  });

  it("missing area is an error, never zero rent (S6)", () => {
    expect(() => evaluate(base({ area: {}, rent: { basis: "chargeable", rate: 80 } }))).toThrow(/chargeableSf/);
  });

  it("reproducible output hash: same inputs → same hash; changed quote version → different hash", () => {
    const i = base({ rent: { basis: "chargeable", rate: 80 }, quoteRefs: [{ quoteId: "q1", version: 1 }] });
    expect(evaluate(i).outputHash).toBe(evaluate(JSON.parse(JSON.stringify(i))).outputHash);
    expect(evaluate({ ...i, quoteRefs: [{ quoteId: "q1", version: 2 }] }).outputHash).not.toBe(evaluate(i).outputHash);
  });

  it("concession equivalence converts rent-free, capex and escalation changes to comparable NPV", () => {
    const b = base({ area: { chargeableSf: 1000 }, rent: { basis: "chargeable", rate: 100, escalation: { pct: 5, everyMonths: 12 } } });
    const [rf, capex, esc] = concessionEquivalence(b, [
      { type: "rent_free", months: 2 },
      { type: "capex_support", amount: 300000, period: 0 },
      { type: "escalation_pct", pct: -5 },
    ]);
    // zero discount: 2 rent-free months = 2 × 100,000 = 200,000 ; equals 2.00 first-month rents
    expect(rf.npvValue).toBe("200000.00");
    expect(rf.equivalentRentFreeMonths).toBe("2.00");
    // flat ₹/SF/month equivalent over 36 lease months: 200,000 / (36 × 1,000) = 5.5556
    expect(rf.equivalentRateReduction).toBe("5.5556");
    expect(capex.npvValue).toBe("300000.00");
    // removing 5% escalation: year 2 saves 5,000×12 = 60,000; year 3 saves 10,250×12 = 123,000 → 183,000
    expect(esc.npvValue).toBe("183000.00");
  });

  it("financing offers compared on equal terms; all partners shown with missing underwriting terms", () => {
    const b = base({ capex: { fitoutCost: 10000000 }, annualDiscountRatePct: 12 });
    const res = compareFinancingOffers(b, [
      { partnerName: "Partner A", principal: 10000000, annualInterestRate: 12, termMonths: 36 },
      { partnerName: "Partner B", principal: 10000000, annualInterestRate: 14, termMonths: 36, upfrontFee: 100000 },
    ]);
    expect(res.offers).toHaveLength(2);
    expect(res.cash.totals.npv).toBe("10000000.00");
    // A at 12% nominal (1%/month) is cheaper than B at 14% + fee
    expect(Number(res.offers[0].npv)).toBeLessThan(Number(res.offers[1].npv));
    expect(res.offers[0].missingUnderwritingTerms).toContain("Processing/upfront fees");
    expect(res.offers[1].missingUnderwritingTerms).not.toContain("Processing/upfront fees");
    expect(() => compareFinancingOffers(b, [
      { partnerName: "A", principal: 10000000, annualInterestRate: 12, termMonths: 36 },
      { partnerName: "B", principal: 8000000, annualInterestRate: 12, termMonths: 36 },
    ])).toThrow(/same principal/);
  });

  it("sensitivities are deterministic re-runs of the engine", () => {
    const s = sensitivities(base({ area: { chargeableSf: 1000 }, rent: { basis: "chargeable", rate: 100 } }));
    const up = s.find((x) => x.label === "Rent +10%")!;
    expect(up.npvChange).toBe("360000.00"); // 10 × 1,000 × 36
  });
});
