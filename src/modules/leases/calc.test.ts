import { describe, it, expect } from "vitest";
import { addMonths, addBusinessDays, effectiveAfter, noticeDeadline, parseDuration, periodEnd, periodFromClause } from "./dates";
import { escalationSchedule, escalationDiscrepancy, parseEscalationClause } from "./escalation";
import { buildExtraction, findClauses, responsibleParty, statedDates } from "./extract";
import { checkTransition } from "./status";
import { costOverview, findConflicts, identifyOpportunities, planReminders, portfolio, type DateRow } from "./planning";
import { DRAFT_LOI_PAGES, EXECUTED_LEASE_PAGES } from "./fixtures";

describe("date calculation matrix (USER-RULES #1, SPEC §4.2)", () => {
  it("36-month lock-in from 1 Jan 2027 ends 31 Dec 2029 (period includes start); effective-after = 1 Jan 2030", () => {
    const r = periodEnd("2027-01-01", 36);
    expect(r.date).toBe("2029-12-31");
    expect(r.status).toBe("calculated");
    expect(r.convention.counting).toBe("period_inclusive_end");
    expect(r.method).toMatch(/edate\(2027-01-01, 36\) − 1 day/);
    expect(effectiveAfter("2027-01-01", 36).date).toBe("2030-01-01");
  });
  it.each([
    ["2027-01-31", 1, "2027-02-28"], ["2028-01-31", 1, "2028-02-29"], ["2027-03-31", 1, "2027-04-30"], ["2027-08-31", 6, "2028-02-29"],
    ["2027-01-15", 12, "2028-01-15"], ["2029-12-31", -6, "2029-06-30"], ["2027-02-28", 1, "2027-03-28"],
  ])("addMonths(%s, %i) = %s (end-of-month clamp)", (d, m, want) => expect(addMonths(d, m as number)).toBe(want));
  it("end-of-month to end-of-month option", () => expect(addMonths("2027-02-28", 1, { eomToEom: true })).toBe("2027-03-31"));
  it("fractional months are never computed → needs_review", () => {
    expect(periodEnd("2027-01-01", 36.5).status).toBe("needs_review");
    expect(() => addMonths("2027-01-01", 1.5)).toThrow();
  });
  it("'not less than 6 months prior to expiry' → edate(expiry, −6), calculated", () => {
    const r = noticeDeadline("notice of not less than six (6) months prior to the expiry of the term", { expiry: "2029-12-31" });
    expect(r.date).toBe("2029-06-30");
    expect(r.status).toBe("calculated");
    expect(r.convention.direction).toBe("before");
  });
  it("'at least 90 days before expiry' and clear days", () => {
    expect(noticeDeadline("at least 90 days before the expiry", { expiry: "2030-03-31" }).date).toBe("2029-12-31");
    expect(noticeDeadline("not less than 30 clear days before expiry", { expiry: "2030-03-31" }).date).toBe("2030-02-28");
  });
  it("'within 90 days' without an anchor → needs_review with alternatives", () => {
    const r = noticeDeadline("The Lessee shall respond within 90 days.", { expiry: "2030-12-31", commencement: "2027-01-01" });
    expect(r.status).toBe("needs_review");
    expect(r.date).toBeNull();
    expect(r.alternatives.map((a) => a.date)).toEqual(expect.arrayContaining(["2027-04-01", "2031-03-31"]));
  });
  it("'within 90 days of commencement' → anchor + 90, still needs_review (anchor-day counting)", () => {
    const r = noticeDeadline("within 90 days from the commencement date", { commencement: "2027-01-01" });
    expect(r.date).toBe("2027-04-01");
    expect(r.status).toBe("needs_review");
    expect(r.alternatives.length).toBeGreaterThan(1);
  });
  it("ambiguous wording (no direction / qualified / words≠figures) → needs_review", () => {
    expect(noticeDeadline("six months notice", { expiry: "2030-12-31" }).status).toBe("needs_review");
    expect(noticeDeadline("approximately 6 months prior to expiry", { expiry: "2030-12-31" }).status).toBe("needs_review");
    const mm = noticeDeadline("not less than six (3) months prior to expiry", { expiry: "2030-12-31" });
    expect(mm.status).toBe("needs_review");
    expect(mm.reason).toMatch(/words and figures/);
  });
  it("unknown anchor → no date, needs_review", () => {
    const r = noticeDeadline("not less than 6 months prior to expiry", {});
    expect(r.date).toBeNull(); expect(r.status).toBe("needs_review");
  });
  it("business days skip weekends and always need review (holidays)", () => {
    expect(addBusinessDays("2027-01-01", 5)).toBe("2027-01-08");
    expect(noticeDeadline("not less than 10 business days before expiry", { expiry: "2027-01-15" }).status).toBe("needs_review");
  });
  it("'from' vs 'after' wording for periods", () => {
    expect(periodFromClause("lock-in of 36 months from the commencement date", "2027-01-01").date).toBe("2029-12-31");
    const r = periodFromClause("lock-in ending 36 months after commencement", "2027-01-01");
    expect(r.status).toBe("needs_review");
    expect(r.alternatives.map((a) => a.date)).toEqual(["2029-12-31", "2030-01-01"]);
  });
  it("parses words + figures", () => {
    expect(parseDuration("thirty six (36) months")?.n).toBe(36);
    expect(parseDuration("one hundred and eight months")?.n).toBe(108);
  });
});

