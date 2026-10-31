/**
 * Workflow 10 Lease Radar — acceptance: event types remain distinct (expiry ≠ lock-in ≠ notice ≠ break ≠ escalation ≠
 * option); calculations are reproducible and distinguished from verified dates; ambiguous clauses are flagged.
 */
import { describe, expect, it } from "vitest";
import { edate } from "../dates";
import { analyseLease, planMilestones, upcomingEventFacts, type LeaseEventInput, type LeaseInput } from "../lease-radar";

const TODAY = "2031-03-10";
const L = (over: Partial<LeaseInput> = {}): LeaseInput => ({ id: "l1", tenantOrgId: "o1", tenantName: "Acme", assetName: "Tower A", areaSf: 20000, ...over });
const ev = (over: Partial<LeaseEventInput>): LeaseEventInput => ({ id: "e" + Math.random().toString(36).slice(2), leaseId: "l1", eventType: "expiry", eventDate: null, dateBasis: "contractual", ...over });

describe("Lease radar round 2", () => {
  it("rent escalation and option events are their own event types, never merged into expiry/notice", () => {
    const r = analyseLease(L({ contractualExpiry: "2033-06-30" }), [
      ev({ eventType: "escalation", eventDate: "2031-04-01", dateBasis: "contractual" }),
      ev({ eventType: "option", eventDate: "2032-12-31", dateBasis: "reported" }),
      ev({ eventType: "lockin_end", eventDate: "2031-09-30", dateBasis: "contractual" }),
    ], TODAY);
    expect(r.escalations.map((e) => e.date)).toEqual(["2031-04-01"]);
    expect(r.options.map((e) => e.date)).toEqual(["2032-12-31"]);
    expect(r.expiry!.date).toBe("2033-06-30");
    expect(r.lockinEnd!.date).toBe("2031-09-30");
    expect(r.noticeDeadline).toBeNull();
    expect(upcomingEventFacts(r, TODAY, 30).map((u) => [u.kind, u.fact.date])).toEqual([["escalation", "2031-04-01"]]);
  });

  it("calculates escalation dates from a stated clause term (EDATE from start, within the term) and keeps formula + source clause", () => {
    const lease = L({ startDate: "2029-01-15", tenureMonthsRaw: 108, escalationTerms: [{ clauseId: "c1", documentId: "d1", percent: 15, everyMonths: 36 }] });
    const r = analyseLease(lease, [], TODAY);
    expect(r.escalations.map((e) => e.date)).toEqual([edate("2029-01-15", 36), edate("2029-01-15", 72)]); // 108-month term: steps at 36, 72 (not 108 = expiry)
    expect(r.escalations[0]).toMatchObject({ basis: "calculated_by_radar", verified: false, sourceClauseId: "c1", detail: "+15% (stated)", formula: "EDATE(2029-01-15, 1 × 36)" });
    const keys = r.calculated.map((c) => c.calcKey);
    expect(keys).toEqual(["radar:l1:expiry", "radar:l1:escalation:1", "radar:l1:escalation:2"]);
    expect(r.calculated.find((c) => c.eventType === "escalation")!).toMatchObject({ sourceClauseId: "c1", inputs: { start_date: "2029-01-15", every_months: 36, step: 1, percent: 15, clause_id: "c1" } });
    // reproducible: same inputs → identical calculated events
    expect(analyseLease(lease, [], TODAY).calculated).toEqual(r.calculated);
    // explicit escalation events win; nothing is calculated over them
    const withEvent = analyseLease(lease, [ev({ eventType: "escalation", eventDate: "2032-02-01", dateBasis: "contractual" })], TODAY);
    expect(withEvent.escalations.map((e) => e.basis)).toEqual(["contractual"]);
    expect(withEvent.calculated.some((c) => c.eventType === "escalation")).toBe(false);
  });

  it("escalation without a stated frequency or without a known term is not calculated (unknown stays unknown) and is flagged", () => {
    const noFreq = analyseLease(L({ startDate: "2029-01-15", tenureMonthsRaw: 60, escalationTerms: [{ clauseId: "c1", documentId: "d1", percent: 5, everyMonths: null }] }), [], TODAY);
    expect(noFreq.escalations).toEqual([]);
    expect(noFreq.reviewFlags.some((f) => /frequency is not stated/.test(f.reason))).toBe(true);
    const noTerm = analyseLease(L({ startDate: "2029-01-15", lockinMonthsRaw: 36, escalationTerms: [{ clauseId: "c1", documentId: "d1", percent: 5, everyMonths: 12 }] }), [], TODAY);
    expect(noTerm.escalations).toEqual([]);
    expect(noTerm.issues.join(" ")).toMatch(/term\/expiry is unknown/);
  });

  it("ambiguous clauses (needs_review + review_reason, undated events, flagged escalation clause) are flagged for review", () => {
    const r = analyseLease(L({ contractualExpiry: "2033-06-30", escalationTerms: [{ clauseId: "c9", documentId: "d1", percent: 5, everyMonths: 12, needsReview: true, excerpt: "rent shall be enhanced as mutually agreed" }] }), [
      ev({ eventType: "break", eventDate: "2032-01-01", dateBasis: "reported", needsReview: true, reviewReason: "Break clause wording ambiguous: 'after 24 months' from LOI or lease?" }),
      ev({ eventType: "notice_deadline", eventDate: null, dateBasis: "contractual" }),
    ], TODAY);
    const reasons = r.reviewFlags.map((f) => f.reason).join(" | ");
    expect(reasons).toMatch(/Break clause wording ambiguous/);
    expect(reasons).toMatch(/notice deadline event has no date/);
    expect(reasons).toMatch(/Escalation clause needs review/);
    expect(r.breaks[0].detail).toMatch(/needs review/);
  });

  it("calculated dates are separate from verified ones and lock-in is never expiry", () => {
    const r = analyseLease(L({ startDate: "2029-04-01", lockinMonthsRaw: 36, tenureMonthsRaw: 60 }), [], TODAY);
    expect(r.calculated.map((c) => [c.eventType, c.date])).toEqual([["expiry", "2034-04-01"], ["lockin_end", "2032-04-01"]]);
    const verified = analyseLease(L({ startDate: "2029-04-01", lockinMonthsRaw: 36, contractualExpiry: "2034-03-31" }), [], TODAY);
    expect(verified.calculated.map((c) => c.eventType)).toEqual(["lockin_end"]); // contractual expiry is not re-persisted as calculated
  });

  it("reverse-plan milestones (options, decision, procurement, fit-out, notice) are dated for task creation", () => {
    const r = analyseLease(L({ contractualExpiry: "2031-12-31" }), [ev({ eventType: "notice_deadline", eventDate: "2031-06-30", dateBasis: "contractual" })], TODAY);
    const ms = planMilestones(r);
    expect(ms.map((m) => m.key)).toEqual(["options_start", "decision_by", "procurement_start", "fitout_start", "notice_deadline"]);
    expect(ms.find((m) => m.key === "fitout_start")!.date).toBe(r.plan!.fitoutStart);
    expect(planMilestones({ plan: r.plan, status: "expired_needs_confirmation" })).toEqual([]);
  });
});
