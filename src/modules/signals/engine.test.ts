import { describe, it, expect } from "vitest";
import { leaseSignal, counterEvidence, assessConfidence, priorityOf, categoryOf, dedupeKey, nextAction, missingInfo } from "./engine";

const T = "2026-11-08";
describe("Signal engine — pure rules", () => {
  it("keeps lease event types distinct and windowed", () => {
    const base = { id: "x", date_basis: "contractual", confirmed: true, notice_days: null };
    expect(leaseSignal({ ...base, event_type: "expiry", event_date: "2027-06-30" }, T)!.kind).toBe("lease_expiry");
    expect(leaseSignal({ ...base, event_type: "lockin_end", event_date: "2027-06-30" }, T)!.kind).toBe("lease_lockin_end");
    expect(leaseSignal({ ...base, event_type: "notice_deadline", event_date: "2027-03-01" }, T)!.title).toMatch(/Notice deadline/);
    expect(leaseSignal({ ...base, event_type: "notice_deadline", event_date: "2028-03-01" }, T)).toBeNull();
    expect(leaseSignal({ ...base, event_type: "expiry", event_date: null }, T)).toBeNull();
  });
  it("past expiry → verification only, never a space-need claim", () => {
    const s = leaseSignal({ id: "x", event_type: "expiry", event_date: "2026-05-01", date_basis: "reported", confirmed: false, notice_days: null }, T)!;
    expect(s.kind).toBe("lease_expiry_past"); expect(s.verification).toBe("unknown"); expect(s.recommended).toMatch(/Do not assume/);
    expect(leaseSignal({ id: "x", event_type: "break", event_date: "2026-05-01", date_basis: "reported", confirmed: false, notice_days: null }, T)).toBeNull();
  });
  it("finds counter-evidence: other city, remote, existing office, hiring caveat, layoffs, duplicates, stale", () => {
    const c = counterEvidence({ category: "expansion", kind: "hiring", texts: ["Hiring 500 engineers in Hyderabad, fully remote roles, at its existing office"], focusCities: ["Pune"], sourceCount: 3, latestEvidenceOn: "2026-01-01", today: T, hasOccupancyInFocus: false });
    expect(c.join(" ")).toMatch(/Hyderabad/); expect(c.join(" ")).toMatch(/remote/); expect(c.join(" ")).toMatch(/existing office/);
    expect(c.join(" ")).toMatch(/not an office-size commitment/); expect(c.join(" ")).toMatch(/3 sources/); expect(c.join(" ")).toMatch(/6 months/);
    expect(counterEvidence({ category: "restructuring", kind: "layoff", texts: ["layoffs"], focusCities: ["Pune"], sourceCount: 1, latestEvidenceOn: null, today: T, hasOccupancyInFocus: false }).join(" ")).toMatch(/do not automatically/);
  });
  it("confidence comes from evidence, not model certainty", () => {
    expect(assessConfidence([], []).confidence).toBe("insufficient");
    expect(assessConfidence([{ tier: "inference", status: "ai_inference", source: "x", published_on: null }], []).confidence).toBe("low");
    expect(assessConfidence([{ tier: "credible_reported", status: "reported", source: "a", published_on: null }], []).confidence).toBe("medium");
    expect(assessConfidence([{ tier: "credible_reported", status: "reported", source: "a", published_on: null }, { tier: "credible_reported", status: "reported", source: "b", published_on: null }], []).confidence).toBe("high");
  });
  it("priority shows reasons; strong evidence alone is capped below high", () => {
    const p = priorityOf({ category: "lease", daysAway: 60, confidence: "high", inFocusGeo: true, hasContact: true, hasOpenOpportunity: false, hasRequirement: false, leaseWithin18m: true, freshnessDays: 5, needsVerification: false });
    expect(p.band).toBe("high"); expect(p.reasons.length).toBeGreaterThan(3);
    const q = priorityOf({ category: "expansion", daysAway: null, confidence: "high", inFocusGeo: true, hasContact: false, hasOpenOpportunity: false, hasRequirement: false, leaseWithin18m: false, freshnessDays: 1, needsVerification: false }, { timing: 25, relevance: 15, evidence: 40, geography: 15, access: 15, commercial: 10, freshness: 5, verificationPenalty: 10, highAt: 60, mediumAt: 35 });
    expect(q.band).toBe("medium"); expect(q.reasons.join(" ")).toMatch(/Capped/);
  });
  it("maps categories, groups by month, and suggests actions without inventing numbers", () => {
    expect(categoryOf("gcc_plan")).toBe("expansion"); expect(categoryOf("job_move")).toBe("leadership"); expect(categoryOf("weather")).toBeNull();
    expect(dedupeKey("expansion", "expansion", "Org", "2026-11-03")).toBe(dedupeKey("expansion", "expansion", "org", "2026-11-28"));
    expect(nextAction("expansion", "gcc_plan", { hasLease: false, hasContact: false, hasRequirement: false, occupancyVerified: false, locations: [] }).text).toMatch(/team size/);
    expect(missingInfo("expansion", { hasLease: false, hasContact: false, hasRequirement: false, occupancyVerified: false, locations: [] }).join(" ")).toMatch(/not inferred/);
  });
});
