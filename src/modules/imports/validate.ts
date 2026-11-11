/*
 * Spreadsheet value validation (Input Engine spec §3.3, §7, §15 rules 2–5). Pure, deterministic, no DB.
 * Every parser returns the raw text alongside the normalised value; unknown stays unknown (S6):
 *  - an area without an explicit unit keeps unit = null (never assumed sq ft) and area basis is never assumed (carpet ≠ chargeable);
 *  - a rent never implies CAM/basis; blank is null, never 0;
 *  - a spreadsheet date is at most "reported" — ambiguous day/month order is flagged, never silently resolved.
 */
import type { Cell, RowIssue } from "./types";
import { excelSerialToIso } from "./normalize";

const NA_RE = /^(na|n\/a|n\.a\.?|nil|none|-+|—|not available|tbd|tba|\?)$/i;
const cellText = (c: Cell | undefined): string | null => {
  if (!c || c.v === null || c.v === undefined || c.t === "null") return null;
  const s = String(c.v).replace(/\s+/g, " ").trim();
  return !s || NA_RE.test(s) ? null : s;
};

/* ------------------------------------------------------------------ email */
const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
export interface EmailParse { raw: string | null; value: string | null; valid: boolean }
export function parseEmail(c: Cell | undefined): EmailParse {
  const raw = cellText(c);
  if (!raw) return { raw: null, value: null, valid: true };
  const v = raw.replace(/^mailto:/i, "").trim().toLowerCase();
  return EMAIL_RE.test(v) ? { raw, value: v, valid: true } : { raw, value: null, valid: false };
}

/* ------------------------------------------------------------------ Indian phone numbers */
export interface PhoneParse { raw: string | null; values: string[]; invalid: string[]; kinds: ("mobile" | "landline" | "toll_free" | "international")[] }
/**
 * Accepts the common Indian formats: 98200 12345, +91-98200-12345, 091 9820012345, 09820012345, (020) 2612 3456,
 * 020-26123456, 1800-123-4567, several numbers separated by "/", ",", ";" or " or ". Output is E.164 (+91...).
 * Numbers that do not fit are reported as invalid (raw kept), never "fixed" by guessing digits.
 */
export function parsePhones(c: Cell | undefined): PhoneParse {
  const raw = c && c.t === "n" && typeof c.v === "number" ? String(Math.round(c.v)) : cellText(c);
  if (!raw) return { raw: null, values: [], invalid: [], kinds: [] };
  const parts = raw.split(/\s*(?:[/,;|]|\bor\b|\n)\s*/i).map((p) => p.trim()).filter(Boolean);
  const values: string[] = [], invalid: string[] = [], kinds: PhoneParse["kinds"] = [];
  for (const p of parts) {
    const r = normalisePhone(p);
    if (r) { if (!values.includes(r.e164)) { values.push(r.e164); kinds.push(r.kind); } } else invalid.push(p);
  }
  return { raw, values, invalid, kinds };
}

export function normalisePhone(p: string): { e164: string; kind: PhoneParse["kinds"][number] } | null {
  const s = p.replace(/(ext|extn|x)\.?\s*\d+$/i, "").trim();
  if (/[a-z]/i.test(s)) return null;
  const intl = s.startsWith("+") && !s.startsWith("+91");
  let d = s.replace(/\D/g, "");
  if (intl) return d.length >= 8 && d.length <= 15 ? { e164: `+${d}`, kind: "international" } : null;
  if (d.startsWith("0091")) d = d.slice(4);
  else if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 13 && d.startsWith("091")) d = d.slice(3);
  if (/^1800\d{6,7}$/.test(d)) return { e164: `+91${d}`, kind: "toll_free" };
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length !== 10) return null;
  if (/^[6-9]\d{9}$/.test(d)) return { e164: `+91${d}`, kind: "mobile" };
  if (/^[1-5]\d{9}$/.test(d)) return { e164: `+91${d}`, kind: "landline" }; // STD code + subscriber (leading 0 removed)
  return null;
}

/* ------------------------------------------------------------------ dates */
export type DateFormat = "excel_date" | "iso" | "dmy" | "mdy" | "ambiguous_dm" | "d_mon_y" | "mon_y" | "quarter" | "year" | "unparsed";
export interface DateParse {
  raw: string | null;
  value: string | null; // ISO yyyy-mm-dd when a single day is determinable
  precision: "day" | "month" | "quarter" | "year" | "unknown";
  format: DateFormat;
  ambiguous: boolean; // day/month order could be swapped (both <= 12)
  alternative: string | null; // the other reading of an ambiguous dd/mm vs mm/dd value
}
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
};
const yr = (s: string) => (s.length === 2 ? 2000 + Number(s) : Number(s));

