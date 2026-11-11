import { describe, expect, it } from "vitest";
import { classify, deliverAfter, groupKeyFor, inWindow, suppressed } from "./rules";
import { resolveOrchSettings } from "../schedule/settings";

const s = resolveOrchSettings({}); // quiet 22:00–07:00, working 09:30–19:00 IST, Mon–Fri
const o = { tz: s.timezone, quietHours: s.quietHours, workingHours: s.workingHours, workdays: s.workdays };

describe("quiet hours / working hours", () => {
  it("window wraps midnight", () => {
    expect(inWindow("23:30", { start: "22:00", end: "07:00" })).toBe(true);
    expect(inWindow("06:59", { start: "22:00", end: "07:00" })).toBe(true);
    expect(inWindow("07:00", { start: "22:00", end: "07:00" })).toBe(false);
  });
  it("info at 23:30 IST waits for 09:30 next workday; urgent is immediate", () => {
    const now = new Date("2032-03-10T18:00:00Z"); // Wed 23:30 IST
    expect(deliverAfter(now, "info", o).toISOString()).toBe("2032-03-11T04:00:00.000Z");
    expect(deliverAfter(now, "urgent", o)).toBe(now);
  });
  it("early morning waits for today's start; working hours deliver now", () => {
    expect(deliverAfter(new Date("2032-03-10T02:00:00Z"), "info", o).toISOString()).toBe("2032-03-10T04:00:00.000Z"); // 07:30 IST
    const noon = new Date("2032-03-10T06:30:00Z");
    expect(deliverAfter(noon, "info", o)).toBe(noon);
  });
  it("Friday evening info waits until Monday", () => {
    expect(deliverAfter(new Date("2032-03-12T15:00:00Z"), "info", o).toISOString()).toBe("2032-03-15T04:00:00.000Z");
  });
});

describe("preferences, severity, grouping", () => {
  it("severity is decided in code; urgent categories configurable", () => {
    expect(classify("meeting_prep", undefined, s.notifications)).toBe("urgent");
    expect(classify("follow_up", undefined, s.notifications)).toBe("info");
    expect(classify("meeting_prep", "info", s.notifications)).toBe("info"); // "Brief ready" is informational even though meeting_prep is an urgent category
    expect(classify("follow_up", "urgent", s.notifications)).toBe("urgent");
  });
  it("muted categories are suppressed unless urgent", () => {
    const p = resolveOrchSettings({ userPrefs: { orchestrator: { notifications: { muted: ["weekly_review", "budget"] } } } }).notifications;
    expect(suppressed("weekly_review", "info", p)).toBe(true);
    expect(suppressed("budget", "urgent", p)).toBe(false);
  });
  it("group keys per record or category", () => {
    expect(groupKeyFor("follow_up", { type: "organisation", id: "o1" })).toBe("follow_up:organisation:o1");
    expect(groupKeyFor("capacity", null)).toBe("capacity:*");
  });
});
