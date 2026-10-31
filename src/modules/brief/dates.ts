/** Pure date-only helpers ("YYYY-MM-DD"), UTC-based so they never drift with the server timezone. */
import { formatInTimeZone } from "date-fns-tz";
import { edate, daysBetween, localDate, atLocal } from "@/lib/util/time";

export { edate, daysBetween, localDate, atLocal };

export function addDays(iso: string, n: number): string {
  const t = Date.parse(iso + "T00:00:00Z") + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** ISO weekday 1=Mon..7=Sun for a date-only value. */
export function isoWeekday(iso: string): number {
  const d = new Date(iso + "T00:00:00Z").getUTCDay();
  return d === 0 ? 7 : d;
}

/** Subtract N business days (Mon-Fri). No holiday calendar yet (documented gap). */
export function subtractBusinessDays(iso: string, n: number): string {
  let d = iso;
  let left = n;
  while (left > 0) {
    d = addDays(d, -1);
    if (isoWeekday(d) <= 5) left--;
  }
  return d;
}

export function minDate(...ds: (string | null | undefined)[]): string | null {
  const v = ds.filter((d): d is string => !!d).sort();
  return v[0] ?? null;
}

export function quarterKey(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** ISO week key e.g. "2026-W44" for the local date. */
export function isoWeekKey(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function monthStart(iso: string): string {
  return iso.slice(0, 8) + "01";
}
export function monthEnd(iso: string): string {
  return addDays(edate(monthStart(iso), 1), -1);
}

/** Count workdays from `from` to `to` inclusive. */
export function workdaysBetween(from: string, to: string, workdays: number[]): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (workdays.includes(isoWeekday(d))) n++;
  return n;
}

export function localHHMM(at: Date, tz: string): string {
  return formatInTimeZone(at, tz, "HH:mm");
}

/** Local date of an instant/ISO string in tz. */
export function dateOf(at: string | Date, tz: string): string {
  return localDate(typeof at === "string" ? new Date(at) : at, tz);
}
