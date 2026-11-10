import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { computeLoan, emiExact } from "./financing";

const sum = (xs: string[]) => xs.reduce((a, x) => a.plus(x), new Decimal(0)).toFixed(2);

describe("loan-1.0", () => {
  it("₹1,00,00,000 at 12% for 36 months: EMI ₹3,32,143.10 (exact 332143.0981; brief approx .08 is 2 paise off)", () => {
    const r = computeLoan({ financedAmount: 10000000, annualRatePct: 12, tenureMonths: 36 });
    expect(r.emi).toBe("332143.10");
    expect(r.schedule).toHaveLength(36);
    expect(r.schedule[0]).toMatchObject({ opening: "10000000.00", interest: "100000.00", principal: "232143.10", closing: "9767856.90" });
    expect(r.schedule[35].closing).toBe("0.00");
    expect(sum(r.schedule.map((s) => s.principal))).toBe("10000000.00");
    expect(sum(r.schedule.map((s) => s.payment))).toBe(r.totals.payments);
    expect(new Decimal(r.totals.payments).minus(r.totals.principal).toFixed(2)).toBe(r.totals.interest);
    expect(Math.abs(Number(r.totals.interest) - (332143.0981285 * 36 - 1e7))).toBeLessThan(1);
    expect(r.effectiveAnnualRatePct).toBe("12.0000");
  });
  it("zero-rate: EMI = P/n, last row adjusts", () => {
    const r = computeLoan({ financedAmount: 100000, annualRatePct: 0, tenureMonths: 3 });
    expect(r.emi).toBe("33333.33");
    expect(r.schedule[2].payment).toBe("33333.34");
    expect(r.totals.interest).toBe("0.00");
    expect(emiExact(1200, 0, 12).toString()).toBe("100");
  });
  it("financed from cost − contribution, fees with explicit tax raise the effective cost", () => {
    const r = computeLoan({ projectCost: 12000000, clientContribution: 2000000, annualRatePct: 12, tenureMonths: 36, feeType: "pct", feeValue: 1, feeTaxPct: 18 });
    expect(r.financed).toBe("10000000.00");
    expect(r.totals.fee).toBe("100000.00");
    expect(r.totals.feeTax).toBe("18000.00");
    expect(r.totals.costOfFinancing).toBe(new Decimal(r.totals.interest).plus(118000).toFixed(2));
    expect(Number(r.effectiveAnnualRatePct)).toBeGreaterThan(12.7);
    expect(r.cashflow[0]).toMatchObject({ month: 0, amount: "2118000.00" });
  });
  it("fee tax unknown is flagged, not assumed", () => {
    const r = computeLoan({ financedAmount: 100000, annualRatePct: 10, tenureMonths: 12, feeType: "fixed", feeValue: 5000 });
    expect(r.totals.feeTax).toBeNull();
    expect(r.effectiveAnnualRatePct).toBeNull();
    expect(r.missing.join()).toMatch(/Tax on processing fee/);
  });
  it("moratorium interest-only then EMI", () => {
    const r = computeLoan({ financedAmount: 1200000, annualRatePct: 12, tenureMonths: 12, moratoriumMonths: 3 });
    expect(r.schedule).toHaveLength(15);
    expect(r.schedule[0]).toMatchObject({ phase: "moratorium", payment: "12000.00", closing: "1200000.00" });
    expect(r.schedule[14].closing).toBe("0.00");
    const c = computeLoan({ financedAmount: 1200000, annualRatePct: 12, tenureMonths: 12, moratoriumMonths: 1, moratoriumMode: "capitalised" });
    expect(c.schedule[1].opening).toBe("1212000.00");
    expect(c.totals.principal).toBe("1200000.00");
  });
});
