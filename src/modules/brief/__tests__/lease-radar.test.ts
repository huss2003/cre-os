import { describe, expect, it } from "vitest";
import { edate, subtractBusinessDays } from "../dates";
import { analyseLease, callWindowFor, inWindow, landlordConcentration, reversePlan, runRadar, type LeaseEventInput, type LeaseInput } from "../lease-radar";

const TODAY = "2026-11-02";
const L = (over: Partial<LeaseInput> = {}): LeaseInput => ({ id: "l1", tenantOrgId: "o1", tenantName: "Acme", assetName: "Tower A", areaSf: 20000, ...over });
const ev = (over: Partial<LeaseEventInput>): LeaseEventInput => ({ id: "e" + Math.random(), leaseId: "l1", eventType: "expiry", eventDate: null, dateBasis: "contractual", ...over });

describe("Lease chronology (spec acceptance test)", () => {
  it("integer-month expiry equals EDATE with month-end clamp, independently of the engine", () => {
    // independent expectation: 31 Jan 2024 + 1 month = 29 Feb 2024 (leap year), + 13 months = 28 Feb 2025
    expect(edate("2024-01-31", 1)).toBe("2024-02-29");
    expect(edate("2024-01-31", 13)).toBe("2025-02-28");
    const r = analyseLease(L({ startDate: "2022-01-31", tenureMonthsRaw: 61 }), [], TODAY);
    expect(r.expiry).toMatchObject({ date: "2027-02-28", basis: "calculated_by_radar", verified: false, formula: "EDATE(2022-01-31, 61)" });
  });

  it("fractional tenure is quarantined: no expiry invented, enrichment raised", () => {
    const r = analyseLease(L({ startDate: "2022-01-01", tenureMonthsRaw: 36.5 }), [], TODAY);
    expect(r.status).toBe("quarantined");
    expect(r.expiry).toBeNull();
    expect(r.enrichment.map((e) => e.key)).toContain("fractional_tenure");
    expect(r.issues.join(" ")).toMatch(/Fractional tenure \(36\.5 months\) quarantined/);
  });

  it("lock-in is a separate fact and is never used as expiry", () => {
    const r = analyseLease(L({ startDate: "2024-04-01", lockinMonthsRaw: 36 }), [], TODAY);
    expect(r.lockinEnd?.date).toBe("2027-04-01");
    expect(r.expiry).toBeNull();
    expect(r.status).toBe("dates_unknown");
    expect(r.issues.join(" ")).toMatch(/Only a lock-in end is known/);
    expect(r.enrichment[0].key).toBe("missing_expiry");
  });

  it("contractual expiry wins over calculated; a disagreement is reported, not silently replaced", () => {
    const r = analyseLease(L({ startDate: "2022-01-01", tenureMonthsRaw: 60, contractualExpiry: "2026-12-31" }), [], TODAY);
    expect(r.expiry).toMatchObject({ date: "2026-12-31", basis: "contractual", verified: true });
    expect(r.issues.join(" ")).toMatch(/Calculated expiry 2027-01-01 .* differs from contractual 2026-12-31/);
  });

  it("notice deadline needs notice length AND a day rule; business days skip weekends", () => {
    const noRule = analyseLease(L(), [ev({ eventDate: "2027-03-31", noticeDays: 90 })], TODAY);
    expect(noRule.noticeDeadline).toBeNull();
    expect(noRule.issues.join(" ")).toMatch(/no business\/calendar day rule/);

    const cal = analyseLease(L(), [ev({ eventDate: "2027-03-31", noticeDays: 90, noticeDayRule: "calendar" })], TODAY);
    expect(cal.noticeDeadline).toMatchObject({ date: "2026-12-31", basis: "calculated_by_radar", verified: true });
    expect(cal.noticeDeadline!.basisLabel).toMatch(/expiry − 90 calendar days/);

    // 2027-03-31 is a Wednesday; 5 business days back = Wednesday 2027-03-24
    expect(subtractBusinessDays("2027-03-31", 5)).toBe("2027-03-24");
    const biz = analyseLease(L(), [ev({ eventDate: "2027-03-31", noticeDays: 5, noticeDayRule: "business" })], TODAY);
    expect(biz.noticeDeadline?.date).toBe("2027-03-24");
  });

  it("explicit notice event beats derived; reported basis is not verified", () => {
    const r = analyseLease(L(), [ev({ eventDate: "2027-03-31", noticeDays: 90, noticeDayRule: "calendar" }), ev({ eventType: "notice_deadline", eventDate: "2026-12-15", dateBasis: "reported" })], TODAY);
    expect(r.noticeDeadline).toMatchObject({ date: "2026-12-15", basis: "reported", verified: false });
  });

  it("expired lease is 'status needs confirmation', no reverse plan or call window", () => {
    const r = analyseLease(L({ contractualExpiry: "2026-10-31" }), [], TODAY);
    expect(r.status).toBe("expired_needs_confirmation");
    expect(r.plan).toBeNull();
    expect(r.callWindow).toBeNull();
    expect(r.enrichment[0].key).toBe("expired_status");
  });

  it("reverse plan works backwards from occupation: move buffer, fit-out by size, procurement, decision, options", () => {
    const p = reversePlan({ occupation: "2027-12-31", occupationBasis: "expiry", areaSf: 20000, today: TODAY });
    expect(p).toMatchObject({ moveBy: "2027-12-17", fitoutMonths: 3, fitoutStart: "2027-09-17", procurementStart: "2027-07-17", decisionBy: "2027-07-17", optionsStart: "2027-05-17", lastDecision: "2027-07-17", viable: true });
    const withNotice = reversePlan({ occupation: "2027-12-31", occupationBasis: "expiry", areaSf: 20000, noticeDeadline: "2027-06-30", today: TODAY });
    expect(withNotice.lastDecision).toBe("2027-06-30");
    const w = callWindowFor(p, TODAY);
    expect(w).toEqual({ opens: "2027-02-17", closes: "2027-07-17", state: "upcoming" });
    expect(callWindowFor(p, "2027-07-01").state).toBe("closing");
    expect(callWindowFor(p, "2027-08-01").state).toBe("missed");
  });

  it("radar windows and landlord concentration", () => {
    const items = runRadar([
      L({ id: "a", contractualExpiry: "2026-12-31", assetId: "t1", assetName: "Tower A", landlordName: "LL" }),
      L({ id: "b", contractualExpiry: "2027-02-15", assetId: "t1", assetName: "Tower A", landlordName: "LL", tenantName: "Beta" }),
      L({ id: "c", contractualExpiry: "2028-01-31", assetId: "t2", assetName: "Tower B" }),
      L({ id: "d", contractualExpiry: "2026-01-31" }),
      L({ id: "e" }),
    ], [], TODAY);
    expect(items.filter((i) => inWindow(i, "0-3", TODAY)).map((i) => i.leaseId)).toEqual(["a"]);
    expect(items.filter((i) => inWindow(i, "3-12", TODAY)).map((i) => i.leaseId)).toEqual(["b"]);
    expect(items.filter((i) => inWindow(i, "12-24", TODAY)).map((i) => i.leaseId)).toEqual(["c"]);
    expect(items.filter((i) => inWindow(i, "expired", TODAY)).map((i) => i.leaseId)).toEqual(["d"]);
    expect(items.filter((i) => inWindow(i, "unknown", TODAY)).map((i) => i.leaseId)).toEqual(["e"]);
    const conc = landlordConcentration(items, TODAY);
    expect(conc[0]).toMatchObject({ building: "Tower A", landlord: "LL", leases: 1 });
    expect(conc.map((c) => c.quarter).sort()).toEqual(["2026-Q4", "2027-Q1", "2028-Q1"]);
  });
});
