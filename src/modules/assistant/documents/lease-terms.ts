import Decimal from "decimal.js";
import { z } from "zod";

/**
 * Lease / LOI / term-sheet term extraction — the deterministic half. The model (or the mock heuristic) only points at
 * WHERE a term is (page + verbatim snippet); this file verifies the snippet really occurs on that page and parses
 * numbers/dates out of the verified snippet with typed code (S5: no LLM arithmetic, S6: unknown stays unknown).
 */
export const LEASE_FIELDS = [
  "parties", "premises", "area", "rent", "escalation", "lock_in", "term", "start_date", "expiry_date", "rent_commencement_date",
  "notice", "deposit", "cam", "parking", "fit_out", "renewal", "special_clauses",
] as const;
export type LeaseField = (typeof LEASE_FIELDS)[number];

export const FIELD_LABEL: Record<LeaseField, string> = {
  parties: "Parties", premises: "Premises", area: "Area + basis", rent: "Rent", escalation: "Escalation", lock_in: "Lock-in", term: "Term",
  start_date: "Start / commencement date", expiry_date: "Expiry date", rent_commencement_date: "Rent commencement date", notice: "Notice period",
  deposit: "Security deposit", cam: "CAM / maintenance", parking: "Parking", fit_out: "Fit-out / rent-free", renewal: "Renewal options", special_clauses: "Special clauses",
};

/** What the model returns: a pointer per field. */
export const ModelTermsSchema = z.object({
  fields: z.array(z.object({
    field: z.enum(LEASE_FIELDS),
    value: z.string().max(400).nullable(),
    page: z.number().int().min(1).nullable(),
    snippet: z.string().max(400).nullable(),
    confidence: z.number().min(0).max(1),
  })).max(40),
});
export type ModelTerms = z.infer<typeof ModelTermsSchema>;

export type Normalised =
  | { kind: "date"; iso: string }
  | { kind: "months"; months: number }
  | { kind: "area"; sf: string; basis: string; unit: "sf" | "sqm" }
  | { kind: "money"; amount: string; unit: "per_sf_per_month" | "per_sf" | "per_month" | "per_annum" | "lump_sum" | "unknown" }
  | { kind: "percent"; percent: string; everyMonths: number | null }
  | { kind: "deposit"; months: number | null; amount: string | null }
  | { kind: "count"; count: number }
  | null;

export interface ExtractedTerm {
  field: LeaseField;
  raw: string | null;          // model/heuristic value text (untrusted)
  page: number | null;
  snippet: string | null;      // verified verbatim (≤25 words) or null
  confidence: number;
  verified: boolean;
  flag: null | "snippet_not_found" | "page_corrected" | "snippet_truncated" | "value_not_in_snippet" | "no_page_text";
  normalised: Normalised;
}

// ------------------------------------------------------------------------------------------------ text helpers
const norm = (s: string) => s.replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"').replace(/[–—]/g, "-")
  .replace(/\s+/g, " ").trim().toLowerCase();
export const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
export function clipWords(s: string, n = 25) { const w = words(s); return w.length <= n ? w.join(" ") : w.slice(0, n).join(" "); }

/** Does `snippet` occur (whitespace/quote/case-insensitive) in `page`? */
export function occursIn(snippet: string, page: string) { const a = norm(snippet); return !!a && norm(page).includes(a); }

/**
 * Anti-hallucination: the snippet must occur verbatim on the stated page. If it occurs on a different page the page is
 * corrected (flagged); if it occurs nowhere the snippet AND value are dropped (unknown) and flagged.
 */
