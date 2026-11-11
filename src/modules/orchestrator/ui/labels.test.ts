import { describe, expect, it } from "vitest";
import { capacityKindLabel, isRecalculated, markLabel } from "./labels";
import { recurringScheduleItems } from "../schedule/next-runs";
import { resolveOrchSettings } from "../schedule/settings";

describe("plain labels", () => {
  it("capacity kinds are plain words", () => {
    expect(capacityKindLabel("too_many_meetings")).toBe("Too many meetings");
    expect(capacityKindLabel("travel_conflict")).toBe("Travel time");
    expect(capacityKindLabel("something_new")).toBe("Something new");
  });
  it("an already-recalculated needs-refresh mark reads 'Recalculated — review'", () => {
    const m = { mark: "needs_refresh", detail: { previous_version: 1, new_version: 2 } };
    expect(isRecalculated(m)).toBe(true);
    expect(markLabel(m).label).toBe("Recalculated — review");
    expect(isRecalculated({ mark: "needs_refresh", detail: {} })).toBe(false);
    expect(markLabel({ mark: "needs_refresh", detail: {} }).label).toBe("Needs refresh");
    expect(isRecalculated({ mark: "outdated_warning", detail: { new_version: 2 } })).toBe(false);
  });
});

describe("Overview recurring schedule", () => {
  it("lists daily plan and weekly review with next run times", () => {
    const s = resolveOrchSettings({});
    const now = new Date("2026-11-11T12:00:00Z"); // Wed 17:30 IST
    const items = recurringScheduleItems(s, now);
    expect(items.map((i) => i.key)).toEqual(["daily_plan", "weekly_review"]);
    const daily = items[0];
    expect(daily.nextRunAt).not.toBeNull();
    expect(+new Date(daily.nextRunAt!)).toBeGreaterThan(+now);
    expect(+new Date(daily.nextRunAt!) - +now).toBeLessThanOrEqual(4 * 864e5);
    expect(items[1].nextRunAt).not.toBeNull();
    expect(daily.when).toContain(s.dailyPlanTime);
  });
});
