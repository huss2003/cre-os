import { describe, expect, it } from "vitest";
import { buildPlannerView, countLabel, plural } from "./planner";

const ok = (items: any[]) => ({ state: "ok" as const, items, note: null });
const base = {
  date: "2026-11-11", tz: "Asia/Kolkata", generatedAt: null, headline: null, fmtTime: (iso: string) => iso.slice(11, 16),
  tasks: { items: [], capped: false }, approvals: { changes: 0, drafts: 0 }, capacity: null,
};
const sections = {
  todays_meetings: ok([
    { id: "b", title: "Later", start: "2026-11-11T10:00:00Z", end: "2026-11-11T11:00:00Z", location: null, prep: "Brief ready", href: "/meetings/2" },
    { id: "a", title: "Early", start: "2026-11-11T04:00:00Z", end: "2026-11-11T05:00:00Z", location: "Baner", prep: "No current brief", href: "/meetings/1" },
  ]),
  meetings_needing_prep: ok([]), priority_accounts: ok([]), new_signals: ok([{ id: "s1", title: "Expansion", confidence: "high", verification: "reported", href: "/signals/s1" }]),
  lease_alerts: ok([]), followups_due_today: ok([]), overdue_commitments: ok([{ id: "c1", title: "Send comps", due: "2026-11-09", href: "/tasks" }]),
  deals_attention: ok([]), pending_approvals: ok([]), recommended_actions: ok([{ title: "Send comps", why: "Overdue", href: "/tasks", ref: "commitment:c1" }]),
};

describe("planner view model", () => {
  it("pluralises correctly", () => {
    expect(plural(1, "meeting")).toBe("1 meeting");
    expect(plural(0, "meeting")).toBe("0 meetings");
    expect(plural(2, "follow-up")).toBe("2 follow-ups");
    expect(countLabel(100, true)).toBe("100+");
    expect(countLabel(100)).toBe("100");
  });

  it("builds a summary with real counts and time-ordered schedule", () => {
    const v = buildPlannerView({ ...base, source: "plan", sections, signalTotal: 20,
      tasks: { items: [{ id: "t1", title: "Call Ravi", due_at: "2026-11-11T06:00:00Z", row_version: 3 }, { id: "t2", title: "Old", due_at: "2026-11-08T06:00:00Z", row_version: 1 }], capped: false },
      approvals: { changes: 137, drafts: 1 } });
    expect(v.summary).toBe("2 meetings · 1 follow-up due · 20 new signals · 0 lease alerts · 138 approvals");
    expect(v.schedule.items.map((i) => i.title)).toEqual(["Early", "Later"]);
    expect(v.tasks.items.find((t) => t.id === "t2")!.overdue).toBe(true);
    expect(v.tasks.items[0].version).toBe(3);
    const ap = v.sections.find((s) => s.key === "approvals")!;
    expect(ap.countText).toBe("138");
    expect(ap.items[0].title).toBe("137 record changes and 1 draft to review");
    expect(v.sections.map((s) => s.key)).toEqual(["overdue", "prep", "accounts", "signals", "leases", "deals", "approvals", "next"]);
  });

  it("uses singular for one meeting and marks capped lists with +", () => {
    const one = { ...sections, todays_meetings: ok([sections.todays_meetings.items[0]]), new_signals: ok(Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, confidence: "high", verification: "x", href: "/signals" }))) };
    const v = buildPlannerView({ ...base, source: "live", sections: one, signalTotal: null, signalCap: 10, tasks: { items: [], capped: true } });
    expect(v.summary).toMatch(/^1 meeting · 0 follow-ups due · 10\+ new signals/);
    expect(v.tasks.countText).toBe("0+");
  });

  it("falls back cleanly: unavailable sections are labelled, missing data shows empty states", () => {
    const v = buildPlannerView({ ...base, source: "live", sections: { ...sections, lease_alerts: { state: "unavailable", items: [], note: "Daily brief not available" } }, tasks: null, approvals: null });
    expect(v.source).toBe("live");
    expect(v.sections.find((s) => s.key === "leases")!.unavailable).toBe("Daily brief not available");
    expect(v.sections.find((s) => s.key === "approvals")!.unavailable).toMatch(/could not/);
    expect(v.tasks.unavailable).toMatch(/could not/);
    expect(v.summary).not.toMatch(/approval|lease alert|follow-up/);
    const empty = buildPlannerView({ ...base, source: "live", sections: null });
    expect(empty.schedule.items).toEqual([]);
    expect(empty.summary).toBe("0 follow-ups due · 0 approvals");
  });

  it("keeps an AI headline to one short line", () => {
    const v = buildPlannerView({ ...base, source: "plan", sections, headline: "Start with comps. Then call Ravi. And more." });
    expect(v.headline).toBe("Start with comps.");
  });
});
