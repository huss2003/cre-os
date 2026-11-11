import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

export const IST = "Asia/Kolkata";

/** Store UTC instants; present and schedule in workspace timezone (default Asia/Kolkata). */
export function fmt(d: Date | string | null | undefined, pattern = "dd MMM yyyy, HH:mm", tz = IST) {
  if (!d) return "—";
  return formatInTimeZone(typeof d === "string" ? new Date(d) : d, tz, pattern);
}
export function fmtDate(d: Date | string | null | undefined, tz = IST) {
  return fmt(d, "dd MMM yyyy", tz);
}

/** Local calendar date (YYYY-MM-DD) in tz for an instant. */
export function localDate(at: Date = new Date(), tz = IST): string {
  return formatInTimeZone(at, tz, "yyyy-MM-dd");
}

/** UTC instant for a wall-clock time on a local date, e.g. atLocal("2026-11-02","08:00"). */
export function atLocal(date: string, hhmm: string, tz = IST): Date {
  return fromZonedTime(`${date}T${hhmm}:00`, tz);
}

export function nowIn(tz = IST): Date {
  return toZonedTime(new Date(), tz);
}

/**
 * Excel EDATE semantics for INTEGER months on a date-only value: add months, clamp to month end.
 * Fractional months are NOT accepted (spec: quarantine fractional tenure for interpretation).
 * Input/Output: "YYYY-MM-DD".
 */
export function edate(isoDate: string, months: number): string {
  if (!Number.isInteger(months)) throw new Error(`edate: non-integer months (${months}) must be quarantined`);
  const [y, m, d] = isoDate.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12; // 0-based
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${String(ny).padStart(4, "0")}-${String(nm + 1).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

/** True when `at` is earlier than now minus a small tolerance (default 15 min) — used to reject "reschedule to the past". */
export function isPastInstant(at: Date, toleranceMin = 15, now: Date = new Date()): boolean {
  return +at < +now - toleranceMin * 60e3;
}
