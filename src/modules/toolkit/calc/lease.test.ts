import { describe, it, expect } from "vitest";
import { leaseEconomics, compareLeaseOffers, occupancyEconomics, occupancySensitivity, toFinanceInput, type LeaseTerms } from "./lease";
import { sameOutputs } from "../store";

/**
 * Spec data A/B/C over 60 months. Expected values hand-computed (not by the engine):
 *  A: 25,000 × ₹100 = 2,500,000/mo; +15% at month 37 → 2,875,000. Rent-free 2 → rent = 34×2.5M + 24×2.875M
 *     = 85,000,000 + 69,000,000 = 154,000,000. Benefit 2×2.5M = 5,000,000. CAM 25,000×12 = 300,000/mo ×60 = 18,000,000.
 *     Deposit 6×2.5M = 15,000,000 (refundable). Contractual expenditure = 154M + 18M = 172,000,000.
 *  B: 28,000 × ₹95 = 2,660,000; +12% → 2,979,200. Free 3 → 33×2.66M + 24×2,979,200 = 87,780,000 + 71,500,800 = 159,280,800.
 *     Benefit 7,980,000. CAM 280,000 ×60 = 16,800,000. Deposit 15,960,000. Expenditure 176,080,800.
 *  C: 24,000 × ₹110 = 2,640,000; +15% → 3,036,000. Free 1 → 35×2.64M + 24×3.036M = 92,400,000 + 72,864,000 = 165,264,000.
 *     Benefit 2,640,000. CAM 192,000 ×60 = 11,520,000. Deposit 4×2.64M = 10,560,000. Expenditure 176,784,000.
 */
const T = (o: Partial<LeaseTerms>): LeaseTerms => ({
  name: "X", label: "quoted", areaSf: 25000, areaBasis: "chargeable", rentPerSf: 100, leaseCommencement: "2027-01-01",
  tenureMonths: 60, rentFreeMonths: 0, escalationPct: 15, escalationEveryMonths: 36, camPerSf: 12, parkingSlots: 0,
  depositMonths: 6, otherRecurringState: "none", gst: { treatment: "included" }, discountRatePct: 0, ...o,
});
const A = T({ name: "A", rentFreeMonths: 2 });
const B = T({ name: "B", areaSf: 28000, rentPerSf: 95, camPerSf: 10, rentFreeMonths: 3, escalationPct: 12 });
const C = T({ name: "C", areaSf: 24000, rentPerSf: 110, camPerSf: 8, depositMonths: 4, rentFreeMonths: 1 });

