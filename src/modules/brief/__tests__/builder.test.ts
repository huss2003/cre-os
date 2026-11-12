import { describe, expect, it } from "vitest";
import { buildBrief, effectiveTaskState, pickIntel, pipelineSnapshot, type BriefInputs, type TargetView } from "../builder";
import { analyseLease } from "../lease-radar";
import { computeCapacity, selectTargets, type Candidate } from "../priority";
import { BRIEF_DEFAULTS } from "../settings";
import { computeSourceHealth } from "../source-health";
import { codeSynthesis, mockSynthesis, synthesise, type StructuredCaller } from "../synthesis";

const NOW = "2026-11-02T02:10:00.000Z"; // 07:40 IST Monday
const DATE = "2026-11-02";
const ok = computeSourceHealth(
  [{ id: "a1", provider: "microsoft", status: "connected" }],
  ["inbox", "calendar", "sent"].map((r) => ({ connector_account_id: "a1", resource: r, last_success_at: "2026-11-02T01:50:00.000Z", last_attempt_at: "2026-11-02T01:50:00.000Z", last_error: null })),
  new Date(NOW), BRIEF_DEFAULTS,
);

function inputs(over: Partial<BriefInputs> = {}): BriefInputs {
  return {
    kind: "daily", date: DATE, tz: "Asia/Kolkata", now: NOW, mode: "workday", sources: ok, targets: [], displaced: [], capacity: null, planGeneratedAt: null,
    tasks: [], meetings: [], radar: [], replies: [], approvals: { changes: 0, drafts: 0, oldestAt: null }, intel: [],
    pipeline: pipelineSnapshot([], [], DATE), approachesThisMonth: 0, cohortTarget: { minimum: 120, pace: 170 }, workdays: [1, 2, 3, 4, 5], staleTaskAfterDays: 14,
    ...over,
  };
}
const reply = { id: "r1", occurredAt: "2026-11-01T12:00:00Z", subject: "Re: Baner options", summary: "Can we see two sites Thursday?", orgId: "o1", orgName: "Acme" };

describe("source health (deterministic)", () => {
  it("ok / stale / failed / not_connected with last success kept", () => {
    const accounts = [{ id: "a1", provider: "google", status: "connected" }];
    const s = computeSourceHealth(accounts, [
      { connector_account_id: "a1", resource: "inbox", last_success_at: "2026-11-01T20:00:00Z", last_attempt_at: "2026-11-02T02:00:00Z", last_error: "401 invalid_grant" },
      { connector_account_id: "a1", resource: "calendar", last_success_at: "2026-11-01T10:00:00Z", last_attempt_at: "2026-11-01T10:00:00Z", last_error: null },
    ], new Date(NOW), BRIEF_DEFAULTS);
    expect(s.find((x) => x.key === "inbox")).toMatchObject({ state: "failed", lastSuccessAt: "2026-11-01T20:00:00Z", error: "401 invalid_grant" });
    expect(s.find((x) => x.key === "calendar")!.state).toBe("stale");
    expect(s.find((x) => x.key === "sent")!.state).toBe("failed"); // connected, never synced
    expect(computeSourceHealth([], [], new Date(NOW), BRIEF_DEFAULTS).every((x) => x.state === "not_connected")).toBe(true);
    expect(computeSourceHealth([{ id: "a1", provider: "google", status: "revoked" }], [], new Date(NOW), BRIEF_DEFAULTS)[0].state).toBe("failed");
  });
});

