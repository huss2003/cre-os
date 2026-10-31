import { describe, it, expect } from "vitest";
import { checkOutcome, checkTransition, funnel, CLOSING_TEMPLATE, STAGES } from "./stages";

describe("stage machine (spec §8 Stage transitions)", () => {
  it("has the 14 spec stages in order; outcomes are separate", () => {
    expect(STAGES[0]).toBe("research");
    expect(STAGES.at(-1)).toBe("collected");
    expect(STAGES).not.toContain("lost");
  });
  it("cannot reach requirement_confirmed without a client-confirmed requirement or evidence", () => {
    const r = checkTransition("qualified_discussion", "requirement_confirmed", { requirementStatus: "estimated" });
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/client-confirmed/);
    expect(r.reasons.join()).toMatch(/evidence/);
    expect(checkTransition("qualified_discussion", "requirement_confirmed", { requirementStatus: "client_confirmed", evidence: "brief signed 30 Oct" }).ok).toBe(true);
  });
  it("a positive email can move to engaged without evidence but cannot jump to signed without it", () => {
    expect(checkTransition("approach_attempted", "engaged", {}).ok).toBe(true);
    const s = checkTransition("engaged", "signed", { requirementStatus: "client_confirmed" });
    expect(s.ok).toBe(false);
  });
  it("open closing items block the stage they are needed for; lost deals cannot move", () => {
    const r = checkTransition("documentation", "signed", { requirementStatus: "client_confirmed", evidence: "lease signed", openBlockingMilestones: [{ title: "Client internal / board approval", required_for_stage: "signed" }] });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/board approval/);
    expect(checkTransition("engaged", "qualified_discussion", { outcome: "lost", evidence: "x" }).ok).toBe(false);
  });
  it("invoiced/recognised/collected need fee records; backwards needs a reason", () => {
    const fee = { invoiced: false, recognised: false, collected: false };
    expect(checkTransition("possession", "invoiced", { requirementStatus: "client_confirmed", evidence: "inv 12", fee }).ok).toBe(false);
    expect(checkTransition("possession", "invoiced", { requirementStatus: "client_confirmed", evidence: "inv 12", fee: { ...fee, invoiced: true } }).ok).toBe(true);
    expect(checkTransition("loi", "options_visits", {}).ok).toBe(false);
    expect(checkTransition("loi", "options_visits", { evidence: "LOI withdrawn" }).ok).toBe(true);
  });
  it("outcomes: won needs signed; lost needs a reason code", () => {
    expect(checkOutcome("loi", "won").ok).toBe(false);
    expect(checkOutcome("signed", "won").ok).toBe(true);
    expect(checkOutcome("engaged", "lost").ok).toBe(false);
    expect(checkOutcome("engaged", "lost", "renewal_in_place").ok).toBe(true);
  });
  it("closing template covers move dependencies", () => {
    const cats = CLOSING_TEMPLATE.map((t) => t.category);
    for (const c of ["fitout_approval", "it_migration", "handover", "access", "reinstatement", "parallel_rent", "business_interruption"]) expect(cats).toContain(c);
  });
});

describe("funnel maths (spec §12, independently checked)", () => {
  const cohort = { approached: 120, discussions: 15, closures: 1 };
  it("12 closures × ₹30 lakh = ₹3.6 crore; 120 approaches/month", () => {
    const f = funnel({ closuresPerYear: 12, feePerClosure: 3000000, cohort });
    expect(f.attributedRevenue).toBe("36000000.00");
    expect(f.approachesPerYear).toBe("1440.00");
    expect(f.approachesPerMonth).toBe("120.00");
    expect(f.discussionsPerMonth).toBe("15.00");
    expect(f.approachToDiscussion).toBe("12.5000");
    expect(f.discussionToClose).toBe("6.6667");
    expect(f.approachToClose).toBe("0.8333");
    expect(f.approachesPerWeek).toBe("27.69");
    expect(f.approachesPerWorkday).toBe("5.54");
    expect(f.approachesPerWorkdayAtMonth).toBe("6.00");
    expect(f.sixMonthApproachEnvelope).toBe("720.00");
    expect(f.discussionWipEnvelope).toBe("90.00");
  });
  it("₹5 crore at ₹30 lakh needs 17 deals (₹5.1 crore), 170 approaches/month", () => {
    const f = funnel({ annualFeeTarget: 50000000, feePerClosure: 3000000, cohort });
    expect(f.closuresPerYear).toBe(17);
    expect(f.attributedRevenue).toBe("51000000.00");
    expect(f.approachesPerYear).toBe("2040.00");
    expect(f.approachesPerMonth).toBe("170.00");
    expect(f.discussionsPerMonth).toBe("21.25");
    expect(f.approachesPerWeek).toBe("39.23");
    expect(f.approachesPerWorkday).toBe("7.85");
    expect(f.approachesPerWorkdayAtMonth).toBe("8.50");
    expect(f.discussionWipEnvelope).toBe("127.50");
  });
});