describe("lease-1.0 lease economics (spec A/B/C, 60 months)", () => {
  it.each([
    [A, "2500000.00", "300000.00", "154000000.00", "5000000.00", "18000000.00", "15000000.00", "172000000.00", "2875000.00"],
    [B, "2660000.00", "280000.00", "159280800.00", "7980000.00", "16800000.00", "15960000.00", "176080800.00", "2979200.00"],
    [C, "2640000.00", "192000.00", "165264000.00", "2640000.00", "11520000.00", "10560000.00", "176784000.00", "3036000.00"],
  ])("%#", (t, mRent, mCam, rent, benefit, cam, dep, exp, stepped) => {
    const r = leaseEconomics(t);
    expect(r.monthly.baseRent).toBe(mRent);
    expect(r.annual.baseRent).toBe((Number(mRent) * 12).toFixed(2));
    expect(r.monthly.cam).toBe(mCam);
    expect(r.totals.rent).toBe(rent);
    expect(r.rentFreeBenefit).toBe(benefit);
    expect(r.totals.cam).toBe(cam);
    expect(r.deposit?.amount).toBe(dep);
    expect(r.deposit?.refundMonth).toBe(60);
    expect(r.totals.contractualExpenditure).toBe(exp);
    expect(r.rentSteps).toHaveLength(2);
    expect(r.rentSteps[1]).toMatchObject({ fromMonth: 37, toMonth: 60, monthlyRent: stepped });
    // deposit out and refund net to zero at 0% → NPV equals contractual expenditure (deposit is not an expense)
    expect(r.totals.npv).toBe(exp);
    expect(r.complete).toBe(true);
    expect(r.years).toHaveLength(5);
    expect(r.years.reduce((a, y) => a + Number(y.rent), 0)).toBe(Number(rent));
  });

  it("year table: A year 1 rent = 10 paying months × 2.5M; year 4 = 12 × 2.875M", () => {
    const r = leaseEconomics(A);
    expect(r.years[0].rent).toBe("25000000.00");
    expect(r.years[3].rent).toBe("34500000.00");
    expect(r.months[0].rent).toBe("0.00"); // rent-free
    expect(r.months[0].cam).toBe("300000.00"); // CAM still payable during rent-free
  });

  it("unknown CAM stays unknown (not zero) and makes the result incomplete", () => {
    const r = leaseEconomics({ ...A, camPerSf: null });
    expect(r.totals.cam).toBeNull();
    expect(r.monthly.cam).toBeNull();
    expect(r.complete).toBe(false);
    expect(r.gaps).toContain("CAM / maintenance");
    expect(r.totalsLabel).toMatch(/Incomplete/);
  });

  it("annual other charges are converted to monthly explicitly", () => {
    const r = leaseEconomics({ ...A, otherRecurring: [{ label: "Insurance", amount: 120000, periodicity: "annual" }] });
    expect(r.monthly.other).toBe("10000.00");
    expect(r.totals.other).toBe("600000.00");
  });

  it("compares A/B/C side by side on an equal horizon", () => {
    const c = compareLeaseOffers([A, B, C]);
    expect(c.horizonMonths).toBe(60);
    expect(c.rows.map((r) => r.nominalTco)).toEqual(["172000000.00", "176080800.00", "176784000.00"]);
    expect(c.rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(c.rows[1].incrementalNpvVsBaseline).toBe("4080800.00");
  });

  it("refuses different commencement dates (not like-for-like)", () => {
    expect(() => compareLeaseOffers([A, { ...B, leaseCommencement: "2027-04-01" }])).toThrow(/commencement/);
  });

  it("changed rental values → new run; old inputs still reproduce identical outputs", () => {
    const v1 = leaseEconomics(A);
    const v2 = leaseEconomics({ ...A, rentPerSf: 98 });
    expect(v2.totals.rent).not.toBe(v1.totals.rent);
    expect(sameOutputs(leaseEconomics(A), v1)).toBe(true);
  });
});

describe("occ-1.0 occupancy economics", () => {
  it("effective rent, cash funding, PV and peak cash (A, 0%)", () => {
    const o = occupancyEconomics({ terms: A, extras: { advanceRentMonths: 1, fitoutCost: 30000000, movingCost: 500000, initialCharges: 1000000 } });
    expect(o.nominalRentPerSf).toBe("100.00");
    // 154,000,000 / (25,000 × 60) = 102.6666… → 102.67
    expect(o.effectiveRentPerSf).toBe("102.67");
    // at signing: deposit 15M + advance 2.5M + fit-out 30M + moving 0.5M + initial 1M = 49,000,000
    expect(o.cashFundingTotal).toBe("49000000.00");
    expect(o.cashFundingComplete).toBe(true);
    // PV at 0% = 172M + fit-out 30M + moving 0.5M + initial 1M (advance rent and deposit net out) = 203,500,000
    expect(o.presentValue).toBe("203500000.00");
    expect(o.cumulative[0]).toBe("49000000.00");
    expect(o.cumulative[60]).toBe("203500000.00");
    expect(Number(o.peakCashRequirement)).toBeGreaterThanOrEqual(203500000);
  });

  it("unknown fit-out is reported as unknown cash funding, not zero", () => {
    const o = occupancyEconomics({ terms: A, extras: {} });
    expect(o.cashFunding.find((c) => c.label === "Fit-out")?.amount).toBeNull();
    expect(o.cashFundingComplete).toBe(false);
  });

  it("sensitivity override: rent ₹100→₹110 adds 10% of rent (15,400,000) at 0%", () => {
    const s = occupancySensitivity({ terms: A, extras: {} }, { rentPerSf: 110 });
    // rent 154M × 1.1 = 169.4M (+15.4M); deposit also rises but nets to zero at 0%
    expect(s.change.nominalTotal).toBe("15400000.00");
    expect(s.change.presentValue).toBe("15400000.00");
  });

  it("discounting reduces PV below nominal at 12%", () => {
    const o = occupancyEconomics({ terms: { ...A, discountRatePct: 12 }, extras: {} });
    expect(Number(o.presentValue)).toBeLessThan(172000000);
    expect(toFinanceInput(A).baseDate).toBe("2026-12-01");
  });
});