describe("escalation (§6)", () => {
  it("₹10,00,000 + 15% after 36 months → ₹11,50,000 on 1 Jan 2030", () => {
    const s = escalationSchedule(1000000, "2027-01-01", { basis: "compounding", pct: 15, everyMonths: 36 }, 108);
    expect(s.steps[0]).toMatchObject({ effectiveDate: "2030-01-01", expectedMonthlyRent: "1150000.00" });
    expect(s.steps[1].expectedMonthlyRent).toBe("1322500.00");
  });
  it("on-original vs compounding differ; fixed amount; unknown basis stops after step 1", () => {
    expect(escalationSchedule(1000000, "2027-01-01", { basis: "on_original", pct: 15, everyMonths: 36 }, 108).steps[1].expectedMonthlyRent).toBe("1300000.00");
    expect(escalationSchedule(1000000, "2027-01-01", { basis: "fixed_amount", amount: 50000, everyMonths: 12 }, 36).steps.map((s) => s.expectedMonthlyRent)).toEqual(["1050000.00", "1100000.00"]);
    const u = escalationSchedule(1000000, "2027-01-01", { basis: "unknown", pct: 15, everyMonths: 36 }, 108);
    expect(u.steps[0].expectedMonthlyRent).toBe("1150000.00");
    expect(u.steps[1].expectedMonthlyRent).toBeNull();
    expect(u.missing.join()).toMatch(/basis/);
  });
  it("expected vs actual discrepancy", () => {
    expect(escalationDiscrepancy("1150000.00", 1150000).status).toBe("match");
    expect(escalationDiscrepancy("1150000.00", 1140000)).toEqual({ status: "discrepancy", difference: "-10000.00" });
    expect(escalationDiscrepancy("1150000.00", null).status).toBe("unknown");
  });
  it("parses basis only when stated", () => {
    expect(parseEscalationClause("escalated by 15% after every 36 months on the last paid rent")).toMatchObject({ basis: "compounding", pct: 15, everyMonths: 36 });
    expect(parseEscalationClause("increase by 5% every year")!.basis).toBe("unknown");
  });
});

describe("code-first extraction (§9, §18 #4–#10)", () => {
  const ex = buildExtraction(EXECUTED_LEASE_PAGES);
  const by = (t: string) => ex.dates.find((d) => d.date_type === t)!;
  it("extracts dates with clause text + page", () => {
    expect(statedDates("1st January 2027, 31/12/2035, March 5, 2027")).toEqual(["2027-01-01", "2027-03-05", "2035-12-31"]);
    expect(by("commencement")).toMatchObject({ calculated_date: "2027-01-01", page: 1, verification_status: "extracted" });
    expect(by("expiry")).toMatchObject({ calculated_date: "2035-12-31", page: 1 });
    expect(by("execution").calculated_date).toBe("2026-12-15");
  });
  it("lock-in, notice, renewal, break, escalation", () => {
    expect(by("lockin_end")).toMatchObject({ calculated_date: "2029-12-31", page: 2, verification_status: "calculated" });
    expect(by("lockin_end").review_reason).toMatch(/does not by itself permit termination/);
    expect(by("termination_notice_deadline").calculated_date).toBe("2035-06-30");
    expect(by("renewal_notice_deadline").calculated_date).toBe("2035-06-30");
    expect(by("break_option")).toMatchObject({ calculated_date: "2032-01-01", verification_status: "needs_review" });
    expect(by("escalation")).toMatchObject({ calculated_date: "2030-01-01" });
    expect(by("escalation").label).toMatch(/1150000\.00/);
    expect(ex.terms).toMatchObject({ monthlyRent: 1000000, camMonthly: 120000, securityDeposit: 6000000, lockinMonths: 36, termMonths: 108 });
  });
  it("obligations are classified by party", () => {
    expect(ex.obligations.find((o) => o.category === "insurance")?.responsible).toBe("tenant");
    expect(ex.obligations.find((o) => o.category === "repair")?.responsible).toBe("landlord");
    expect(ex.obligations.find((o) => o.category === "restoration")?.responsible).toBe("tenant");
    expect(responsibleParty("The parties will meet")).toBe("unclear");
  });
  it("uncertain dates → needs_review; missing info listed", () => {
    const e2 = buildExtraction(["The lessee may give six months notice. The lease shall commence on 1st April 2027."]);
    expect(e2.missing).toEqual(expect.arrayContaining(["expiry date / term", "lock-in clause", "monthly rent"]));
    expect(findClauses(DRAFT_LOI_PAGES).some((c) => c.kind === "commencement")).toBe(true);
  });
});

