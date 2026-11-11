import { describe, it, expect } from "vitest";
import { compareLandlordOffers, offerToLeaseTerms, landlordOfferSchema, type LandlordOffer } from "@/modules/toolkit/calc/landlord-offer";
import { leaseEconomics } from "@/modules/toolkit/calc/lease";

// Spec offer A (see toolkit/calc/lease.test.ts): 25,000 SF × ₹100, +15% at month 37, 2 months free, CAM ₹12, deposit 6,
// 60 months → rent 154,000,000; CAM 18,000,000; contractual expenditure 172,000,000 (hand-computed there).
const A: LandlordOffer = landlordOfferSchema.parse({
  name: "A", areaSf: 25000, areaBasis: "chargeable", efficiencyPct: 80, rentPerSf: 100, escalationPct: 15, escalationEveryMonths: 36,
  termMonths: 60, lockInMonths: 36, rentFreeMonths: 2, camPerSf: 12, carParks: 0, securityDepositMonths: 6, seats: 250,
  fieldStatus: { rentPerSf: "currently_confirmed" },
});
const opt = { discountRatePct: 0, baseDate: "2027-01-01" };
const line = (r: ReturnType<typeof compareLandlordOffers>, key: string) => r.lines.find((l) => l.key === key)!;

describe("offer-cmp-1.0 landlord offer comparator", () => {
  it("money lines equal the lease-1.0 calculator for the same terms", () => {
    const r = compareLandlordOffers([A], opt);
    const ref = leaseEconomics(offerToLeaseTerms(A, opt));
    expect(line(r, "totalRent").values[0]).toBe("154000000.00");
    expect(line(r, "totalRent").values[0]).toBe(ref.totals.rent);
    expect(line(r, "totalCam").values[0]).toBe("18000000.00");
    expect(line(r, "totalCost").values[0]).toBe("172000000.00");
    expect(line(r, "monthlyRent").values[0]).toBe("2500000.00");
    expect(line(r, "depositAmount").values[0]).toBe("15000000.00");
    expect(line(r, "npv").values[0]).toBe(ref.totals.npv);
    expect(line(r, "effectiveRentPerSf").values[0]).toBe("102.67"); // 154,000,000 / (25,000 × 60)
    expect(line(r, "costPerSeat").values[0]).toBe("688000.00");      // 172,000,000 / 250
    expect(line(r, "rentPerCarpetSf").values[0]).toBe("125.00");     // 100 / 0.80
    expect(line(r, "rentPerSf").status[0]).toBe("currently_confirmed");
    expect(line(r, "camPerSf").status[0]).toBe("reported");
  });

  it("fit-out allowance reduces total cost and NPV by exactly the allowance (paid at signing, 0% discount)", () => {
    const withAllowance = { ...A, name: "A+fitout", fitoutAllowanceInr: 1_000_000 };
    const r = compareLandlordOffers([A, withAllowance], opt);
    expect(line(r, "totalCost").values).toEqual(["172000000.00", "171000000.00"]);
    expect(Number(line(r, "npv").values[0]) - Number(line(r, "npv").values[1])).toBe(1_000_000);
    expect(r.ranking[0].name).toBe("A+fitout");
    expect(r.ranking[1].deltaNpvVsBest).toBe("1000000.00");
    expect(line(r, "fitoutAllowanceInr").best).toBe(1);
  });

  it("unknown fields stay unknown: no CAM → CAM total null and listed; no rent → offer not costed", () => {
    const noCam: LandlordOffer = { ...A, name: "B", camPerSf: null, seats: null, efficiencyPct: null };
    const noRent: LandlordOffer = { ...A, name: "C", rentPerSf: null };
    const r = compareLandlordOffers([A, noCam, noRent], opt);
    expect(line(r, "camPerSf").values[1]).toBeNull();
    expect(line(r, "camPerSf").status[1]).toBeNull();
    expect(line(r, "totalCam").values[1]).toBeNull();
    expect(line(r, "costPerSeat").values[1]).toBeNull();
    expect(line(r, "rentPerCarpetSf").values[1]).toBeNull();
    expect(line(r, "totalCost").values[2]).toBeNull();
    expect(r.computed).toEqual([true, true, false]);
    expect(r.missing.some((m) => m.startsWith("C: not costed") && m.includes("rent"))).toBe(true);
    expect(r.missing.some((m) => m.startsWith("B:") && /CAM/i.test(m))).toBe(true);
    expect(r.unknowns.find((u) => u.offer === "B")!.fields).toContain("camPerSf");
    expect(line(r, "complete").values[1]).toMatch(/INCOMPLETE/);
    expect(r.ranking.map((x) => x.name).sort()).toEqual(["A", "B"]);
  });

  it("schema rejects nonsense and duplicate names are disambiguated", () => {
    expect(() => landlordOfferSchema.parse({ ...A, rentPerSf: -5 })).toThrow();
    const r = compareLandlordOffers([A, A], opt);
    expect(r.names).toEqual(["A", "A (2)"]);
  });
});
