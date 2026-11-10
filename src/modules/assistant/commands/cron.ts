import { getTimezoneOffset } from "date-fns-tz";

/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week), evaluated in a wall-clock time zone (IST by default).
 * Supports *, numbers, lists (1,3), ranges (1-5) and steps (*\/15, 0-30/10). Day-of-week 0 or 7 = Sunday.
 * Standard rule: when both day-of-month and day-of-week are restricted, either may match.
 */
type Field = { set: Set<number>; any: boolean };
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(src: string, [lo, hi]: [number, number]): Field {
  const set = new Set<number>();
  for (const part of src.split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${src}"`);
    let a: number, b: number;
    if (range === "*") { a = lo; b = hi; }
    else if (range.includes("-")) { [a, b] = range.split("-").map(Number); }
    else { a = Number(range); b = stepS === undefined ? a : hi; }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) throw new Error(`"${src}" is out of range ${lo}-${hi}`);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return { set, any: src === "*" };
}

export function parseCron(expr: string): Field[] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("A schedule needs 5 parts: minute hour day month weekday (e.g. 0 8 * * 1-5)");
  const f = parts.map((p, i) => parseField(p, RANGES[i]));
  if (f[4].set.has(7)) f[4].set.add(0);
  return f;
}

export function isValidCron(expr: string): boolean {
  try { parseCron(expr); return true; } catch { return false; }
}

/** Next run strictly after `after`, as a UTC Date. Returns null if nothing in the next 400 days. */
export function nextCronRun(expr: string, after: Date = new Date(), tz = "Asia/Kolkata"): Date | null {
  const [mi, ho, dom, mon, dow] = parseCron(expr);
  const off = (d: Date) => getTimezoneOffset(tz, d);
  // work in "local wall clock expressed as UTC" milliseconds
  let t = Math.floor((after.getTime() + off(after)) / 60_000) * 60_000 + 60_000;
  const end = t + 400 * 86_400_000;
  while (t < end) {
    const d = new Date(t);
    const dayOk = (dom.any && dow.any) ? true
      : dom.any ? dow.set.has(d.getUTCDay())
      : dow.any ? dom.set.has(d.getUTCDate())
      : dom.set.has(d.getUTCDate()) || dow.set.has(d.getUTCDay());
    if (!mon.set.has(d.getUTCMonth() + 1) || !dayOk) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); continue; }
    if (!ho.set.has(d.getUTCHours())) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1); continue; }
    if (!mi.set.has(d.getUTCMinutes())) { t += 60_000; continue; }
    const guess = new Date(t - off(new Date(t)));
    return new Date(t - off(guess));
  }
  return null;
}

/** "08:30" + weekdays|daily|weekly(mon) → cron. Used by the simple schedule form. */
export function cronFromSimple(time: string, days: "daily" | "weekdays" | "monday"): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error("Time must look like 08:30");
  return `${Number(m[2])} ${Number(m[1])} * * ${days === "daily" ? "*" : days === "weekdays" ? "1-5" : "1"}`;
}
