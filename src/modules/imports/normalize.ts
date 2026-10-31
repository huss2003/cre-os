/* Deterministic value normalisation for imports. Raw values are always kept alongside; unknown stays unknown (S6). */
import type { Cell, SizeClass, SizeRules } from "./types";

/** Header label normalisation: case fold, collapse whitespace, strip punctuation except the label words. */
export function normHeader(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[ \s]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Exact-key normalisation used for building/locality keys: trim + case fold + whitespace collapse only (Part V audit rule). */
export function exactKey(s: unknown): string {
  return String(s ?? "").replace(/[ \s]+/g, " ").trim().toLowerCase();
}

const LEGAL_SUFFIXES = [
  "private limited", "pvt limited", "pvt ltd", "private ltd", "pvt", "limited", "ltd", "llp", "inc", "incorporated",
  "corporation", "corp", "plc", "gmbh", "ag", "bv", "sa", "pte", "co",
];

/** Canonical organisation name for fuzzy matching (strips legal-form suffixes and punctuation). */
export function canonicalOrg(s: unknown): string {
  let t = normHeader(s).replace(/\bpvt\b\.?/g, "pvt").replace(/\s+/g, " ");
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (t.endsWith(" " + suf)) {
        t = t.slice(0, -suf.length - 1).trim();
        changed = true;
      }
    }
  }
  return t.replace(/^the /, "").trim();
}