export function verifyTerm(t: ModelTerms["fields"][number], pages: string[]): ExtractedTerm {
  const base = { field: t.field, raw: t.value, confidence: t.confidence };
  if (!pages.some((p) => p.trim())) return { ...base, page: null, snippet: null, verified: false, flag: "no_page_text", normalised: null, confidence: 0 };
  if (!t.snippet?.trim()) return { ...base, raw: null, page: null, snippet: null, verified: false, flag: t.value ? "snippet_not_found" : null, normalised: null, confidence: 0 };
  let snip = t.snippet.trim(); let flag: ExtractedTerm["flag"] = null;
  if (words(snip).length > 25) { snip = clipWords(snip); flag = "snippet_truncated"; }
  const stated = t.page && t.page <= pages.length ? t.page : null;
  let page: number | null = null;
  if (stated && occursIn(snip, pages[stated - 1])) page = stated;
  else {
    const k = pages.findIndex((p) => occursIn(snip, p));
    if (k >= 0) { page = k + 1; flag = "page_corrected"; }
  }
  if (!page) return { ...base, raw: null, page: null, snippet: null, verified: false, flag: "snippet_not_found", normalised: null, confidence: 0 };
  const normalised = normaliseField(t.field, snip);
  const numericField = !["parties", "premises", "fit_out", "renewal", "special_clauses"].includes(t.field);
  return { ...base, page, snippet: snip, verified: true, flag: flag ?? (numericField && !normalised ? "value_not_in_snippet" : null), normalised, confidence: t.confidence };
}

// ------------------------------------------------------------------------------------------------ deterministic parsers
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function mkDate(y: number, m: number, d: number): string | null {
  if (y < 1950 || y > 2150 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}
/** Dates in Indian documents: ISO, dd/mm/yyyy (day first), "1st April 2025", "April 1, 2025", "01-Apr-2025". */
export function parseDate(s: string): string | null {
  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return mkDate(+m[1], +m[2], +m[3]);
  m = s.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
  if (m) return mkDate(+m[3], +m[2], +m[1]);
  m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+day\s+of)?[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{4})\b/);
  if (m) { const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); if (mi >= 0) return mkDate(+m[3], mi + 1, +m[1]); }
  m = s.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (m) { const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); if (mi >= 0) return mkDate(+m[3], mi + 1, +m[2]); }
  return null;
}
const num = (x: string) => new Decimal(x.replace(/,/g, ""));
/** "36 months", "three (3) years", "5 yrs" → months. */
export function parseMonths(s: string): number | null {
  const m = s.match(/\(?(\d+(?:\.\d+)?)\)?\s*(months?|years?|yrs?)\b/i);
  if (!m) return null;
  const n = num(m[1]);
  return (/^y/i.test(m[2]) ? n.mul(12) : n).toNumber();
}
/** INR amount: "Rs. 1,25,000", "₹ 85", "INR 2.5 lakh", "1.2 crore". Returns a decimal string in rupees. */
export function parseInr(s: string): string | null {
  const m = s.match(/(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr\b)?/i) ?? s.match(/\b([\d,]+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?)\b/i);
  if (!m) return null;
  let n = num(m[1]);
  if (m[2]) n = /^c/i.test(m[2]) ? n.mul(10_000_000) : n.mul(100_000);
  return n.toFixed();
}
export function rentUnit(s: string): Extract<Normalised, { kind: "money" }>["unit"] {
  const l = s.toLowerCase();
  const perSf = /(per|\/)\s*(sq\.?\s*ft|sft|square\s*f(oo|ee)t)|\bpsf\b/.test(l);
  const month = /per\s*month|\/\s*month|monthly|p\.?\s*m\.?\b/.test(l);
  const annum = /per\s*(annum|year)|annual|p\.?\s*a\.?\b/.test(l);
  if (perSf && month) return "per_sf_per_month";
  if (perSf) return "per_sf";
  if (month) return "per_month";
  if (annum) return "per_annum";
  return "unknown";
}
export function parseArea(s: string): Extract<Normalised, { kind: "area" }> | null {
  const m = s.match(/([\d,]+(?:\.\d+)?)\s*(sq\.?\s*ft\.?|sft|square\s*f(?:ee|oo)t|sq\.?\s*m(?:trs?|eters?|etres?)?\.?|square\s*met(?:er|re)s?)/i);
  if (!m) return null;
  const sqm = /sq\.?\s*m|square\s*met/i.test(m[2]) && !/ft|feet|foot/i.test(m[2]);
  const v = num(m[1]);
  const l = s.toLowerCase();
  const basis = /super\s*built|super\s*area|sba\b/.test(l) ? "super_built_up" : /chargeable|leasable/.test(l) ? "chargeable" : /carpet/.test(l) ? "carpet" : /built[\s-]*up/.test(l) ? "built_up" : "unknown";
  return { kind: "area", sf: (sqm ? v.mul("10.7639") : v).toDecimalPlaces(2).toFixed(), basis, unit: sqm ? "sqm" : "sf" };
}
export function parsePercent(s: string): Extract<Normalised, { kind: "percent" }> | null {
  const m = s.match(/(\d+(?:\.\d+)?)\s*(%|per\s*cent|percent)/i);
  if (!m) return null;
  let every: number | null = null;
  const e = s.match(/every\s+(\w+)\s*\(?(\d+)?\)?\s*(years?|months?)/i);
  if (e) { const n = e[2] ? +e[2] : ({ one: 1, two: 2, three: 3, four: 4, five: 5 } as Record<string, number>)[e[1].toLowerCase()] ?? (/^\d+$/.test(e[1]) ? +e[1] : null); if (n) every = /^y/i.test(e[3]) ? n * 12 : n; }
  else if (/annual|every\s+year|per\s+annum|each\s+year|yearly/i.test(s)) every = 12;
  return { kind: "percent", percent: num(m[1]).toFixed(), everyMonths: every };
}

