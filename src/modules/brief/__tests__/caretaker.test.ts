/**
 * Workflow 18 Relationship Caretaker — acceptance: promises are not silently marked complete; follow-ups link to the
 * relevant interaction; opt-outs suppress suggestions; post-visit concerns, renewals and referrals are suggested.
 */
import { describe, expect, it } from "vitest";
import { applyRestrictions, isRestrictive, parsePromises, promiseSuggestions, referralSuggestions, renewalSuggestions, visitSuggestions, type InteractionCtx } from "../caretaker";
import { analyseLease } from "../lease-radar";

const TODAY = "2031-03-10";
const I = (promises: unknown, over: Partial<InteractionCtx> = {}): InteractionCtx => ({
  id: "i1", occurredAt: "2031-03-01T10:00:00Z", subject: "Call with Acme", channel: "call", promises, ownerUserId: "u1", personIds: ["p1"], orgIds: ["o1"], orgName: "Acme", ...over,
});

describe("Relationship Caretaker", () => {
  it("parses {who, what, due, status}; stable keys; unknown due stays unknown", () => {
    const ps = parsePromises([
      { who: "me", what: "Send floor plans", due: "2031-03-05", status: "open" },
      { who: "Ravi (client)", what: "Share headcount plan", due: "2031-03-12" },
      { who: "me", what: "Book visit", due: "soon" },
      { what: "Old item", due: "2031-01-01", status: "Done" },
      "Call back next week",
      null,
    ]);
    expect(ps.map((p) => [p.party, p.status, p.due])).toEqual([["us", "open", "2031-03-05"], ["them", "open", "2031-03-12"], ["us", "open", null], ["unknown", "done", "2031-01-01"], ["unknown", "open", null]]);
    // reordering the array keeps the same keys (no duplicate alerts)
    const re = parsePromises([{ who: "Ravi (client)", what: "Share headcount plan", due: "2031-03-12" }, { who: "me", what: "Send floor plans", due: "2031-03-05", status: "open" }]);
    expect(re[1].key).toBe(ps[0].key);
  });

  it("overdue promise → alert + follow-up task linked to the interaction; done/undated promises raise nothing", () => {
    const s = promiseSuggestions([I([
      { who: "me", what: "Send floor plans", due: "2031-03-05", status: "open" },
      { who: "Ravi", what: "Share headcount plan", due: "2031-03-11" },
      { who: "me", what: "Book visit" },
      { who: "me", what: "Send NDA", due: "2031-03-01", status: "completed" },
    ])], TODAY);
    expect(s).toHaveLength(2);
    const over = s.find((x) => x.kind === "promise_overdue")!;
    expect(over).toMatchObject({ title: "Deliver: Send floor plans", createTask: true, link: { type: "interaction", id: "i1" }, due: "2031-03-05" });
    expect(over.why).toMatch(/5 days overdue.*stays open until you record it as kept/);
    expect(s.find((x) => x.kind === "promise_due")).toMatchObject({ title: "Chase Ravi: Share headcount plan", createTask: false });
  });

  it("post-visit concerns become follow-ups; a high rating prompts a referral; won deals and open renewal windows prompt too", () => {
    const v = visitSuggestions([{ id: "f1", meetingVisitId: "m1", meetingTitle: "Visit Tower B", visitDate: "2031-03-08", concerns: "Parking ratio too low", dealbreakers: null, nextStep: "Send parking options", followUpDue: null, rating: 4, ownerUserId: "u1", orgIds: ["o1"], personIds: [] }], TODAY);
    expect(v.find((x) => x.kind === "visit_concern")).toMatchObject({ due: "2031-03-10", createTask: true, link: { type: "meeting_visit", id: "m1" } });
    expect(v.find((x) => x.kind === "visit_concern")!.why).toMatch(/Parking ratio too low/);
    expect(v.some((x) => x.kind === "referral")).toBe(true);
    const r = referralSuggestions([
      { id: "d1", name: "Acme HQ", orgId: "o1", orgName: "Acme", outcome: "won", stage: "signed", stageEnteredAt: "2031-02-20T00:00:00Z", ownerUserId: "u1" },
      { id: "d2", name: "Old deal", orgId: "o2", orgName: "Beta", outcome: "won", stage: "collected", stageEnteredAt: "2030-01-01T00:00:00Z", ownerUserId: "u1" },
      { id: "d3", name: "Open deal", orgId: "o3", orgName: "Gamma", outcome: "open", stage: "loi", stageEnteredAt: "2031-03-01T00:00:00Z", ownerUserId: "u1" },
    ], TODAY);
    expect(r.map((x) => x.link.id)).toEqual(["d1"]);
    const lease = analyseLease({ id: "l1", tenantOrgId: "o9", tenantName: "Zeta", assetName: "T1", areaSf: 20000, contractualExpiry: "2031-12-31" }, [], TODAY);
    const rn = renewalSuggestions([lease]);
    expect(rn).toHaveLength(lease.callWindow && (lease.callWindow.state === "open" || lease.callWindow.state === "closing") ? 1 : 0);
  });

  it("opt-outs suppress suggestions (suppressed person or company contact restriction)", () => {
    const s = [
      ...promiseSuggestions([I([{ who: "me", what: "Send plans", due: "2031-03-01" }], { id: "a", personIds: ["pSupp"], orgIds: ["oOk"] })], TODAY),
      ...promiseSuggestions([I([{ who: "me", what: "Send plans", due: "2031-03-01" }], { id: "b", personIds: ["pOk"], orgIds: ["oDnc"] })], TODAY),
      ...promiseSuggestions([I([{ who: "me", what: "Send plans", due: "2031-03-01" }], { id: "c", personIds: ["pOk"], orgIds: ["oOk"] })], TODAY),
    ];
    const r = applyRestrictions(s, { persons: new Set(["pSupp"]), orgs: new Set(["oDnc"]) });
    expect(r.kept.map((x) => x.link.id)).toEqual(["c"]);
    expect(r.withheld.map((w) => w.reason)).toEqual(["contact opted out / suppressed", "company contact restriction"]);
    expect(isRestrictive("Do not contact — legal")).toBe(true);
    expect(isRestrictive("Opted out of marketing 2030")).toBe(true);
    expect(isRestrictive("Prefers WhatsApp after 6pm")).toBe(false);
  });
});
