import { describe, expect, it } from "vitest";
import { classifyTask, planCapacity, type CapacityInput } from "./capacity";

const D = "2032-03-10"; // IST working day 09:30–19:00 = 04:00Z–13:30Z
const m = (id: string, s: string, e: string, extra: Partial<CapacityInput["meetings"][0]> = {}) => ({ id, title: id, startAt: `${D}T${s}:00Z`, endAt: `${D}T${e}:00Z`, kind: "meeting", status: "confirmed", location: null, ...extra });
const base = (o: Partial<CapacityInput> = {}): CapacityInput => ({
  date: D, tz: "Asia/Kolkata", now: `${D}T03:00:00Z`, workingHours: { start: "09:30", end: "19:00" },
  limits: { maxMeetings: 5, maxOverdueCommitments: 3, maxUrgentProposals: 2, prepMinutes: 30, defaultTaskMinutes: 30 },
  meetings: [], tasks: [], overdueCommitments: [], urgentProposals: [], routingAvailable: false, nextWorkday: "2032-03-11", ...o,
});

describe("priority classes (§8.1)", () => {
  const now = `${D}T03:00:00Z`;
  const t = (x: Partial<Parameters<typeof classifyTask>[0]>) => classifyTask({ id: "t", title: "x", dueAt: null, priority: 50, source: "manual", linkedEntityType: null, ...x }, now).cls;
  it("classifies deterministically", () => {
    expect(t({ linkedEntityType: "interaction" })).toBe("critical_client_commitment");
    expect(t({ linkedEntityType: "opportunity", dueAt: `${D}T10:00:00Z` })).toBe("time_sensitive_transaction");
    expect(t({ title: "Prepare for Acme", linkedEntityType: "meeting_prep" })).toBe("meeting_preparation");
    expect(t({ title: "Send proposal to Acme" })).toBe("commercial_proposal_deadline");
    expect(t({ title: "Follow up with Ravi" })).toBe("important_follow_up");
    expect(t({ title: "Research Hinjewadi occupiers" })).toBe("routine_account_research");
    expect(t({ title: "Refresh contacts", source: "connector" })).toBe("background_data_refresh");
    expect(t({ title: "tidy", priority: 10 })).toBe("non_urgent_maintenance");
    expect(t({ priorityClass: "meeting_preparation" })).toBe("meeting_preparation");
  });
});

describe("capacity warnings (§8.4)", () => {
  it("too many meetings + suggests moving internal ones", () => {
    const meetings = ["04", "05", "06", "07", "08", "09"].map((h, i) => m(`m${i}`, `${h}:00`, `${h}:45`, { kind: i === 5 ? "internal" : "meeting" }));
    const r = planCapacity(base({ meetings }));
    expect(r.warnings.map((w) => w.kind)).toContain("too_many_meetings");
    expect(r.suggestions.find((s) => s.kind === "decline_or_move_meeting")?.ref).toBe("m5");
  });
  it("several overdue commitments and multiple urgent proposals", () => {
    const r = planCapacity(base({ overdueCommitments: [{ id: "a", title: "a" }, { id: "b", title: "b" }, { id: "c", title: "c" }], urgentProposals: [{ id: "p1", title: "p1", due: D }, { id: "p2", title: "p2", due: D }] }));
    expect(r.warnings.map((w) => w.kind)).toEqual(expect.arrayContaining(["overdue_commitments", "urgent_proposals"]));
  });
  it("insufficient preparation time before a meeting", () => {
    const r = planCapacity(base({ meetings: [m("busy", "04:00", "05:50"), m("client", "06:00", "07:00", { needsPrep: true, prepReady: false })] }));
    expect(r.warnings.find((w) => w.kind === "insufficient_prep")?.refs).toEqual(["client"]);
  });
  it("finds a prep slot when there is room; ready briefs need none", () => {
    const r = planCapacity(base({ meetings: [m("client", "08:00", "09:00", { needsPrep: true })] }));
    expect(r.suggestions.find((s) => s.kind === "prep_slot")?.proposedStart).toBe(`${D}T07:30:00.000Z`);
    expect(planCapacity(base({ meetings: [m("client", "08:00", "09:00", { needsPrep: true, prepReady: true })] })).suggestions).toHaveLength(0);
  });
  it("overlapping appointments are conflicts", () => {
    const r = planCapacity(base({ meetings: [m("a", "05:00", "06:00"), m("b", "05:30", "06:30")] }));
    expect(r.conflicts[0].refs).toEqual(["a", "b"]);
  });
  it("travel time is never invented: unknown without routing, warning when the gap is tiny", () => {
    const r = planCapacity(base({ meetings: [m("a", "05:00", "06:00", { location: "Baner" }), m("b", "06:10", "07:00", { location: "Kharadi" })] }));
    expect(r.travel[0]).toMatchObject({ status: "unknown", gapMinutes: 10 });
    expect(r.travel[0].message).toMatch(/Travel time unknown/);
    expect(r.warnings.map((w) => w.kind)).toContain("travel_conflict");
  });
  it("over capacity → realistic rescheduling of the lowest classes, no new tasks; overrides are fixed blocks", () => {
    const tasks = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, title: i === 0 ? "Deliver: comparison" : `Research org ${i}`, dueAt: null, priority: 50, source: "manual", linkedEntityType: i === 0 ? "interaction" : null, estimatedMinutes: 30 }));
    tasks.push({ id: "fixed", title: "Call landlord", dueAt: null, priority: 50, source: "manual", linkedEntityType: null, estimatedMinutes: 30, ...{ userOverride: true, scheduledStart: `${D}T04:00:00Z`, scheduledEnd: `${D}T04:30:00Z` } } as any);
    const r = planCapacity(base({ tasks }));
    expect(r.placed.find((p) => p.taskId === "fixed")).toMatchObject({ overridden: true, start: `${D}T04:00:00Z` });
    expect(r.placed.find((p) => p.taskId === "t0")).toBeTruthy(); // commitment placed first
    expect(r.unplaced.length).toBeGreaterThan(0);
    expect(r.warnings.map((w) => w.kind)).toContain("over_capacity");
    expect(r.suggestions.filter((s) => s.kind === "reschedule").every((s) => s.proposedDate === "2032-03-11")).toBe(true);
    expect(r.placed.length + r.unplaced.length).toBe(tasks.length);
  });
});