export function normaliseField(field: LeaseField, s: string): Normalised {
  switch (field) {
    case "start_date": case "expiry_date": case "rent_commencement_date": { const d = parseDate(s); return d ? { kind: "date", iso: d } : null; }
    case "lock_in": case "term": case "notice": { const m = parseMonths(s); return m === null ? null : { kind: "months", months: m }; }
    case "area": return parseArea(s);
    case "rent": case "cam": { const a = parseInr(s); return a ? { kind: "money", amount: a, unit: rentUnit(s) } : null; }
    case "escalation": return parsePercent(s);
    case "deposit": {
      const mm = s.match(/\(?(\d+)\)?\s*months?'?\s*(?:of\s*)?(?:rent|deposit|security)/i) ?? s.match(/(?:equivalent to|equal to)\s*\w*\s*\(?(\d+)\)?\s*months?/i);
      const amt = parseInr(s);
      return mm || amt ? { kind: "deposit", months: mm ? +mm[1] : null, amount: amt } : null;
    }
    case "parking": { const m = s.match(/\(?(\d+)\)?\s*(?:\w+\s+){0,2}(?:car\s*)?(?:parking|slots?|bays?|spaces?)/i); return m ? { kind: "count", count: +m[1] } : null; }
    default: return null;
  }
}

export function displayNormalised(n: Normalised): string | null {
  if (!n) return null;
  switch (n.kind) {
    case "date": return n.iso;
    case "months": return `${n.months} months`;
    case "area": return `${n.sf} sf (${n.basis.replace(/_/g, " ")})${n.unit === "sqm" ? " — converted from sq m" : ""}`;
    case "money": return `₹${n.amount} ${n.unit === "unknown" ? "(basis unknown)" : n.unit.replace(/_/g, " ")}`;
    case "percent": return `${n.percent}%${n.everyMonths ? ` every ${n.everyMonths} months` : ""}`;
    case "deposit": return [n.months !== null ? `${n.months} months' rent` : null, n.amount ? `₹${n.amount}` : null].filter(Boolean).join(" / ");
    case "count": return `${n.count}`;
  }
}

// ------------------------------------------------------------------------------------------------ deterministic mock (no API key)
const CUES: Record<LeaseField, RegExp> = {
  parties: /\bbetween\b.*\band\b|\blessor\b.*\blessee\b|\blandlord\b.*\btenant\b/i,
  premises: /\bpremises\b|\bunit\b.*\bfloor\b|\bfloor\b.*\btower\b/i,
  area: /\d[\d,]*\s*(sq\.?\s*ft|sft|square\s*feet|sq\.?\s*m)/i,
  rent: /\brent\b.*(₹|rs\.?|inr)|\b(₹|rs\.?|inr)\b.*\brent\b/i,
  escalation: /escalat|increase.*\d+\s*%|\d+\s*%.*increase/i,
  lock_in: /lock[\s-]*in/i,
  term: /^(?!.*lock[\s-]*in)(?!.*notice).*\b(term|tenure|period)\b.*\(?\d+\)?\s*(years?|months?)/i,
  start_date: /\b(commencement|start|effective)\s+date\b/i,
  expiry_date: /\b(expir\w*|end\s+date|terminat\w*\s+on)\b/i,
  rent_commencement_date: /rent[\s-]*(commencement|free\s+period\s+ends|start)/i,
  notice: /\bnotice\b.*\(?\d+\)?\s*(months?|days?)/i,
  deposit: /security\s+deposit|\bdeposit\b|\bIFRSD\b/i,
  cam: /\bCAM\b|common\s+area\s+maintenance|maintenance\s+charges?/i,
  parking: /\bparking\b|car\s+park/i,
  fit_out: /fit[\s-]*out|rent[\s-]*free|interior/i,
  renewal: /\brenew/i,
  special_clauses: /\b(right\s+of\s+first|ROFR|ROFO|exclusiv|sub[\s-]*let|assign)/i,
};
const SENTENCE = /(?<=(?<!\b(?:sq|rs|no|nos|pvt|ltd|ft|st|approx|viz|e\.g|i\.e|mr|ms|dr|co))[.;])\s+|\n+/i;
/** Sentence-level heuristic: first sentence matching a cue, snippet = its first 25 words (verbatim). */
export function heuristicTerms(pages: string[]): ModelTerms {
  const out: ModelTerms["fields"] = [];
  for (const f of LEASE_FIELDS) {
    let hit: { page: number; s: string } | null = null;
    for (let p = 0; p < pages.length && !hit; p++) {
      const sentences = pages[p].split(SENTENCE).map((x) => x.trim()).filter(Boolean);
      const s = sentences.find((x) => CUES[f].test(x));
      if (s) hit = { page: p + 1, s };
    }
    if (hit) { const snip = clipWords(hit.s); out.push({ field: f, value: snip, page: hit.page, snippet: snip, confidence: 0.4 }); }
  }
  return { fields: out };
}

export function pagesForPrompt(pages: string[], maxChars = 60_000): string {
  let left = maxChars; const parts: string[] = [];
  for (let i = 0; i < pages.length && left > 0; i++) { const t = pages[i].slice(0, left); parts.push(`<page n="${i + 1}">\n${t}\n</page>`); left -= t.length; }
  return parts.join("\n");
}

/** Run verification over a model/heuristic result; every field appears exactly once (unknown when absent). */
export function finaliseTerms(model: ModelTerms, pages: string[]): ExtractedTerm[] {
  const best = new Map<LeaseField, ExtractedTerm>();
  for (const f of model.fields) {
    const v = verifyTerm(f, pages);
    const prev = best.get(f.field);
    if (!prev || (!prev.verified && v.verified) || (prev.verified === v.verified && v.confidence > prev.confidence)) best.set(f.field, v);
  }
  return LEASE_FIELDS.map((f) => best.get(f) ?? { field: f, raw: null, page: null, snippet: null, confidence: 0, verified: false, flag: null, normalised: null });
}

// ------------------------------------------------------------------------------------------------ lease record mapping
/** Extracted term → lease column (only fields with a lease column; the rest are reported, not written). */
export function leasePatchFromTerms(terms: ExtractedTerm[]): { column: string; value: string | number; field: LeaseField }[] {
  const out: { column: string; value: string | number; field: LeaseField }[] = [];
  const get = (f: LeaseField) => terms.find((t) => t.field === f && t.verified && t.normalised);
  const area = get("area")?.normalised;
  if (area?.kind === "area") { out.push({ column: "area_sf", value: area.sf, field: "area" }); if (area.basis !== "unknown") out.push({ column: "area_basis", value: area.basis, field: "area" }); }
  const rent = get("rent")?.normalised;
  if (rent?.kind === "money" && (rent.unit === "per_sf_per_month" || rent.unit === "per_sf")) { out.push({ column: "rent_per_sf", value: rent.amount, field: "rent" }); out.push({ column: "rent_basis", value: rent.unit === "per_sf_per_month" ? "per_sf_per_month" : "per_sf", field: "rent" }); }
  for (const [f, col] of [["start_date", "start_date"], ["expiry_date", "contractual_expiry"]] as const) { const n = get(f)?.normalised; if (n?.kind === "date") out.push({ column: col, value: n.iso, field: f }); }
  for (const [f, col] of [["term", "tenure_months_raw"], ["lock_in", "lockin_months_raw"]] as const) { const n = get(f)?.normalised; if (n?.kind === "months") out.push({ column: col, value: n.months, field: f }); }
  return out;
}
