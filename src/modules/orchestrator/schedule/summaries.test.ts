import { describe, expect, it } from "vitest";
import { dailyHeadline, weeklySummary } from "./summaries";

const ok = (n: number, f = (i: number) => ({ title: `Item ${i}` })) => ({ state: "ok", items: Array.from({ length: n }, (_, i) => f(i)) });

describe("orchestrator code summaries (AI policy off)", () => {
  it("daily headline from counts + first recommendation", () => {
    const h = dailyHeadline({ todays_meetings: ok(3), meetings_needing_prep: ok(1), overdue_commitments: ok(2), lease_alerts: ok(1) }, [{ title: "Call Infosys re: Baner renewal" }, { title: "Prep site visit" }]);
    expect(h.headline).toBe("3 meetings today (1 needs prep), 2 overdue commitments and 1 lease alert. Start with: Call Infosys re: Baner renewal.");
    expect(h.focus).toEqual(["Call Infosys re: Baner renewal", "Prep site visit"]);
  });
  it("names failed sources instead of implying nothing happened", () => {
    const h = dailyHeadline({ todays_meetings: { state: "unavailable", items: [] } }, []);
    expect(h.headline).toMatch(/No urgent items/);
    expect(h.headline).toMatch(/Not checked: calendar/);
  });
  it("weekly summary", () => {
    const w = weeklySummary({ meetings_completed: ok(4), followups_completed: ok(6), new_opportunities: ok(1), stalled_transactions: ok(2), meetings_scheduled: ok(5), recommended_next_week: ok(2, (i) => ({ title: `Next ${i}` })) });
    expect(w.headline).toBe("This week: 4 meetings held, 6 follow-ups completed and 1 new opportunity. Watch: 2 deals stalled 30+ days. 5 meetings booked for next week.");
    expect(w.focus).toEqual(["Next 0", "Next 1"]);
    expect(weeklySummary({}).headline).toMatch(/Quiet week/);
  });
});