/** Canonical building name for fuzzy matching. Tower/wing designators are kept (they are scope, not noise). */
export function canonicalBuilding(s: unknown): string {
  return normHeader(s)
    .replace(/\b(twr)\b/g, "tower")
    .replace(/\b(bldg)\b/g, "building")
    .replace(/\b(it park|itpark)\b/g, "it park")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tower / wing / block / phase scope tokens, e.g. "EON Free Zone Tower 2" -> ["tower:2"]. */
export function scopeTokens(s: unknown): string[] {
  const t = canonicalBuilding(s);
  const out: string[] = [];
  const re = /\b(tower|wing|block|phase|building|plot|cluster)\s*(?:no\s*)?([a-z]?\d+[a-z]?|[a-z]|i{1,3}|iv|v|vi{0,3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) out.push(`${m[1]}:${m[2]}`);
  return out;
}

export const isBlankText = (v: unknown) => v === null || v === undefined || String(v).trim() === "";
const NA_RE = /^(na|n\/a|n\.a\.?|nil|none|-+|—|not available|tbd|tba)$/i;

/** Text value or null (blank/NA). */
export function text(c: Cell | undefined): string | null {
  if (!c || c.v === null || c.v === undefined) return null;
  const s = String(c.v).replace(/\s+/g, " ").trim();
  if (!s || NA_RE.test(s)) return null;
  return s;
}

export interface NumParse { value: number | null; ok: boolean; raw: string | null; blank: boolean }

/** Parse a number from a cell. Blank/NA => {value:null, ok:true, blank:true}. Unparseable text => ok:false. */
export function num(c: Cell | undefined): NumParse {
  if (!c || c.v === null || c.v === undefined || c.t === "null") return { value: null, ok: true, raw: null, blank: true };
  if (c.t === "n" && typeof c.v === "number") return { value: c.v, ok: Number.isFinite(c.v), raw: String(c.v), blank: false };
  if (c.t === "e") return { value: null, ok: false, raw: String(c.v), blank: false };
  const raw = String(c.v).trim();
  if (!raw || NA_RE.test(raw)) return { value: null, ok: true, raw, blank: true };
  const cleaned = raw.replace(/,/g, "").replace(/\s*(sq\.?\s*ft\.?|sft|sf|sqft|seats?|rs\.?|inr|₹|\/-)\s*/gi, "").trim();
  if (/^-?\d+(\.\d+)?$/.test(cleaned)) return { value: Number(cleaned), ok: true, raw, blank: false };
  return { value: null, ok: false, raw, blank: false };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function validYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > last) return null;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Excel serial date (1900 system) to ISO date. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const ms = Math.round((serial - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Parse a date-only value. Indian day-first convention for numeric text (dd-mm-yyyy / dd/mm/yyyy).
 * Returns null for blank or unparseable values (never invents a day from a month/year).
 */
export function date(c: Cell | undefined): string | null {
  if (!c || c.v === null || c.v === undefined) return null;
  if (c.t === "d" && typeof c.v === "string") return c.v.slice(0, 10);
  if (c.t === "n" && typeof c.v === "number") return excelSerialToIso(c.v);
  const s = String(c.v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return validYmd(y, +m[2], +m[1]);
  }
  m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/,]+(\d{2}|\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return validYmd(y, MONTHS[m[2].toLowerCase()], +m[1]);
  }
  return null;
}

export interface RangeParse { min: number | null; max: number | null; text: string | null; ok: boolean }

/** Floor-size / rent band text: "20,000 - 25,000", "15000-18000", "25K", "80-84", 25000 => min/max numerics + original text. */
export function range(c: Cell | undefined): RangeParse {
  if (!c || c.v === null || c.v === undefined || c.t === "null") return { min: null, max: null, text: null, ok: true };
  if (c.t === "n" && typeof c.v === "number") return { min: c.v, max: c.v, text: String(c.v), ok: true };
  const raw = String(c.v).replace(/\s+/g, " ").trim();
  if (!raw || NA_RE.test(raw)) return { min: null, max: null, text: raw || null, ok: true };
  const toNum = (s: string) => {
    const k = /k$/i.test(s.trim());
    const n = Number(s.replace(/[^0-9.]/g, ""));
    if (!s.replace(/[^0-9.]/g, "") || !Number.isFinite(n)) return null;
    return k ? n * 1000 : n;
  };
  const cleaned = raw.replace(/,/g, "").replace(/(sq\.?\s*ft\.?|sft|sqft|sf|rs\.?|inr|₹|psf|per sq ?ft|\/sf|\/sft|\/month|pm)/gi, " ").trim();
  const parts = cleaned.split(/\s*(?:-|–|—|to)\s*/i).filter((p) => p.trim() !== "");
  if (parts.length === 1 && /^\d+(\.\d+)?k?$/i.test(parts[0].trim())) {
    const n = toNum(parts[0]);
    return { min: n, max: n, text: raw, ok: n !== null };
  }
  if (parts.length === 2 && parts.every((p) => /^\d+(\.\d+)?k?$/i.test(p.trim()))) {
    const a = toNum(parts[0]), b = toNum(parts[1]);
    if (a === null || b === null) return { min: null, max: null, text: raw, ok: false };
    return { min: Math.min(a, b), max: Math.max(a, b), text: raw, ok: true };
  }
  return { min: null, max: null, text: raw, ok: false };
}

/** Quarter text like "Q1", "Q1 2023", "Q1-23", "Jan-Mar 2023". Returns quarter number and optional year. */
export function quarter(s: string | null): { q: number; year: number | null } | null {
  if (!s) return null;
  const m = s.match(/q\s*([1-4])(?:[\s\-'’/,]*(?:fy)?\s*(\d{2}|\d{4}))?/i);
  if (m) return { q: +m[1], year: m[2] ? (m[2].length === 2 ? 2000 + +m[2] : +m[2]) : null };
  return null;
}

/** Month text like "Jan", "January", "Jan-23", "Jan 2023". */
export function month(s: string | null): { m: number; year: number | null } | null {
  if (!s) return null;
  const m = s.trim().match(/^([A-Za-z]{3,9})\.?(?:[\s\-'’/,]*(\d{2}|\d{4}))?$/);
  if (m && MONTHS[m[1].toLowerCase()]) return { m: MONTHS[m[1].toLowerCase()], year: m[2] ? (m[2].length === 2 ? 2000 + +m[2] : +m[2]) : null };
  return null;
}

export function monthBounds(year: number, m: number) {
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { start: `${pad(year, 4)}-${pad(m)}-01`, end: `${pad(year, 4)}-${pad(m)}-${pad(last)}` };
}
export function quarterBounds(year: number, q: number) {
  const sm = (q - 1) * 3 + 1;
  return { start: monthBounds(year, sm).start, end: monthBounds(year, sm + 2).end };
}
export function yearBounds(year: number) {
  return { start: `${pad(year, 4)}-01-01`, end: `${pad(year, 4)}-12-31` };
}

/** Column index (0-based) to spreadsheet letter. */
export function colLetter(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Size classification from TYPED area (spec: strictly >min and <max; boundary cases preserved for review;
 * rows below the small band are classified, never discarded). Filename is never a size filter.
 */
export function classifySize(area: number | null | undefined, rules: SizeRules): SizeClass {
  if (area === null || area === undefined || !Number.isFinite(area) || area <= 0) return "unknown";
  if (area === rules.min_exclusive_sf) return "boundary_min";
  if (area === rules.max_exclusive_sf) return "boundary_max";
  if (area < rules.min_exclusive_sf) return "below_min";
  if (area > rules.max_exclusive_sf) return "above_max";
  return area < rules.small_band_below_sf ? "in_scope_small" : "in_scope";
}

/** Year from a filename label, e.g. "Transaction Tracker 2022-Pivot Table.xlsx" => 2022 (used only as a labelled fallback). */
export function yearFromLabel(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = s.match(/(?:^|[^0-9])(20\d{2})(?:[^0-9]|$)/);
  return m ? +m[1] : null;
}