describe("stale labelling (S10) — never 'no replies' when the inbox failed", () => {
  it("healthy inbox: replies shown; empty healthy inbox says 'no new replies'", () => {
    const b = buildBrief(inputs({ replies: [reply] }));
    expect(b.replies.state).toBe("ok");
    expect(b.replies.items).toHaveLength(1);
    expect(b.actions.some((a) => a.kind === "reply")).toBe(true);
    expect(buildBrief(inputs()).fallbackText).toMatch(/No new meaningful replies/);
  });

  it("failed inbox: section unavailable since last success, no reply actions, fallback text never claims no replies", () => {
    const failed = ok.map((s) => s.key === "inbox" ? { ...s, state: "failed" as const, error: "token revoked", note: "Inbox unavailable since 2026-11-01T20:00:00Z", lastSuccessAt: "2026-11-01T20:00:00Z" } : s);
    const b = buildBrief(inputs({ sources: failed, replies: [] }));
    expect(b.replies.state).toBe("unavailable");
    expect(b.replies.note).toBe("Hot replies unavailable since 2026-11-01T20:00:00Z — inbox access failed (token revoked)");
    expect(b.staleSections).toContain("replies");
    expect(b.fallbackText).not.toMatch(/No new meaningful replies/);
    expect(b.fallbackText).toMatch(/Hot replies unavailable since/);
    expect(buildBrief(inputs({ sources: failed, replies: [reply] })).actions.some((a) => a.kind === "reply")).toBe(false);
  });

  it("stale calendar labels meetings; not-connected inbox says replies were not checked", () => {
    const stale = ok.map((s) => s.key === "calendar" ? { ...s, state: "stale" as const, note: "Calendar stale — last successful sync X" } : s.key === "inbox" ? { ...s, state: "not_connected" as const } : s);
    const b = buildBrief(inputs({ sources: stale }));
    expect(b.meetings.state).toBe("stale");
    expect(b.meetings.note).toMatch(/Meetings may be incomplete/);
    expect(b.replies.note).toMatch(/not checked/);
    expect(b.fallbackText).toMatch(/None recorded \(calendar not verified\)/);
  });
});

describe("brief sections", () => {
  const radar = [
    analyseLease({ id: "l1", tenantOrgId: "o1", tenantName: "Acme", assetName: "Tower A", areaSf: 20000 }, [{ id: "e", leaseId: "l1", eventType: "notice_deadline", eventDate: "2026-11-20", dateBasis: "contractual" }, { id: "x", leaseId: "l1", eventType: "expiry", eventDate: "2027-05-31", dateBasis: "contractual" }], DATE),
    analyseLease({ id: "l2", tenantOrgId: "o2", tenantName: "Beta" }, [], DATE),
    analyseLease({ id: "l3", tenantOrgId: "o3", tenantName: "Gamma", contractualExpiry: "2026-09-30" }, [], DATE),
  ];
  const overdue = { id: "t1", title: "Send proposal to Acme", dueAt: "2026-10-30T12:30:00Z", priority: 80, status: "open", snoozedUntil: null, linkedEntityType: null, linkedEntityId: null, source: "capture" };

  it("three actions max, notice deadline first, then overdue promise, approvals", () => {
    const b = buildBrief(inputs({ radar, tasks: [overdue], approvals: { changes: 2, drafts: 1, oldestAt: null } }));
    expect(b.actions).toHaveLength(3);
    expect(b.actions[0]).toMatchObject({ kind: "notice", title: "Notice deadline 2026-11-20 — Acme (Tower A)" });
    expect(b.actions[1].kind).toBe("overdue");
    expect(b.actions[2].kind).toBe("approvals");
    expect(b.deadlines.items[0]).toMatchObject({ kind: "notice", days: 18, verified: true });
    expect(b.deadlines.expiredNeedingConfirmation).toBe(1);
  });

  it("approaches vs 120/170 cohort with remaining workdays", () => {
    const b = buildBrief(inputs({ approachesThisMonth: 20 }));
    // 2–30 Nov 2026 has 21 workdays
    expect(b.approaches).toMatchObject({ thisMonth: 20, remainingMinimum: 100, remainingPace: 150, workdaysLeft: 21, perDayMinimum: 5, perDayPace: 8 });
  });

  it("meetings clustered by locality with overlap conflicts", () => {
    const m = (id: string, start: string, end: string, location: string | null) => ({ id, title: id, startAt: start, endAt: end, kind: "site_visit", status: "confirmed", location, routeGroup: null });
    const b = buildBrief(inputs({ meetings: [m("a", "2026-11-02T05:00:00Z", "2026-11-02T06:00:00Z", "Baner, Pune"), m("b", "2026-11-02T05:30:00Z", "2026-11-02T06:30:00Z", "Kharadi"), m("c", "2026-11-02T08:00:00Z", "2026-11-02T09:00:00Z", "baner road")] }));
    expect(b.meetings.clusters.map((c) => c.label)).toEqual(["Baner", "Kharadi", "Baner Road"]);
    expect(b.meetings.conflicts).toHaveLength(1);
  });

  it("light mode (non-workday) drops client-contact targets and actions", () => {
    const t = { orgId: "o9", name: "Zeta", rank: 1, slot: "exploit", effortMinutes: 15, ratio: 4, total: 60, tier: "validate_nurture", why: "x", displaced: null, components: [], overrides: [], evidenceConfidence: "none", warmth: "cold", enrichment: [] } as TargetView;
    const b = buildBrief(inputs({ mode: "light", targets: [t], replies: [reply] }));
    expect(b.targets).toHaveLength(0);
    expect(b.actions.some((a) => a.kind === "target" || a.kind === "reply")).toBe(false);
    expect(b.modeNote).toMatch(/light review/);
  });

  it("intel item must carry a source; prefers today's targets", () => {
    const i = (id: string, orgId: string, date: string, sourceUrl: string) => ({ id, orgId, orgName: id, claimType: "expansion", excerpt: null, sourceUrl, date, status: "reported", evidenceTier: "credible_reported" });
    expect(pickIntel([i("a", "o1", "2026-10-01", "")], [])).toBeNull();
    expect(pickIntel([i("a", "o1", "2026-10-30", "https://x"), i("b", "o2", "2026-10-01", "https://y")], [{ orgId: "o2" }])!.id).toBe("b");
  });

  it("pipeline uses decimal maths and Indian FY; unknown credit share excluded", () => {
    const p = pipelineSnapshot([
      { stage: "loi", outcome: "open", expected_fee: "1000000.10", credit_share: "0.5", expected_close: "2026-12-15", next_action: null, next_action_due: null },
      { stage: "engaged", outcome: "open", expected_fee: 500000, credit_share: null, expected_close: null, next_action: "call", next_action_due: null },
      { stage: "signed", outcome: "won", expected_fee: 9e6, credit_share: 1, expected_close: null, next_action: null, next_action_due: null },
    ], [{ invoiced_amount: "250000", invoiced_on: "2026-04-01", collected_amount: "100000", collected_on: "2026-03-31" }], DATE);
    expect(p).toMatchObject({ open: 2, expectedFee: "500000", closingThisQuarter: 1, missingNextAction: 1, feesInvoicedFy: "250000", feesCollectedFy: "0" });
  });
});

