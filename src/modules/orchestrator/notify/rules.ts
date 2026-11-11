/**
 * Notification rules (pure, spec §9): urgent vs informational, quiet hours / working hours, grouping, preferences.
 * Nothing here sends anything outside the app (S3) — notifications are in-app rows only.
 */
import { addDays } from "@/modules/brief/dates";
import { atLocal, localDate } from "@/lib/util/time";
import { formatInTimeZone } from "date-fns-tz";
import type { NotificationPrefs } from "../schedule/settings";

export type Severity = "urgent" | "info";

/** Known categories (free text is allowed; these drive defaults). */
export const CATEGORIES = [
  "daily_plan", "meeting_prep", "meeting_outcome", "follow_up", "lease_event", "approval", "failed_job",
  "commercial_change", "commitment", "budget", "capacity", "weekly_review", "info",
] as const;

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

/** Is `local` (HH:mm) inside [start, end) — the window may wrap midnight. Equal start/end = no window. */
export function inWindow(localHHMM: string, w: { start: string; end: string }): boolean {
  const t = minutes(localHHMM), s = minutes(w.start), e = minutes(w.end);
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/**
 * When may an informational notification be shown? Urgent → now. Info inside quiet hours or outside working hours
 * on a workday → the next working-hours start (never during quiet hours). Non-workdays defer to the next workday start.
 */
export function deliverAfter(now: Date, severity: Severity, o: { tz: string; quietHours: { start: string; end: string }; workingHours: { start: string; end: string }; workdays: number[] }): Date {
  if (severity === "urgent") return now;
  const local = formatInTimeZone(now, o.tz, "HH:mm");
  const today = localDate(now, o.tz);
  const isWorkday = (d: string) => o.workdays.includes(isoWeekday(d));
  const inWork = isWorkday(today) && inWindow(local, o.workingHours) && !inWindow(local, o.quietHours);
  if (inWork) return now;
  // next working start: today if still before it, else the following workday
  let d = today;
  if (!(isWorkday(d) && minutes(local) < minutes(o.workingHours.start))) d = addDays(d, 1);
  for (let i = 0; i < 8 && !isWorkday(d); i++) d = addDays(d, 1);
  return atLocal(d, o.workingHours.start, o.tz);
}

function isoWeekday(iso: string): number {
  const d = new Date(iso + "T00:00:00Z").getUTCDay();
  return d === 0 ? 7 : d;
}

/** Severity decided in code (never by a model): explicit urgent, or the category is one the user marked urgent. */
export function classify(category: string, requested: Severity | undefined, prefs: NotificationPrefs): Severity {
  if (requested === "urgent") return "urgent";
  return prefs.urgentCategories.includes(category) && requested !== "info" ? "urgent" : "info";
}

/** Muted categories are suppressed unless urgent (urgent alerts cannot be muted silently). */
export function suppressed(category: string, severity: Severity, prefs: NotificationPrefs): boolean {
  return severity !== "urgent" && prefs.muted.includes(category);
}

/** Group key: same category about the same record (or category-wide when there is no record). */
export function groupKeyFor(category: string, record?: { type: string; id: string } | null, explicit?: string | null): string {
  if (explicit) return explicit;
  return record ? `${category}:${record.type}:${record.id}` : `${category}:*`;
}

/** Local date used by notifications ("today" is the user's day, not UTC). */
export function userDay(now: Date, tz: string) { return localDate(now, tz); }
