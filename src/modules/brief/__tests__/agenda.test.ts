/**
 * Workflow 07 Priority Adviser — acceptance: each priority has an explanation; capacity conflicts are surfaced;
 * one feasible day order across all action types; dependencies block; deterministic non-AI fallback.
 */
import { describe, expect, it } from "vitest";
import { buildAgenda, renderAgendaText, type AgendaInputs, type AgendaTask } from "../agenda";
import { BRIEF_DEFAULTS } from "../settings";

const DATE = "2031-03-03"; // Monday
const NOW = "2031-03-03T02:00:00.000Z"; // 07:30 IST — before the working window
const at = (hhmm: string) => new Date(`${DATE}T${hhmm}:00+05:30`).toISOString();
const task = (over: Partial<AgendaTask>): AgendaTask => ({ id: "t" + Math.random().toString(36).slice(2, 7), title: "Task", dueAt: null, priority: 50, status: "open", snoozedUntil: null, dependsOn: null, source: "manual", idempotencyKey: null, linkedEntityType: null, linkedEntityId: null, ...over });

function base(over: Partial<AgendaInputs> = {}): AgendaInputs {
  return {
    date: DATE, now: NOW, tz: "Asia/Kolkata", isWorkday: true, settings: BRIEF_DEFAULTS.capacity,
    meetings: [], tasks: [], deps: [], approvals: { changes: 0, drafts: 0, oldestAt: null }, replies: [], deadlines: [], targets: [], relationship: [], ...over,
  };
}