/**
 * Parse one spreadsheet date. Day-first is the Indian convention, but a numeric dd/mm vs mm/dd value whose parts
 * are both <= 12 is AMBIGUOUS: `value` is the day-first reading, `ambiguous` is set and the alternative is kept.
 * A month/quarter/year without a day keeps its precision and value = null (no day is invented).
 */
export function parseDate(c: Cell | undefined): DateParse {
  const none = (raw: string | null, format: DateFormat): DateParse => ({ raw, value: null, precision: "unknown", format, ambiguous: false, alternative: null });
  if (!c || c.v === null || c.v === undefined || c.t === "null") return none(null, "unparsed");
  if (c.t === "d" && typeof c.v === "string") return { raw: c.v, value: c.v.slice(0, 10), precision: "day", format: "excel_date", ambiguous: false, alternative: null };
  if (c.t === "n" && typeof c.v === "number") {
    if (c.v >= 1900 && c.v <= 2100 && Number.isInteger(c.v)) return { ...none(String(c.v), "year"), precision: "year" };
    const iso = c.v > 20000 && c.v < 80000 ? excelSerialToIso(c.v) : null;
    return iso ? { raw: String(c.v), value: iso, precision: "day", format: "excel_date", ambiguous: false, alternative: null } : none(String(c.v), "unparsed");
  }
  const raw = cellText(c);
  if (!raw) return none(null, "unparsed");
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) { const v = ymd(+m[1], +m[2], +m[3]); return v ? { raw, value: v, precision: "day", format: "iso", ambiguous: false, alternative: null } : none(raw, "unparsed"); }
  m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = yr(m[3]);
    const dmy = ymd(y, b, a), mdy = ymd(y, a, b);
    if (dmy && mdy && a !== b) return { raw, value: dmy, precision: "day", format: "ambiguous_dm", ambiguous: true, alternative: mdy };
    if (dmy) return { raw, value: dmy, precision: "day", format: "dmy", ambiguous: false, alternative: null };
    if (mdy) return { raw, value: mdy, precision: "day", format: "mdy", ambiguous: false, alternative: null };
    return none(raw, "unparsed");
  }
  m = raw.match(/^(\d{1,2})(?:st|nd|rd|th)?[-\s/]([A-Za-z]{3,9})[-\s/,]+(\d{2}|\d{4})$/);
  const mo = m ? MONTHS[m[2].slice(0, 3).toLowerCase()] : undefined;
  if (m && mo) {
    const v = ymd(yr(m[3]), mo, +m[1]);
    return v ? { raw, value: v, precision: "day", format: "d_mon_y", ambiguous: false, alternative: null } : none(raw, "unparsed");
  }
  m = raw.match(/^([A-Za-z]{3,9})[-\s/,']+(\d{2}|\d{4})$/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return { ...none(raw, "mon_y"), precision: "month" };
  if (/^q[1-4][\s-]*(fy)?\s*'?\d{2,4}$/i.test(raw)) return { ...none(raw, "quarter"), precision: "quarter" };
  if (/^(fy\s*)?'?\d{4}$/i.test(raw)) return { ...none(raw, "year"), precision: "year" };
  return none(raw, "unparsed");
}

/**
 * Column-level consistency: a column mixing day-first and month-first values (e.g. 25/03/2026 and 03/25/2026),
 * or several textual styles, is reported. Ambiguous values in a column that is otherwise clearly day-first are
 * resolved day-first but still flagged for review (the date stays "reported").
 */
export function dateColumnConsistency(parses: DateParse[]): { formats: Record<string, number>; mixedOrder: boolean; inconsistent: boolean } {
  const formats: Record<string, number> = {};
  for (const p of parses) if (p.raw) formats[p.format] = (formats[p.format] ?? 0) + 1;
  const mixedOrder = !!formats.dmy && !!formats.mdy;
  const textual = ["iso", "dmy", "mdy", "d_mon_y", "ambiguous_dm"].filter((k) => formats[k]);
  const inconsistent = mixedOrder || textual.length > 1 || (!!formats.unparsed && Object.keys(formats).length > 1);
  return { formats, mixedOrder, inconsistent };
}

/* ------------------------------------------------------------------ area */
export type AreaUnit = "sq_ft" | "sq_m" | "acre" | "seats";
export type AreaBasis = "carpet" | "chargeable" | "built_up" | "super_built_up" | "leasable";
export interface AreaParse {
  raw: string | null;
  min: number | null;
  max: number | null;
  unit: AreaUnit | null; // null = not stated (never assumed)
  basis: AreaBasis | null; // null = not stated (never assumed)
  valid: boolean;
  reason?: string;
}
const UNIT_RES: [RegExp, AreaUnit][] = [
  [/\b(sq\.?\s*ft\.?|sqft|sft|sf|square\s*feet|sq\.?\s*feet|ft2)\b/i, "sq_ft"],
  [/\b(sq\.?\s*m\.?|sqm|square\s*met(?:er|re)s?|m2)\b/i, "sq_m"],
  [/\b(acres?)\b/i, "acre"],
  [/\b(seats?|seaters?|desks?|workstations?|ws)\b/i, "seats"],
];
const BASIS_RES: [RegExp, AreaBasis][] = [
  [/\bcarpet\b/i, "carpet"], [/\bsuper\s*built[\s-]*up\b|\bsba\b/i, "super_built_up"], [/\bbuilt[\s-]*up\b|\bbua\b/i, "built_up"],
  [/\bchargeable\b|\bcharg\b/i, "chargeable"], [/\bleasable\b|\brentable\b/i, "leasable"],
];
export function unitFrom(s: string | null | undefined): AreaUnit | null {
  if (!s) return null;
  for (const [re, u] of UNIT_RES) if (re.test(s)) return u;
  return null;
}
export function basisFrom(s: string | null | undefined): AreaBasis | null {
  if (!s) return null;
  for (const [re, b] of BASIS_RES) if (re.test(s)) return b;
  return null;
}
function numToken(t: string): number | null {
  const m = t.trim().toLowerCase().replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*(k|l|lac|lakh|lakhs)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "k" ? n * 1_000 : m[2] ? n * 1_00_000 : n;
}
/** Parse "20,000 sq ft", "15k-20k sft carpet", "1.2 lakh", 25000. Unit/basis come from the cell or the header hint only. */
export function parseArea(c: Cell | undefined, headerHint?: string | null, unitHint?: string | null): AreaParse {
  const unit0 = unitFrom(unitHint) ?? unitFrom(headerHint);
  const basis0 = basisFrom(unitHint) ?? basisFrom(headerHint);
  if (!c || c.v === null || c.v === undefined || c.t === "null") return { raw: null, min: null, max: null, unit: unit0, basis: basis0, valid: true };
  if (c.t === "n" && typeof c.v === "number") {
    const ok = c.v > 0;
    return { raw: String(c.v), min: ok ? c.v : null, max: ok ? c.v : null, unit: unit0, basis: basis0, valid: ok, reason: ok ? undefined : "area must be greater than zero" };
  }
  const raw = cellText(c);
  if (!raw) return { raw: c.v === null ? null : String(c.v), min: null, max: null, unit: unit0, basis: basis0, valid: true };
  const unit = unitFrom(raw) ?? unit0, basis = basisFrom(raw) ?? basis0;
  let core = raw;
  for (const [re] of UNIT_RES) core = core.replace(new RegExp(re.source, "gi"), " ");
  for (const [re] of BASIS_RES) core = core.replace(new RegExp(re.source, "gi"), " ");
  core = core.replace(/\b(approx\.?|about|around|~|area|min|max|upto|up to)\b/gi, " ").replace(/\s+/g, " ").trim();
  if (/^[-–]\s*\d/.test(core)) return { raw, min: null, max: null, unit, basis, valid: false, reason: "area must be greater than zero" };
  const parts = core.split(/\s*(?:-|–|to)\s*/i).filter(Boolean);
  const nums = parts.map(numToken);
  if (!nums.length || nums.some((n) => n === null) || nums.length > 2) return { raw, min: null, max: null, unit, basis, valid: false, reason: "area is not a number or range" };
  const [a, b] = [nums[0]!, nums[nums.length - 1]!];
  if (a <= 0 || b <= 0) return { raw, min: null, max: null, unit, basis, valid: false, reason: "area must be greater than zero" };
  if (b < a) return { raw, min: null, max: null, unit, basis, valid: false, reason: "area range is reversed" };
  return { raw, min: a, max: b, unit, basis, valid: true };
}

/* ------------------------------------------------------------------ rent */
export interface RentParse { raw: string | null; min: number | null; max: number | null; basis: string | null; valid: boolean; reason?: string }
/** "₹85/sf", "85-90 per sq ft per month", "Rs 1.2 lakh pm", 85. Basis (per sf / per month / total / CAM incl.) only when stated. */
export function parseRent(c: Cell | undefined, headerHint?: string | null): RentParse {
  if (!c || c.v === null || c.v === undefined || c.t === "null") return { raw: null, min: null, max: null, basis: null, valid: true };
  const raw = c.t === "n" ? String(c.v) : cellText(c);
  if (!raw) return { raw: null, min: null, max: null, basis: null, valid: true };
  const all = `${raw} ${headerHint ?? ""}`.toLowerCase();
  const basisBits: string[] = [];
  if (/(\/|per)\s*(sq\.?\s*ft|sft|sf|sqft)/.test(all)) basisBits.push("per_sf");
  if (/(\/|per)\s*seat/.test(all)) basisBits.push("per_seat");
  if (/(\/|per)\s*(month|mo)\b|\bp\.?\s*m\.?\b|monthly/.test(all)) basisBits.push("per_month");
  if (/(\/|per)\s*(annum|year|yr)\b|\bp\.?\s*a\.?\b|annual/.test(all)) basisBits.push("per_year");
  if (/incl\w*\s*cam|including\s*cam|\+?\s*cam\s*incl/.test(all)) basisBits.push("cam_included");
  else if (/excl\w*\s*cam|plus\s*cam|\+\s*cam/.test(all)) basisBits.push("cam_excluded");
  const core = raw.toLowerCase().replace(/rs\.?|inr|₹|\/-/g, " ").replace(/(\/|per)\s*[a-z. ]+$/g, " ").replace(/\b(psf|pm|pa|p\.m\.|p\.a\.|cam|incl\w*|excl\w*|plus|approx\.?)\b/g, " ").replace(/\s+/g, " ").trim();
  if (/^[-–]\s*\d/.test(core)) return { raw, min: null, max: null, basis: basisBits.join("+") || null, valid: false, reason: "rent must be greater than zero" };
  const nums = core.split(/\s*(?:-|–|to)\s*/).filter(Boolean).map(numToken);
  if (!nums.length || nums.some((n) => n === null) || nums.length > 2) return { raw, min: null, max: null, basis: basisBits.join("+") || null, valid: false, reason: "rent is not a number or range" };
  const [a, b] = [nums[0]!, nums[nums.length - 1]!];
  if (a <= 0) return { raw, min: null, max: null, basis: basisBits.join("+") || null, valid: false, reason: "rent must be greater than zero" };
  return { raw, min: Math.min(a, b), max: Math.max(a, b), basis: basisBits.join("+") || null, valid: true };
}

/* ------------------------------------------------------------------ suspicious numbers */
/** Plausibility bands for Indian office requirements. Out-of-band values are kept but flagged for review. */
export function suspiciousArea(a: AreaParse): string | null {
  if (a.min === null) return null;
  const v = a.max ?? a.min;
  if (a.unit === "seats") return v > 20_000 ? `${v} seats is unusually large` : null;
  if (a.unit === "sq_m") return v < 10 || v > 500_000 ? `${v} sq m is outside the plausible range` : null;
  if (a.unit === "acre") return v > 500 ? `${v} acres is unusually large` : null;
  if (v < 100) return `${v} looks too small for an office area (missing a unit or "k"?)`;
  if (v > 2_000_000) return `${v} is implausibly large for an office area (above 20,00,000 sq ft)`;
  if (/^[6-9]\d{9}$/.test(String(v))) return `${v} looks like a phone number, not an area`;
  if (a.max !== null && a.min !== null && a.max > a.min * 10) return `area range ${a.min}–${a.max} spans more than 10x`;
  return null;
}
export function suspiciousRent(r: RentParse): string | null {
  if (r.min === null) return null;
  const v = r.max ?? r.min;
  const perSf = r.basis?.includes("per_sf") ?? false;
  if (perSf && (v < 15 || v > 400)) return `₹${v}/sf is outside the plausible office range (₹15–400/sf/month)`;
  if (!r.basis && v > 1_000 && v < 10_000) return `rent ${v} has no stated basis (per sf? per seat? total?)`;
  if (v > 50_00_00_000) return `rent ${v} is implausibly large`;
  return null;
}

/* ------------------------------------------------------------------ issue helpers */
export const vIssue = (kind: string, message: string, severity: RowIssue["severity"] = "review", details?: Record<string, unknown>): RowIssue => ({ kind, message, severity, details });
