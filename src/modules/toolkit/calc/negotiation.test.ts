import { describe, it, expect } from "vitest";
import { analyseNegotiation, appendOffer, diffOffers, valuePackages, type OfferTerms, type OfferVersion } from "./negotiation";
import { sameOutputs } from "../store";

/**
 * Offer 1: ₹100, 6m deposit, 1m free, 15%/36m; Offer 2: ₹95, 6m, 3m free, 12%/36m. 25,000 SF, CAM ₹12, 60 months, 0%.
 * Hand-computed: O1 rent = 35×2,500,000 + 24×2,875,000 = 87,500,000 + 69,000,000 = 156,500,000.
 *               O2 rent = 33×2,375,000 + 24×2,660,000 = 78,375,000 + 63,840,000 = 142,215,000.
 *               Rent difference = −14,285,000; deposit 15,000,000 → 14,250,000 (−750,000).
 *               Totals incl. CAM 18,000,000: 174,500,000 vs 160,215,000 → NPV change at 0% = −14,285,000.
 */
const base: OfferTerms = {
  name: "Offer", label: "quoted", areaSf: 25000, areaBasis: "chargeable", rentPerSf: 100, leaseCommencement: "2027-01-01",
  tenureMonths: 60, rentFreeMonths: 1, escalationPct: 15, escalationEveryMonths: 36, camPerSf: 12, parkingSlots: 0,
  depositMonths: 6, otherRecurringState: "none", gst: { treatment: "included" }, discountRatePct: 0,
  lockInMonths: 36, noticeMonths: 6, restoration: "bare shell", possessionDate: "2026-11-01",
};
const o2: OfferTerms = { ...base, rentPerSf: 95, rentFreeMonths: 3, escalationPct: 12, lockInMonths: 24, restoration: null };

let versions: OfferVersion[] = [];
versions = appendOffer(versions, base, "2026-11-01T00:00:00Z");
versions = appendOffer(versions, o2, "2026-11-05T00:00:00Z");

describe("nego-1.0 negotiation comparison", () => {
  it("Offer 1 vs Offer 2 financial difference matches hand computation", () => {
    const a = analyseNegotiation(versions);
    expect(a.offers[0].rentTotal).toBe("156500000.00");
    expect(a.offers[1].rentTotal).toBe("142215000.00");
    expect(a.offers[0].depositAmount).toBe("15000000.00");
    expect(a.offers[1].depositAmount).toBe("14250000.00");
    expect(a.offers[0].contractualExpenditure).toBe("174500000.00");
    expect(a.offers[1].contractualExpenditure).toBe("160215000.00");
    const f = a.diffs[1].financial!;
    expect(f.rentChange).toBe("-14285000.00");
    expect(f.depositChange).toBe("-750000.00");
    expect(f.npvChange).toBe("-14285000.00");
    expect(f.better).toBe("to");
  });

  it("term diff: improved / worse / unchanged / unresolved", () => {
    const d = Object.fromEntries(diffOffers(base, o2).map((t) => [t.key, t.status]));
    expect(d.rentPerSf).toBe("improved");
    expect(d.rentFreeMonths).toBe("improved");
    expect(d.escalationPct).toBe("improved");
    expect(d.depositMonths).toBe("unchanged");
    expect(d.lockInMonths).toBe("improved");
    expect(d.restoration).toBe("unresolved");
    const worse = Object.fromEntries(diffOffers(o2, base).map((t) => [t.key, t.status]));
    expect(worse.rentPerSf).toBe("worse");
  });

  it("changed rental values append Offer 3; Offers 1-2 preserved and reproducible", () => {
    const before = analyseNegotiation(versions);
    const v3 = appendOffer(versions, { ...o2, rentPerSf: 93 }, "2026-11-08T00:00:00Z");
    expect(v3.map((v) => v.label)).toEqual(["Offer 1", "Offer 2", "Offer 3"]);
    expect(v3[1].terms.rentPerSf).toBe(95);
    expect(sameOutputs(analyseNegotiation(v3.slice(0, 2)), before)).toBe(true);
    expect(analyseNegotiation(v3).diffs[2].financial!.rentChange).toBe("-2994000.00"); // ₹93: 33×2,325,000 + 24×2,604,000 = 139,221,000 vs 142,215,000
  });

  it("concession packages use engine concession equivalence", () => {
    const [p1, p2, p3] = valuePackages(base, [
      { name: "Longer rent-free", items: [{ type: "longer_rent_free", months: 2 }] },
      { name: "Lower deposit", items: [{ type: "lower_deposit", months: 2 }] },
      { name: "Lock-in only", items: [{ type: "flexible_lock_in", months: 12 }] },
    ]);
    // 2 extra rent-free months at ₹2.5M = 5,000,000 at 0%
    expect(p1.npvValue).toBe("5000000.00");
    expect(p1.itemValues[0].equivalentRentFreeMonths).toBe("2.00");
    // deposit refunded in full: worth 0 at 0% discount
    expect(p2.npvValue).toBe("0.00");
    expect(p3.npvValue).toBeNull();
    const at12 = valuePackages({ ...base, discountRatePct: 12 }, [{ name: "Lower deposit", items: [{ type: "lower_deposit", months: 2 }] }]);
    expect(Number(at12[0].npvValue)).toBeGreaterThan(0);
  });

  it("strategy panel is deterministic and lists unresolved terms and risks", () => {
    const a = analyseNegotiation(versions, [{ name: "Fit-out ₹50L", items: [{ type: "fitout_contribution", amount: 5000000 }] }]);
    expect(a.strategy.unresolved).toContain("Restoration");
    expect(a.strategy.risks.some((r) => /Restoration/.test(r))).toBe(true);
    expect(a.strategy.preferredOutcome).toMatch(/Fit-out ₹50L/);
    expect(sameOutputs(a, analyseNegotiation(versions, [{ name: "Fit-out ₹50L", items: [{ type: "fitout_contribution", amount: 5000000 }] }]))).toBe(true);
  });
});