describe("task states are distinct", () => {
  const t = (over: object) => ({ status: "open", dueAt: null, snoozedUntil: null, updatedAt: null, ...over });
  it.each([
    [{ status: "done" }, "done"],
    [{ status: "snoozed", snoozedUntil: "2026-11-05T00:00:00Z" }, "snoozed"],
    [{ status: "snoozed", snoozedUntil: "2026-11-01T00:00:00Z", dueAt: "2026-10-31T00:00:00Z" }, "overdue"],
    [{ status: "open", dueAt: "2026-10-31T00:00:00Z" }, "overdue"],
    [{ status: "open", dueAt: "2026-10-01T00:00:00Z" }, "stale"],
    [{ status: "stale" }, "stale"],
    [{ status: "open", dueAt: "2026-11-09T00:00:00Z" }, "open"],
  ])("%o -> %s", (over, state) => {
    expect(effectiveTaskState(t(over) as never, NOW, 14)).toBe(state);
  });
});

describe("AI synthesis fallback (Spend cap / model outage acceptance)", () => {
  const content = buildBrief(inputs({ replies: [reply] }));

  it("mock caller => ok, deterministic headline", async () => {
    const caller: StructuredCaller = async (c) => ({ data: c.mock(), mocked: true, model: "mock:x" });
    const r = await synthesise(content, "ws", caller, "on");
    expect(r).toMatchObject({ status: "ok", mocked: true, source: "ai" });
    expect(r.synthesis).toEqual(mockSynthesis(content));
  });

  it.each([["budget_exceeded", /monthly AI budget reached/], ["paused", /kill switch/], ["provider_error", /AI provider error/]])("%s => fallback_no_ai with notice; deterministic text intact", async (reason, re) => {
    const caller: StructuredCaller = async () => { throw Object.assign(new Error(reason), { reason }); };
    const r = await synthesise(content, "ws", caller, "on");
    expect(r.status).toBe("fallback_no_ai");
    expect(r.notice).toMatch(re);
    expect(content.fallbackText).toMatch(/Top actions:/);
  });

  it("untrusted reply text goes to evidence, not instructions; numbers only from computed facts", async () => {
    let seen: { input: string; evidence?: string } | null = null;
    await synthesise(content, "ws", async (c) => { seen = c; return { data: c.mock(), mocked: true, model: "m" }; }, "on");
    expect(seen!.evidence).toMatch(/Can we see two sites Thursday/);
    expect(seen!.input).not.toMatch(/Can we see two sites/);
    expect(seen!.input).toMatch(/never compute new ones/);
  });
});

