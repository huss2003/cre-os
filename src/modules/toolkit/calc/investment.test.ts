import { describe, expect, it } from "vitest";
import { annuity, computeInvestment, irr, npv, type InvestmentInput } from "./investment";

const base: InvestmentInput = {
  purchasePrice: 1_200_000, stampDutyPct: 0, otherAcquisitionCosts: 0, leasableAreaSf: 1000, areaBasis: "leasable",
  tenancies: [{ name: "Anchor", areaSf: 1000, rentPerSfMonth: 10, escalationPct: 0, escalationEveryMonths: 12, expiryMonth: 120, downtimeMonths: 0, reletRentPerSfMonth: 10, camRecoveryPerSfMonth: 0 }],
  opexPerSfMonth: 0, opexEscalationPct: 0, capexReservePerSfYear: 0, holdingYears: 5, exitCapRatePct: 10, saleCostsPct: 0, discountRatePct: 10,
};

describe("finance primitives", () => {
  it("IRR of −100, 60, 60 is 13.0662% (closed form)", () => {
    // 60x² + 60x − 100 = 0, x = 1/(1+r) → x = (−60 + √27600)/120
    const x = (-60 + Math.sqrt(27600)) / 120;
    expect(Number(irr([-100, 60, 60]))).toBeCloseTo(1 / x - 1, 9);
  });
  it("IRR null when no sign change; NPV basic", () => {
    expect(irr([100, 10, 10])).toBeNull();
    expect(irr([-100, -10])).toBeNull();
    expect(npv(0.1, [-100, 110]).toFixed(6)).toBe("0.000000");
  });
  it("annuity 600k @8% 5y = 150,273.87", () => {
    expect(annuity(600_000, 8, 5).toFixed(2)).toBe("150273.87");
  });
});

describe("inv-1.0 (hand-checked)", () => {
  it("flat income at 10% cap bought at 10% → IRR 10%, NPV 0 at 10%, multiple 1.5", () => {
    const r = computeInvestment(base);
    expect(r.ok).toBe(true);
    expect(r.years.map((y) => y.noi)).toEqual(Array(5).fill("120000.00"));
    expect(r.exit.value).toBe("1200000.00");
    expect(r.yieldOnCostPct).toBe("10.0000");
    expect(r.unlevered.irrPct).toBe("10.0000");
    expect(r.unlevered.npv).toBe("0.00");
    expect(r.unlevered.equityMultiple).toBe("1.5000");
  });
  it("50% LTV interest-only at 8% → levered IRR 12%, DSCR 2.5", () => {
    const r = computeInvestment({ ...base, debt: { ltvPct: 50, ratePct: 8, tenorYears: 5, amortisation: "interest_only" } });
    expect(r.acquisition.equity).toBe("600000.00");
    expect(r.years[0]).toMatchObject({ debtService: "48000.00", dscr: "2.5000", levered: "72000.00" });
    expect(r.exit.loanBalance).toBe("600000.00");
    expect(r.levered?.irrPct).toBe("12.0000");
    expect(r.minDscr).toBe("2.5000");
  });
  it("amortising loan is fully repaid at tenor = hold", () => {
    const r = computeInvestment({ ...base, debt: { ltvPct: 50, ratePct: 8, tenorYears: 5, amortisation: "amortising" } });
    expect(r.years[0].debtService).toBe("150273.87");
    expect(r.exit.loanBalance).toBe("0.00");
  });
  it("stamp duty, expiry + downtime + re-let, opex and sensitivities", () => {
    const r = computeInvestment({ ...base, stampDutyPct: 6, tenancies: [{ ...base.tenancies[0], expiryMonth: 24, downtimeMonths: 6, reletRentPerSfMonth: 12 }], opexPerSfMonth: 1 });
    expect(r.acquisition.total).toBe("1272000.00");
    // yr3: 6 void months, then 6 × 12,000 = 72,000 rent; opex 12,000 → NOI 60,000
    expect(r.years[2]).toMatchObject({ rent: "72000.00", noi: "60000.00" });
    expect(r.years[3].noi).toBe("132000.00");
    const s = Object.fromEntries(r.sensitivities.map((x) => [x.label, x]));
    expect(Number(s["Exit cap −50 bps"].unleveredIrrPct)).toBeGreaterThan(Number(r.unlevered.irrPct));
    expect(Number(s["Exit cap +50 bps"].unleveredIrrPct)).toBeLessThan(Number(r.unlevered.irrPct));
    expect(Number(s["Rent +10%"].npv)).toBeGreaterThan(Number(r.unlevered.npv));
    expect(s["Exit cap −50 bps"].exitValue).toBe(String((132000 / 0.095).toFixed(2)));
  });
  it("unknown input → no NOI/IRR, listed as missing", () => {
    const r = computeInvestment({ ...base, exitCapRatePct: null, tenancies: [{ ...base.tenancies[0], expiryMonth: "" }] });
    expect(r.ok).toBe(false);
    expect(r.unlevered.irrPct).toBeNull();
    expect(r.missing).toEqual(expect.arrayContaining(["Exit cap rate %", "Anchor: expiry (months from acquisition)"]));
  });
});
