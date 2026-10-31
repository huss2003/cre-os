import { describe, expect, it } from "vitest";
import { analyseLease, type LeaseEventInput, type LeaseInput } from "../lease-radar";
import { COMPONENT_MAX, explain, scoreLead, tierFor, type ScoreInput } from "../scoring";

const TODAY = "2026-11-02";

function base(over: Partial<ScoreInput> = {}): ScoreInput {
  return { subjectId: "org-1", subjectName: "Acme", today: TODAY, radar: [], signals: [], relationships: [], knownContacts: 0, engagements: [], decisionPath: "unknown", ...over };
}

function lease(over: Partial<LeaseInput> = {}): LeaseInput {
  return { id: "l1", tenantOrgId: "org-1", tenantName: "Acme", assetName: "Tower A", areaSf: 20000, ...over };
}
const radarFor = (l: Partial<LeaseInput>, ev: LeaseEventInput[] = []) => [analyseLease(lease(l), ev, TODAY)];

describe("rubric v1 — component maxima and totals", () => {
  it("weights sum to 100", () => {
    expect(Object.values(COMPONENT_MAX).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("a fully evidenced account scores exactly 100 and tier act_this_week", () => {
    const r = scoreLead(base({
      requirement: { status: "client_confirmed", hasArea: true, hasLocation: true, decisionDate: "2026-12-15", budgetSet: true, confirmedAt: "2026-10-30" },
      relationships: [{ personName: "CFO", warmth: "trusted", decisionMaker: true, introPermission: false, viaIntroducer: false, lastMeaningfulContact: "2026-10-20" }],
      engagements: [{ at: "2026-10-28T10:00:00Z", kind: "reply", meaningful: true, hasNextStep: true }],
      decisionPath: "confirmed",
    }));
    expect(r.components.timing.points).toBe(25);
    expect(r.components.fit.points).toBe(15);
    expect(r.components.trigger.points).toBe(20);
    expect(r.components.relationship.points).toBe(15);
    expect(r.components.engagement.points).toBe(15);
    expect(r.components.budget.points).toBe(10);
    expect(r.total).toBe(100);
    expect(r.tier).toBe("act_this_week");
    expect(r.warmth).toBe("hot");
    expect(explain(r)).toMatch(/^100\/100/);
  });

  it("empty evidence scores 0 and asks for enrichment (never invents a date)", () => {
    const r = scoreLead(base());
    expect(r.total).toBe(0);
    expect(r.tier).toBe("enrich_or_park");
    expect(r.flags.needsEnrichment).toBe(true);
    expect(r.enrichment[0]).toMatch(/Find lease expiry/);
    expect(r.nextDeadline).toBeNull();
  });
});

describe("tiers and boundaries", () => {
  it.each([[100, "act_this_week"], [75, "act_this_week"], [74, "validate_nurture"], [50, "validate_nurture"], [49, "enrich_or_park"], [0, "enrich_or_park"]])("total %i -> %s", (t, tier) => {
    expect(tierFor(t)).toBe(tier);
  });
});

describe("timing component edges", () => {
  it("contractual expiry in 3–12 months with a viable plan gets 20; calculated (unverified) date is capped at 10", () => {
    const contractual = scoreLead(base({ radar: radarFor({ contractualExpiry: "2027-09-30" }) }));
    expect(contractual.components.timing.points).toBe(20);
    const calculated = scoreLead(base({ radar: radarFor({ startDate: "2022-09-30", tenureMonthsRaw: 60 }) }));
    expect(calculated.components.timing.points).toBe(10);
    expect(calculated.components.timing.evidence.join(" ")).toMatch(/Capped at 10/);
    expect(calculated.flags.unverifiedDates).toBe(true);
  });

  it("expired lease => 0 timing, status needs confirmation, never hot", () => {
    const r = scoreLead(base({ radar: radarFor({ contractualExpiry: "2026-06-30" }) }));
    expect(r.components.timing.points).toBe(0);
    expect(r.flags.statusNeedsConfirmation).toBe(true);
    expect(r.overrides).toContain("expired_status_needs_confirmation");
    expect(r.enrichment.join(" ")).toMatch(/Confirm current status/);
    expect(r.tier).not.toBe("act_this_week");
  });

  it("lease beyond 24 months scores 0 timing; 12–24 months scores 10", () => {
    expect(scoreLead(base({ radar: radarFor({ contractualExpiry: "2029-06-30" }) })).components.timing.points).toBe(0);
    expect(scoreLead(base({ radar: radarFor({ contractualExpiry: "2028-03-31" }) })).components.timing.points).toBe(10);
  });

  it("missed decision lead time (3–12 months, plan not viable) drops to 10", () => {
    // 60k sf -> 4 months fit-out; expiry in 5 months => decision date already passed
    const r = scoreLead(base({ radar: radarFor({ contractualExpiry: "2027-04-15", areaSf: 60000 }) }));
    expect(r.components.timing.points).toBe(10);
    expect(r.components.timing.band).toMatch(/decision lead time already passed/);
  });
});

describe("overrides", () => {
  const noticeEv: LeaseEventInput[] = [{ id: "e1", leaseId: "l1", eventType: "notice_deadline", eventDate: "2026-12-20", dateBasis: "contractual" }];

  it("verified notice deadline ≤90 days forces act_this_week even with a low total", () => {
    const r = scoreLead(base({ radar: radarFor({ contractualExpiry: "2027-06-30" }, noticeEv) }));
    expect(r.rawTotal).toBeLessThan(50);
    expect(r.tier).toBe("act_this_week");
    expect(r.overrides).toContain("deadline_within_90d");
    expect(r.nextDeadline).toEqual({ date: "2026-12-20", kind: "notice", days: 48 });
  });

  it("an unverified (reported) notice deadline does not override the tier", () => {
    const r = scoreLead(base({ radar: radarFor({ contractualExpiry: "2027-06-30" }, [{ ...noticeEv[0], dateBasis: "reported" }]) }));
    expect(r.overrides).not.toContain("deadline_within_90d");
    expect(r.tier).toBe("enrich_or_park");
  });

  it("disqualification and suppression zero the total and set tier suppressed", () => {
    const d = scoreLead(base({ radar: radarFor({ contractualExpiry: "2026-12-31" }), disqualified: "budget too small" }));
    expect(d.total).toBe(0);
    expect(d.rawTotal).toBeGreaterThan(0);
    expect(d.tier).toBe("suppressed");
    const s = scoreLead(base({ suppressed: "do not contact" }));
    expect(s.tier).toBe("suppressed");
    expect(s.overrides[0]).toMatch(/^suppressed/);
  });
});

describe("engagement: pixels are not engagement", () => {
  it("tracking opens score 0 and are called out", () => {
    const r = scoreLead(base({ engagements: [
      { at: "2026-10-30T10:00:00Z", kind: "tracking_open", meaningful: false, hasNextStep: false },
      { at: "2026-10-31T10:00:00Z", kind: "tracking_open", meaningful: false, hasNextStep: false },
    ] }));
    expect(r.components.engagement.points).toBe(0);
    expect(r.components.engagement.evidence.join(" ")).toMatch(/2 email open\/tracking event\(s\) ignored/);
  });

  it("reply with next step within 30 days = 15; conversation without next step = 8; older = 3", () => {
    expect(scoreLead(base({ engagements: [{ at: "2026-10-20T00:00:00Z", kind: "reply", meaningful: true, hasNextStep: true }] })).components.engagement.points).toBe(15);
    expect(scoreLead(base({ engagements: [{ at: "2026-10-20T00:00:00Z", kind: "conversation", meaningful: true, hasNextStep: false }] })).components.engagement.points).toBe(8);
    expect(scoreLead(base({ engagements: [{ at: "2026-03-01T00:00:00Z", kind: "conversation", meaningful: true, hasNextStep: false }] })).components.engagement.points).toBe(3);
  });
});

describe("trigger & relationship bands", () => {
  it("corroborated expansion = 12, single weak signal = 5, expired signal ignored", () => {
    expect(scoreLead(base({ signals: [{ claimType: "expansion", status: "reported", evidenceTier: "corroborated_public", observedOn: "2026-10-01" }] })).components.trigger.points).toBe(12);
    expect(scoreLead(base({ signals: [{ claimType: "hiring", status: "reported", evidenceTier: "single_unverified" }] })).components.trigger.points).toBe(5);
    expect(scoreLead(base({ signals: [{ claimType: "expansion", status: "reported", evidenceTier: "corroborated_public", expiresOn: "2026-10-01" }] })).components.trigger.points).toBe(0);
  });

  it("permissioned warm intro = 10; known contact without path = 5", () => {
    expect(scoreLead(base({ relationships: [{ warmth: "warm", decisionMaker: false, introPermission: true, viaIntroducer: true }] })).components.relationship.points).toBe(10);
    expect(scoreLead(base({ knownContacts: 2 })).components.relationship.points).toBe(5);
  });
});