describe("Priority Adviser day order", () => {
  it("builds one feasible order across calls, promises, meetings, approvals, research, lease windows and overdue tasks — each with a rule-based reason", () => {
    const a = buildAgenda(base({
      meetings: [{ id: "m1", title: "Site visit Baner", startAt: at("11:00"), endAt: at("12:00"), kind: "site_visit", status: "confirmed", location: "Baner, Pune" }],
      tasks: [
        task({ id: "over", title: "Revise options deck for Acme", dueAt: "2031-02-28T05:00:00Z", priority: 70 }),
        task({ id: "res", title: "Find lease expiry for Beta", source: "workflow", idempotencyKey: "brief.radar:l1:missing_expiry" }),
      ],
      approvals: { changes: 2, drafts: 1, oldestAt: "2031-03-01T00:00:00Z" },
      replies: [{ id: "r1", occurredAt: "2031-03-02T12:00:00Z", subject: "Re: options", orgId: "o1", orgName: "Acme" }],
      deadlines: [{ leaseId: "l1", tenant: "Gamma", kind: "notice", date: "2031-03-06", days: 3, basisLabel: "Contractual", verified: true }],
      targets: [{ orgId: "o2", name: "Delta", effortMinutes: 15, slot: "exploit", why: "Score 70 / 15 min effort = 4.7 per minute", total: 70 }],
      relationship: [{ key: "caretaker:promise:i1:abc", kind: "promise_overdue", title: "Deliver: floor plans", why: "Promise was due 2031-03-01", due: "2031-03-01", priority: 85, createTask: false, link: { type: "interaction", id: "i1" }, orgIds: [], personIds: [], ownerUserId: null, href: "/x" }],
    }));
    const kinds = new Set(a.timeline.map((t) => t.kind));
    for (const k of ["meeting", "prep", "travel", "promise", "reply", "approval", "lease_window", "call", "task", "research"]) expect(kinds, k).toContain(k);
    // every flexible item has a rank and an explicit rule; nothing overlaps
    const flex = a.timeline.filter((t) => !t.fixed);
    expect(flex.every((t) => t.rank && /^Rule: /.test(t.why))).toBe(true);
    const spans = a.timeline.map((t) => [t.start!, t.end!]).sort();
    for (let i = 1; i < spans.length; i++) expect(spans[i][0] >= spans[i - 1][1]).toBe(true);
    // highest rules first: lease window ≤ 7 days and overdue promise before the call target
    const order = flex.map((t) => t.kind);
    expect(order.indexOf("lease_window")).toBeLessThan(order.indexOf("call"));
    expect(order.indexOf("promise")).toBeLessThan(order.indexOf("research"));
    expect(a.conflicts).toEqual([]);
    expect(renderAgendaText(a).length).toBeGreaterThan(5);
  });

  it("meetings get prep and travel buffers; a buffer that collides with an earlier meeting is a conflict", () => {
    const a = buildAgenda(base({
      meetings: [
        { id: "m1", title: "Client call", startAt: at("10:00"), endAt: at("10:50"), kind: "call", status: "confirmed", location: null },
        { id: "m2", title: "Visit Hinjewadi", startAt: at("11:00"), endAt: at("12:00"), kind: "site_visit", status: "confirmed", location: "Hinjewadi" },
      ],
    }));
    expect(a.timeline.find((t) => t.ref === "travel:m2")).toMatchObject({ start: "10:30", end: "11:00" });
    expect(a.timeline.find((t) => t.ref === "prep:m2")).toMatchObject({ start: "10:15", end: "10:30" });
    expect(a.timeline.find((t) => t.ref === "prep:m1")).toBeUndefined(); // calls need no prep/travel block
    expect(a.conflicts.some((c) => c.kind === "buffer" && /Client call/.test(c.message))).toBe(true);
  });

  it("capacity conflicts are surfaced: overlapping meetings, over-capacity work and a due-today task that cannot fit", () => {
    const tasks = Array.from({ length: 40 }, (_, i) => task({ title: `Prepare comparison ${i}`, priority: 40 }));
    tasks.push(task({ id: "today", title: "Submit LOI comments", dueAt: `${DATE}T12:30:00Z`, priority: 10 }));
    const a = buildAgenda(base({
      meetings: [
        { id: "a", title: "Board review", startAt: at("09:30"), endAt: at("13:00"), kind: "internal", status: "confirmed", location: null },
        { id: "b", title: "Landlord meeting", startAt: at("12:30"), endAt: at("18:50"), kind: "internal", status: "confirmed", location: null },
      ],
      tasks,
    }));
    expect(a.conflicts.some((c) => c.kind === "overlap")).toBe(true);
    expect(a.conflicts.some((c) => c.kind === "over_capacity")).toBe(true);
    expect(a.capacity.freeMinutes).toBe(10);
    expect(a.unscheduled.length).toBeGreaterThan(0);
    // the due-today task outranks undated work, but still does not fit 10 min → explicit deadline conflict
    expect(a.conflicts.some((c) => c.kind === "deadline_unfit" && /Submit LOI comments/.test(c.message))).toBe(true);
  });

  it("respects dependencies: a task waiting on an unfinished task is blocked with what it waits on and never scheduled", () => {
    const a = buildAgenda(base({
      tasks: [
        task({ id: "send", title: "Send final proposal", dependsOn: "fin", dueAt: `${DATE}T10:00:00Z`, priority: 90 }),
        task({ id: "fin", title: "Finance comparison", priority: 60 }),
        task({ id: "hidden", title: "Share TCO", dependsOn: "secret" }),
      ],
      deps: [{ id: "fin", title: "Finance comparison", status: "open" }],
    }));
    expect(a.blocked.map((b) => b.ref).sort()).toEqual(["task:hidden", "task:send"]);
    expect(a.blocked.find((b) => b.ref === "task:send")!.waitsOn).toBe("“Finance comparison” (open)");
    expect(a.blocked.find((b) => b.ref === "task:hidden")!.waitsOn).toMatch(/cannot see/);
    expect(a.timeline.some((t) => t.ref === "task:send")).toBe(false);
    expect(a.conflicts.some((c) => c.kind === "blocked_deadline")).toBe(true);
    // once the prerequisite is done, the task becomes doable
    const b = buildAgenda(base({ tasks: [task({ id: "send", title: "Send final proposal", dependsOn: "fin" })], deps: [{ id: "fin", title: "Finance comparison", status: "done" }] }));
    expect(b.blocked).toEqual([]);
    expect(b.timeline.some((t) => t.ref === "task:send")).toBe(true);
  });

  it("is deterministic (the non-AI fallback): same inputs give the same plan; starts from 'now' during the day", () => {
    const i = base({ tasks: [task({ id: "x", title: "Call Acme", dueAt: `${DATE}T08:00:00Z` })] });
    expect(buildAgenda(i)).toEqual(buildAgenda(i));
    const later = buildAgenda({ ...i, now: at("14:07") });
    expect(later.window.from).toBe("14:15");
    expect(later.timeline[0].start! >= "14:15").toBe(true);
    expect(later.timeline[0].kind).toBe("call");
  });

  it("non-workday: only urgent items are planned", () => {
    const a = buildAgenda(base({ isWorkday: false, tasks: [task({ title: "Tidy CRM" })], targets: [{ orgId: "o", name: "X", effortMinutes: 15, slot: "exploit", why: "w", total: 50 }] }));
    expect(a.mode).toBe("light");
    expect(a.timeline.filter((t) => !t.fixed)).toEqual([]);
    expect(a.unscheduled.some((u) => /Non-workday/.test(u.why))).toBe(true);
  });
});
