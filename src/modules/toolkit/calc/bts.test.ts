import { describe, expect, it } from "vitest";
import { computeBts, type BtsInput } from "./bts";

const base: BtsInput = {
  land: { mode: "purchase", cost: 10_000_000 }, areaSf: 100_000, areaBasis: "built_up",
  constructionCostPerSf: 3000, softCostPct: 10, constructionMonths: 12, mode: "yield", yieldOnCostPct: 9,
  leaseTermMonths: 24, escalationPct: 5, escalationEveryMonths: 12, rentFreeMonths: 2, depositMonths: 6, tenantFitout: 5_000_000, discountRatePct: 0,
};

describe("bts-1.0 (hand-checked)", () => {
  it("project cost, required rent, schedule and tenant cost", () => {
    const r = computeBts(base);
    // land 10m + hard 100,000×3,000 = 300m + soft 10% = 30m → 340m
    expect(r.projectCost).toMatchObject({ land: "10000000.00", hard: "300000000.00", soft: "30000000.00", interest: "0.00", total: "340000000.00", perSf: "3400.00" });
    // 9% × 340m = 30.6m/yr → ÷100,000 ÷12 = ₹25.50/SF/month
    expect(r.rent.requiredRentPerSfMonth).toBe("25.50");
    expect(r.rent.year1AnnualRent).toBe("30600000.00");
    // yr1: 10 paid months × 2,550,000 = 25.5m; yr2: 12 × 2,677,500 = 32.13m
    expect(r.schedule).toEqual([{ year: 1, months: 12, rentPerSfMonth: "25.50", rentPaid: "25500000.00" }, { year: 2, months: 12, rentPerSfMonth: "26.78", rentPaid: "32130000.00" }]);
    // 0% discount ⇒ NPV = nominal; deposit 6 × 2.55m separate
    expect(r.tenant).toEqual({ rentPaid: "57630000.00", fitout: "5000000.00", nominal: "62630000.00", npv: "62630000.00", deposit: "15300000.00" });
    expect(r.missing).toEqual([]);
  });
  it("rent mode gives implied yield; discounting lowers NPV", () => {
    const r = computeBts({ ...base, mode: "rent", targetRentPerSfMonth: 25.5, discountRatePct: 10 });
    expect(r.rent.impliedYieldPct).toBe("9.0000");
    expect(Number(r.tenant.npv)).toBeLessThan(62_630_000);
    expect(r.tenant.nominal).toBe("62630000.00");
  });
  it("interest during construction is capitalised on the draw schedule", () => {
    // no land; hard+soft = 2,000,000 drawn 50/50 over 2 months at 12% → 1,000,000×1% = 10,000; (2,010,000)×1% = 20,100
    const r = computeBts({ ...base, land: { mode: "purchase", cost: 0 }, areaSf: 1000, constructionCostPerSf: 2000, softCostPct: 0, constructionMonths: 2, drawSchedulePct: [50, 50], includeConstructionInterest: true, constructionInterestPct: 12 });
    expect(r.projectCost.interest).toBe("30100.00");
    expect(r.projectCost.total).toBe("2030100.00");
    expect(() => computeBts({ ...base, drawSchedulePct: [50, 40, 10] })).toThrow(/12 months/);
  });
  it("land lease: rent during construction capitalised, ongoing land rent recovered in required rent", () => {
    const r = computeBts({ ...base, land: { mode: "lease", leaseRentMonthly: 100_000 } });
    expect(r.projectCost.land).toBe("1200000.00"); // 12 months × 100k
    // total 1.2m + 300m + 30m = 331.2m; 9% = 29.808m + 1.2m land rent = 31.008m → ÷1.2m = 25.84
    expect(r.rent.requiredRentPerSfMonth).toBe("25.84");
  });
  it("unknown inputs make dependent outputs null with reasons — never zero", () => {
    const r = computeBts({ ...base, constructionCostPerSf: null, tenantFitout: "" });
    expect(r.projectCost.hard).toBeNull();
    expect(r.projectCost.total).toBeNull();
    expect(r.rent.requiredRentPerSfMonth).toBeNull();
    expect(r.tenant.nominal).toBeNull();
    expect(r.missing).toEqual(expect.arrayContaining(["Construction cost per SF", "Tenant fit-out cost (enter 0 if landlord-provided)"]));
    expect(r.nulls.total).toBeTruthy();
  });
  it("lease alternative compared only on the same area basis", () => {
    const alt = { name: "Lease Tower X", areaSf: 100_000, areaBasis: "built_up" as const, rentPerSfMonth: 28, escalationPct: 5, escalationEveryMonths: 12, rentFreeMonths: 2, depositMonths: 6, fitout: 5_000_000 };
    const r = computeBts({ ...base, alternative: alt });
    expect(r.comparison?.comparable).toBe(true);
    expect(r.comparison?.cheaper).toBe("bts");
    const r2 = computeBts({ ...base, alternative: { ...alt, areaBasis: "carpet" } });
    expect(r2.comparison?.comparable).toBe(false);
    expect(r2.comparison?.reason).toMatch(/not converted/);
  });
});
