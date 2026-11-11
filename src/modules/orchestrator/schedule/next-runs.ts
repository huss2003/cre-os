/** Pure: next run times of the per-user recurring schedule items (daily plan, weekly review) for the Overview. */
import { atLocal, localDate } from "@/lib/util/time";
import { addDays, isoWeekday } from "@/modules/brief/dates";
import type { OrchSettings } from "./settings";

export interface RecurringItem { key: string; name: string; href: string; when: string; nextRunAt: string | null }
const DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function recurringScheduleItems(s: OrchSettings, now: Date): RecurringItem[] {
  const today = localDate(now, s.timezone);
  const next = (ok: (d: string) => boolean, time: string): string | null => {
    for (let i = 0; i < 15; i++) {
      const d = addDays(today, i);
      if (!ok(d)) continue;
      const at = atLocal(d, time, s.timezone);
      if (+at > +now) return at.toISOString();
    }
    return null;
  };
  const dailyOk = (d: string) => s.workdays.includes(isoWeekday(d)) || !!s.brief?.weekendBrief;
  return [
    { key: "daily_plan", name: "Daily plan", href: "/automation?view=daily", when: `${s.brief?.weekendBrief ? "Every day" : "Workdays"} at ${s.dailyPlanTime}`, nextRunAt: next(dailyOk, s.dailyPlanTime) },
    { key: "weekly_review", name: "Weekly review", href: "/automation?view=weekly", when: `${DAYS[s.weeklyReview.weekday] ?? "Weekly"} at ${s.weeklyReview.time}`, nextRunAt: next((d) => isoWeekday(d) === s.weeklyReview.weekday, s.weeklyReview.time) },
  ];
}