describe("brief.synthesis code path (AI policy off — default)", () => {
  it("writes a readable headline from counts and top items without calling AI", async () => {
    const content = buildBrief(inputs({ replies: [reply] }));
    let called = false;
    const r = await synthesise(content, "ws", async (c) => { called = true; return { data: c.mock(), mocked: true, model: "m" }; });
    expect(called).toBe(false);
    expect(r).toMatchObject({ status: "ok", source: "code", model: null, mocked: false, notice: null });
    expect(r.synthesis!.headline).toMatch(/^[A-Z].*\.$/);
    expect(r.synthesis!.headline).not.toMatch(/undefined|null|\{|\}/);
    if (content.actions[0]) expect(r.synthesis!.headline).toContain(content.actions[0].title);
    expect(r.synthesis!.focus.length).toBeLessThanOrEqual(3);
  });
  it("empty day => calm default line", () => {
    const content = buildBrief(inputs({}));
    const s = codeSynthesis({ ...content, actions: [], overdue: { ...content.overdue, items: [] }, deadlines: { ...content.deadlines, items: [] }, meetings: { ...content.meetings, clusters: [] }, staleSections: [] });
    expect(s.headline).toMatch(/nothing urgent|No urgent items/);
  });
});

describe("priority adviser + capacity controller", () => {
  const cand = (id: string, total: number, o: Partial<Candidate> = {}): Candidate => ({
    orgId: id, name: id, tier: total >= 75 ? "act_this_week" : total >= 50 ? "validate_nurture" : "enrich_or_park", hasContactPath: true, approachedBefore: true,
    score: { total, tier: "validate_nurture", overrides: [], nextDeadline: null, flags: { deadlineWithin90: false, statusNeedsConfirmation: false, needsEnrichment: false, unverifiedDates: false }, evidenceConfidence: "none", warmth: "cold" }, ...o,
  });

  it("full calendar reduces call time and pauses research/drafts", () => {
    const meetings = [{ id: "m", title: "x", startAt: "2026-11-02T04:00:00Z", endAt: "2026-11-02T11:00:00Z", kind: "meeting" as const, status: "confirmed", location: "Baner" }];
    const c = computeCapacity({ meetings, isWorkday: true, approvalsPending: 20 });
    expect(c.freeMinutes).toBe(120);
    expect(c.callMinutesAvailable).toBe(60);
    expect(c.maxTargets).toBe(4);
    expect(c.researchDraftLevel).toBe("paused");
    expect(computeCapacity({ meetings: [], isWorkday: false, approvalsPending: 0 })).toMatchObject({ mode: "light", maxTargets: 0 });
  });

  it("deadline override first, 10–20% exploration slot for a never-approached prospect, every pick says what it displaced", () => {
    const pool = [
      ...Array.from({ length: 14 }, (_, i) => cand(`c${String(i).padStart(2, "0")}`, 90 - i)),
      cand("new1", 40, { approachedBefore: false }),
      cand("dl", 30, { score: { ...cand("x", 30).score, overrides: ["deadline_within_90d"], nextDeadline: { date: "2026-11-20", kind: "notice", days: 18 } } }),
      cand("sup", 99, { tier: "suppressed" }),
    ];
    const cap = computeCapacity({ meetings: [], isWorkday: true, approvalsPending: 0 });
    const s = selectTargets(pool, cap);
    expect(s.targets).toHaveLength(cap.maxTargets);
    expect(s.targets[0]).toMatchObject({ orgId: "dl", slot: "deadline" });
    expect(s.targets.filter((t) => t.slot === "exploration").map((t) => t.orgId)).toEqual(["new1"]);
    expect(s.explorationSlots / cap.maxTargets).toBeGreaterThanOrEqual(0.1);
    expect(s.explorationSlots / cap.maxTargets).toBeLessThanOrEqual(0.2);
    expect(s.targets.some((t) => t.orgId === "sup")).toBe(false);
    expect(s.targets.every((t) => /displaced|kept ahead of|no competing/.test(t.why))).toBe(true);
    expect(s.displaced[0].reason).toBe("Below today's cut line");
    expect(s.minutesUsed).toBeLessThanOrEqual(cap.callMinutesAvailable);
  });

  it("snoozed targets are skipped", () => {
    const s = selectTargets([cand("a", 80), cand("b", 70)], computeCapacity({ meetings: [], isWorkday: true, approvalsPending: 0 }), { snoozed: new Set(["a"]) });
    expect(s.targets.map((t) => t.orgId)).toEqual(["b"]);
  });
});
