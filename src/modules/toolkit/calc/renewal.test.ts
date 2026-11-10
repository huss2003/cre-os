import { describe, expect, it } from "vitest";
import { compareRenewalRelocation, NONFIN, type RvrInput } from "./renewal";

const base = (): RvrInput => ({
  comparisonMonths: 36, discountRatePct: 0,
  renewal: { currentRentMonthly: 900000, proposedRentMonthly: 1000000, escalation: { pct: 0, everyMonths: 12 }, extensionMonths: 36, rentFreeMonths: 0,
    camMonthly: 100000, depositChange: 500000, refurbishment: 1000000, maintenanceMonthly: 0, otherMonthly: 0, otherOneOff: 0 },
  relocation: { newRentMonthly: 800000, escalation: { pct: 0, everyMonths: 12 }, rentFreeMonths: 3, camMonthly: 100000, deposit: 4800000, oldDepositReturned: 5400000,
    fitout: 4000000, moving: 500000, restorationOld: 500000, overlapMonths: 1, brokerage: 800000, itRelocation: 200000, downtimeCost: 0, employeeTransition: 0, otherMonthly: 0, otherOneOff: 0 },
  scores: Object.fromEntries(NONFIN.map((k) => [k, { renewal: 4, relocation: 3 }])),
});

describe("rvr-1.0 renewal vs relocation (hand-computed)", () => {
  it("totals, initial cash, deposits", () => {
    const r = compareRenewalRelocation(base());
    expect(r.renewal!.total).toBe("40600000.00"); // 1,100,000×36 + 1,000,000
    expect(r.renewal!.initialCash).toBe("2100000.00");
    expect(r.renewal!.depositNet).toBe("500000.00");
    // relocation: one-offs 6,000,000 + overlap 900,000 + 3×100,000 (rent-free) + 33×900,000
    expect(r.relocation!.total).toBe("36900000.00");
    expect(r.relocation!.initialCash).toBe("7000000.00");
    expect(r.relocation!.depositNet).toBe("-600000.00");
    expect(r.difference).toEqual({ total: "-3700000.00", pv: "-3700000.00", cheaper: "relocation" });
    expect(r.renewal!.annualAverage).toBe("13533333.33");
  });
  it("break-even month", () => {
    // R(m)=1,000,000+1,100,000m; L(m)=4,500,000+900,000m for m≥3 → L≤R from m≥17.5 → 18
    const r = compareRenewalRelocation(base());
    expect(r.breakEven!.month).toBe(18);
    expect(r.relocation!.cumulative[16]).toBe("19800000.00"); expect(r.renewal!.cumulative[16]).toBe("19700000.00");
    const i = base(); i.relocation.newRentMonthly = 1000000;
    expect(compareRenewalRelocation(i).breakEven).toEqual({ month: null, text: expect.stringMatching(/None within period/) });
  });
  it("present value at 12% p.a.", () => {
    const i = base(); i.discountRatePct = 12;
    const v = 1 / Math.pow(1.12, 1 / 12); let ann = 0; for (let k = 0; k < 36; k++) ann += Math.pow(v, k);
    expect(Number(compareRenewalRelocation(i).renewal!.pv)).toBeCloseTo(1000000 + 1100000 * ann, 0);
  });
  it("never recommends relocation on rent alone; negotiation uses relocation as leverage", () => {
    const r = compareRenewalRelocation(base());
    expect(r.financiallyPreferable).toBe("relocation");
    expect(r.operationallyPreferable).toBe("renewal");
    expect(r.verdict).toMatch(/does not justify relocating/);
    // 3,700,000 / 36 rent months = 102,777.78 → 897,222.22
    expect(r.negotiation[0]).toMatch(/102777\.78.*897222\.22/);
  });
  it("unknown ≠ 0", () => {
    const i = base(); i.relocation.fitout = ""; i.scores = {};
    const r = compareRenewalRelocation(i);
    expect(r.relocation!.complete).toBe(false);
    expect(r.missing).toContain("Relocation: fit-out");
    expect(r.operationallyPreferable).toBeNull();
    const j = base(); j.discountRatePct = "";
    expect(compareRenewalRelocation(j).ok).toBe(false);
  });
});
