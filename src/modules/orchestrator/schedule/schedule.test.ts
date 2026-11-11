import { describe, expect, it } from "vitest";
import { memberSlots, workspaceSlots } from "./jobs";
import { prepDueAt } from "./meetings";
import { resolveOrchSettings } from "./settings";
import { buildDailySections, type DailyInputs } from "./plan-builder";

const WS = "ws-1", U = "user-1";

describe("Test 1 (pure) — daily plan at 08:00 local time", () => {
  it("defaults to 08:00 Asia/Kolkata (02:30 UTC)", () => {
    const s = resolveOrchSettings({});
    const slots = memberSlots(new Date("2032-03-10T00:10:00Z"), WS, U, s);
    const d = slots.find((x) => x.type === "orchestrator.daily_plan")!;
    expect(d.dueAt.toISOString()).toBe("2032-03-10T02:30:00.000Z");
    expect(d.dedupeKey).toBe(`orchestrator.daily_plan:${WS}:${U}:2032-03-10`);
  });
  it("uses the user's timezone and configured time", () => {
    const s = resolveOrchSettings({ userPrefs: { orchestrator: { timezone: "America/New_York", dailyPlanTime: "07:30" } } });
    const d = memberSlots(new Date("2032-03-10T15:00:00Z"), WS, U, s).find((x) => x.type === "orchestrator.daily_plan")!;
    expect(d.dueAt.toISOString()).toBe("2032-03-10T12:30:00.000Z"); // EST (UTC-5); US DST starts 14 Mar 2032
  });
  it("local date, not UTC date, drives the key (IST just after midnight)", () => {
    const s = resolveOrchSettings({});
    const d = memberSlots(new Date("2032-03-10T18:45:00Z"), WS, U, s).find((x) => x.type === "orchestrator.daily_plan")!; // 00:15 IST on 11 Mar
    expect(d.dedupeKey.endsWith(":2032-03-11")).toBe(true);
  });
  it("falls back to the workspace timezone; invalid timezones are ignored", () => {
    expect(resolveOrchSettings({ workspaceTz: "Europe/London", userPrefs: { timezone: "Mars/Base" } }).timezone).toBe("Europe/London");
  });
  it("weekly review only on the configured weekday (default Friday 18:00 IST), keyed by ISO week", () => {
    const s = resolveOrchSettings({});
    expect(memberSlots(new Date("2032-03-10T05:00:00Z"), WS, U, s).some((x) => x.type === "orchestrator.weekly_review")).toBe(false); // Wed
    const w = memberSlots(new Date("2032-03-12T05:00:00Z"), WS, U, s).find((x) => x.type === "orchestrator.weekly_review")!; // Fri
    expect(w.dueAt.toISOString()).toBe("2032-03-12T12:30:00.000Z");
    expect(w.dedupeKey).toBe(`orchestrator.weekly_review:${WS}:${U}:2032-W11`);
    const custom = resolveOrchSettings({ orchSetting: { weeklyReview: { weekday: 1, time: "09:00" } } });
    expect(memberSlots(new Date("2032-03-08T05:00:00Z"), WS, U, custom).some((x) => x.type === "orchestrator.weekly_review")).toBe(true); // Mon
  });
  it("workspace sweeps are bucketed (15 min / hourly)", () => {
    const k = workspaceSlots(new Date("2032-03-10T05:37:00Z"), WS).map((x) => x.dedupeKey);
    expect(k).toEqual([`orchestrator.sweep:${WS}:2032-03-10T05:30`, `orchestrator.hourly:${WS}:2032-03-10T05`]);
  });
});

describe("meeting prep timing", () => {
  it("about one hour before; immediately if already inside the window; never after start", () => {
    const now = new Date("2032-03-12T03:00:00Z");
    expect(prepDueAt("2032-03-12T06:00:00Z", 60, now)!.toISOString()).toBe("2032-03-12T05:00:00.000Z");
    expect(prepDueAt("2032-03-12T03:30:00Z", 60, now)!.toISOString()).toBe(now.toISOString());
    expect(prepDueAt("2032-03-12T02:00:00Z", 60, now)).toBeNull();
  });
});

describe("daily plan sections (deterministic fallback)", () => {
  const base: DailyInputs = {
    date: "2032-03-10", now: "2032-03-10T02:30:00Z",
    meetingsToday: { state: "ok", note: null, items: [{ id: "m1", title: "Acme visit", startAt: "2032-03-10T06:00:00Z", endAt: "2032-03-10T07:00:00Z", kind: "site_visit", status: "confirmed", location: "Baner", prep: null }] },
    meetingsSoon: [{ id: "m1", title: "Acme visit", startAt: "2032-03-10T06:00:00Z", endAt: "2032-03-10T07:00:00Z", kind: "site_visit", status: "confirmed", location: "Baner", prep: null }],
    brief: null, briefError: "Daily brief unavailable: x",
    signals: { state: "unavailable", items: [], note: "Could not load: boom" },
    tasks: { state: "ok", note: null, items: [{ id: "t1", title: "Send floor plans", dueAt: "2032-03-10T10:00:00Z", priority: 60, status: "open", linkedEntityType: null, linkedEntityId: null, source: "manual" }] },
    commitments: { state: "ok", note: null, items: [{ id: "c1", title: "Deliver: rent comparison", due: "2032-03-05", href: "/x", kind: "promise" }] },
    deals: { state: "ok", note: null, items: [] },
    approvals: { changes: 2, drafts: 1, oldestAt: null },
  };
  it("has all ten sections; failed sources are labelled, not empty", () => {
    const s = buildDailySections(base);
    expect(Object.keys(s)).toEqual(["todays_meetings", "meetings_needing_prep", "priority_accounts", "new_signals", "lease_alerts", "followups_due_today", "overdue_commitments", "deals_attention", "pending_approvals", "recommended_actions"]);
    expect(s.new_signals.state).toBe("unavailable");
    expect(s.priority_accounts.state).toBe("unavailable");
    expect(s.meetings_needing_prep.items[0].missing[0]).toMatch(/No preparation record/);
    expect(s.followups_due_today.items.map((t: any) => t.id)).toEqual(["t1"]);
    const recs = s.recommended_actions.items.map((r) => r.ref);
    expect(recs[0]).toBe("commitment:c1"); // commitments first
    expect(recs).toContain("approvals");
  });
});