describe("status gates (§2.3, §17 #1–2)", () => {
  const today = "2027-02-01";
  it("draft/unsigned never executed; active needs confirmed commencement", () => {
    expect(checkTransition("awaiting_execution", "executed", { today, executedDocument: { id: "d", execution_state: "draft" }, executionDate: "2026-12-15" }).ok).toBe(false);
    expect(checkTransition("awaiting_execution", "executed", { today, executedDocument: { id: "d", execution_state: "executed" }, executionDate: null }).ok).toBe(false);
    expect(checkTransition("awaiting_execution", "executed", { today, executedDocument: { id: "d", execution_state: "executed" }, executionDate: "2026-12-15" }).ok).toBe(true);
    expect(checkTransition("executed", "active", { today, confirmedCommencementOrPossession: null }).ok).toBe(false);
    expect(checkTransition("executed", "active", { today, confirmedCommencementOrPossession: "2027-01-01" }).ok).toBe(true);
    expect(checkTransition("draft", "active", { today, confirmedCommencementOrPossession: "2027-01-01" }).ok).toBe(false);
  });
});

describe("planning (§12–14)", () => {
  const D = (o: Partial<DateRow>): DateRow => ({ id: Math.random().toString(), lease_id: "L", date_type: "expiry", label: null, calculated_date: "2028-12-31", verification_status: "confirmed", document_id: "doc1", page: 1, clause_text: null, method: null, ...o });
  it("reminders only from confirmed dates, configurable offsets, deterministic keys", () => {
    const p = planReminders([D({}), D({ verification_status: "calculated", date_type: "lockin_end" })], { expiry: [365, 90] }, "2027-06-01");
    expect(p.map((x) => x.remind_on)).toEqual(["2028-01-01", "2028-10-02"]);
    expect(p[0].dedupe_key).toBe("lease_rem:L:expiry:2028-12-31:365");
  });
  it("conflicts across documents", () => {
    expect(findConflicts([D({ document_id: "a" }), D({ document_id: "b", calculated_date: "2029-01-31" })])).toHaveLength(1);
    expect(findConflicts([D({ document_id: "a" }), D({ document_id: "a", calculated_date: "2029-01-31" })])).toHaveLength(0);
  });
  it("portfolio aggregates only compatible known values", () => {
    const p = portfolio([
      { id: "a", lifecycle_status: "active", area_sf: 1000, area_basis: "chargeable", monthly_rent: 100, missing: [] },
      { id: "b", lifecycle_status: "active", area_sf: 500, area_basis: "carpet", monthly_rent: null, missing: ["rent"] },
      { id: "c", lifecycle_status: "draft", area_sf: 9999, area_basis: "chargeable", monthly_rent: 9999, missing: [] },
    ]);
    expect(p.leasedArea).toMatchObject({ total: "1000.00", basis: "chargeable", included: 1 });
    expect(p.leasedArea.excluded[0]).toMatchObject({ id: "b" });
    expect(p.monthlyRent).toMatchObject({ total: "100.00", included: 1 });
    expect(p.incomplete).toEqual([{ id: "b", missing: ["rent"] }]);
  });
  it("cost overview never treats unknown as zero", () => {
    const c = costOverview({ monthlyRent: 1000000, camMonthly: null, parkingMonthly: null, otherMonthly: 0, securityDeposit: null, expiry: null }, "2027-01-01");
    expect(c.monthlyKnown).toBe("1000000.00"); expect(c.unknown).toEqual(["CAM", "Parking"]); expect(c.complete).toBe(false);
  });
  it("opportunities are potential, never confirmed requirements (§18 #28)", () => {
    const o = identifyOpportunities([{ id: "L", tenant_org_id: "o", tenant_name: "Acme", lifecycle_status: "active" }], [D({ calculated_date: "2027-09-30" })], "2027-01-01");
    expect(o[0]).toMatchObject({ kind: "expiry_approaching", label: "potential" });
    expect(o[0].next_action).toMatch(/Do not assume relocation/);
  });
});
