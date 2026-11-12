import { edate } from "@/lib/util/time";
import type { AccountFilter } from "./filter";

/**
 * Deterministic natural-language → AccountFilter parser (runs before any model). Recognises:
 * area ranges (15,000–40,000 SF · 15k-40k sq ft · between 15k and 40k sqft · over/under N sf), area basis,
 * places from the workspace geography list, building grade, lease event types and windows ('next year',
 * 'within 6 months'), 'contact I already know', sectors, signal kinds/since, lead priority band, requirement status
 * and open deals. Returns the filter plus the phrases it understood so the UI can show them as chips.
 */
export interface Place { name: string; aliases?: string[] | null }
export interface ParseResult { filter: AccountFilter; understood: string[]; /** phrases recognised but not filterable (shown, never guessed) */ notFiltered?: string[] }

const NUM = String.raw`(\d{1,3}(?:,\d{2,3})+|\d+(?:\.\d+)?)\s*(k|thousand|lakh|lac)?`;
const UNIT = String.raw`(?:sf|sq\.?\s*ft\.?|sqft|square\s+feet|sft)`;

function toNum(n: string, mult?: string): number {
  const v = Number(n.replace(/,/g, ""));
  const m = (mult ?? "").toLowerCase();
  return m === "k" || m === "thousand" ? v * 1000 : m === "lakh" || m === "lac" ? v * 100000 : v;
}

const SECTORS: [RegExp, string][] = [
  [/\b(it|ites|software|tech(?:nology)?)\b(?=\s+(?:compan|firm|occupier|tenant|sector|services))/i, "IT"],
  [/\bbfsi\b|\bbank(?:ing|s)?\b|\bfinancial services\b/i, "BFSI"],
  [/\bpharma(?:ceutical)?s?\b|\blife sciences?\b/i, "Pharma"],
  [/\bauto(?:motive)?\b/i, "Automotive"],
  [/\bmanufactur(?:ing|ers?)\b/i, "Manufacturing"],
  [/\bconsult(?:ing|ancy|ancies)\b/i, "Consulting"],
  [/\bengineering\b/i, "Engineering"],
  [/\be-?commerce\b|\bretail\b/i, "Retail"],
  [/\bfintech\b|\binsurance\b|\bnbfc\b/i, "BFSI"],
  [/\bhealth\s?care\b|\bhospitals?\b|\bmedtech\b/i, "Healthcare"],
  [/\btelecom(?:munications?)?\b/i, "Telecom"],
  [/\blogistics\b|\bwarehousing\b|\b3pl\b/i, "Logistics"],
  [/\bsemiconductors?\b|\bchip\s+design\b/i, "Semiconductor"],
  [/\bedtech\b|\beducation\b/i, "Education"],
  [/\bgccs?\b(?!\s*(?:plan|set[\s-]?up|entry|launch))|\bglobal\s+capabilit(?:y|ies)\s+cent(?:er|re)s?\b|\bcaptives?\b/i, "GCC"],
  [/\b(?:it|ites|tech)\s+(?:cos|parks?)\b|^\s*it\b/i, "IT"],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseAccountQuery(text: string, places: Place[], today: string): ParseResult {
  let m0: RegExpExecArray | null;
  const t = ` ${text.replace(/[–—]/g, "-").replace(/\s+/g, " ")} `;
  const f: AccountFilter = {};
  const u: string[] = [];

  // ---- area
  const range = new RegExp(String.raw`(?:between\s+)?${NUM}\s*${UNIT}?\s*(?:-|to|and)\s*${NUM}\s*${UNIT}`, "i").exec(t);
  if (range) {
    let a = toNum(range[1], range[2]); let b = toNum(range[3], range[4] ?? range[2]);
    if (!range[2] && range[4] && a < 1000) a = toNum(range[1], range[4]); // "15-40k sf"
    if (a > b) [a, b] = [b, a];
    f.areaMinSf = a; f.areaMaxSf = b; u.push(range[0].trim());
  } else {
    const min = new RegExp(String.raw`(?:over|above|more than|at least|min(?:imum)?|>=?)\s*${NUM}\s*${UNIT}`, "i").exec(t);
    const max = new RegExp(String.raw`(?:under|below|less than|up to|upto|at most|max(?:imum)?|<=?)\s*${NUM}\s*${UNIT}`, "i").exec(t);
    if (min) { f.areaMinSf = toNum(min[1], min[2]); u.push(min[0].trim()); }
    if (max) { f.areaMaxSf = toNum(max[1], max[2]); u.push(max[0].trim()); }
  }
  const notFiltered: string[] = [];
  if (f.areaMinSf === undefined && f.areaMaxSf === undefined) {
    const approx = new RegExp(String.raw`(?:around|about|approx(?:imately|\.)?|~|roughly|close to)?\s*${NUM}\s*${UNIT}`, "i").exec(t);
    if (approx) {  // "Baner 20k sf" → ±20% band around the stated size (the band is shown as a chip; nothing is stored)
      const v = toNum(approx[1], approx[2]);
      if (v >= 500) { f.areaMinSf = Math.round(v * 0.8); f.areaMaxSf = Math.round(v * 1.2); u.push(approx[0].trim()); }
    }
  }
  const seats = new RegExp(String.raw`(?:${NUM}|\d+)\s*\+?\s*(?:seats?|employees|people|headcount|staff|fte)\b|\bheadcount\s+(?:of\s+)?${NUM}`, "i").exec(t);
  if (seats) notFiltered.push(`${seats[0].trim()} (headcount is not stored on accounts — add area instead)`);
  const basis = /\b(chargeable|carpet|super[\s-]?built[\s-]?up|built[\s-]?up)\b/i.exec(t);
  if (basis) {
    const b = basis[1].toLowerCase().replace(/[\s-]/g, "");
    f.areaBasis = b === "chargeable" ? "chargeable" : b === "carpet" ? "carpet" : b.startsWith("super") ? "super_builtup" : "builtup";
    u.push(basis[0]);
  }

  // ---- places (longest names first so "Kharadi East" beats "Kharadi")
  const cands = places.flatMap((p) => [p.name, ...(p.aliases ?? [])].filter((n) => n && n.length >= 3).map((n) => ({ n, canon: p.name })))
    .sort((a, b) => b.n.length - a.n.length);
  const found = new Set<string>(); let rest = t;
  for (const c of cands) {
    const re = new RegExp(String.raw`(^|[^\p{L}\p{N}])${escapeRe(c.n)}(?=[^\p{L}\p{N}]|$)`, "iu");
    if (re.test(rest)) { found.add(c.canon); rest = rest.replace(re, "$1 "); u.push(c.n); }
  }
  if (found.size) f.places = [...found];

  // ---- grade
  const grade = /\bgrade\s*-?\s*(a\+|a|b\+|b|c)(?![\p{L}])/iu.exec(t) ?? /\b(a\+|a|b\+|b)\s*-?\s*grade\b/i.exec(t);
  if (grade) { f.grades = [grade[1].toUpperCase()]; u.push(grade[0]); }
  else if ((m0 = /\b(premium|institutional)\s+(?:buildings?|offices?|assets?|stock)\b/i.exec(t))) { f.grades = ["A+", "A"]; u.push(m0[0]); }

  // ---- lease events + windows
  const types = new Set<NonNullable<AccountFilter["eventTypes"]>[number]>();
  if (/\b(expir(?:y|ing|es|ation)|renewals?)\b/i.test(t)) types.add("expiry");
  if (/\block[\s-]?in\b/i.test(t)) types.add("lockin_end");
  if (/\bnotice\b/i.test(t)) types.add("notice_deadline");
  if (/\bbreak(?:\s+option|\s+clause)?\b/i.test(t)) types.add("break");
  const anyEvent = /\blease\s+events?\b/i.test(t);
  if (types.size && !anyEvent) { f.eventTypes = [...types]; u.push(`lease ${[...types].join("/")}`); }
  else if (anyEvent) u.push("lease event");

  let m: RegExpExecArray | null;
  if ((m = /\b(?:within|in|over)\s+(?:the\s+)?(?:next\s+)?(\d{1,3}|a|one|two|three|six|twelve)\s+(months?|years?)\b/i.exec(t))
      ?? (m = /\bnext\s+(\d{1,3}|two|three|six|twelve)\s+(months?|years?)\b/i.exec(t))) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, six: 6, twelve: 12 };
    const n = words[m[1].toLowerCase()] ?? Number(m[1]);
    f.eventWindow = { kind: "within_months", months: Math.min(120, /year/i.test(m[2]) ? n * 12 : n) }; u.push(m[0]);
  } else if ((m = /\bnext\s+(?:calendar\s+)?year\b/i.exec(t))) {
    f.eventWindow = { kind: "next_calendar_year" }; u.push(m[0]);
  } else if ((m = /\b(?:this|current)\s+(?:calendar\s+)?year\b/i.exec(t))) {
    f.eventWindow = { kind: "this_calendar_year" }; u.push(m[0]);
  } else if ((m = /\bq([1-4])\s*(?:fy\s*)?'?(20\d\d|\d\d)\b/i.exec(t))) {
    const y = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]); const q = Number(m[1]);
    const from = `${y}-${String(q * 3 - 2).padStart(2, "0")}-01`;
    const to = new Date(Date.parse(edate(from, 3) + "T00:00:00Z") - 864e5).toISOString().slice(0, 10);
    f.eventWindow = { kind: "between", from, to }; u.push(m[0]);
  } else if ((m = /\b(?:by|before|until|till)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(20\d\d)\b/i.exec(t))) {
    const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[1].toLowerCase().slice(0, 3)) + 1;
    const first = `${m[2]}-${String(mon).padStart(2, "0")}-01`;
    const to = new Date(Date.parse(edate(first, 1) + "T00:00:00Z") - 864e5).toISOString().slice(0, 10);
    if (to >= today) { f.eventWindow = { kind: "between", from: today, to }; u.push(m[0]); }
  } else if ((m = /\bfy\s*'?(\d{2}|20\d\d)\b/i.exec(t)) && (types.size || anyEvent)) {  // Indian FY: Apr–Mar, FY27 = Apr 2026–Mar 2027
    const end = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
    f.eventWindow = { kind: "between", from: `${end - 1}-04-01`, to: `${end}-03-31` }; u.push(m[0]);
  } else if ((m = /\b(?:in|during)\s+(20\d\d)\b/.exec(t)) && (types.size || anyEvent)) {
    f.eventWindow = { kind: "between", from: `${m[1]}-01-01`, to: `${m[1]}-12-31` }; u.push(m[0]);
  }
  if (anyEvent && !f.eventWindow) f.eventWindow = { kind: "within_months", months: 12 };
  if (f.eventWindow && !f.eventTypes && !anyEvent) { /* window only applies to lease events if asked */
    if (!/\blease|expir|lock|notice|break|renewal/i.test(t)) delete f.eventWindow;
  }

  // ---- known contact
  if ((m = /\b(?:contacts?|someone|people|person)\s+(?:that\s+|whom\s+)?i\s+(?:already\s+)?know\b|\bknown\s+contacts?\b|\bi\s+know\s+someone\b|\bwarm\s+(?:contact|intro|relationship)s?\b/i.exec(t))) {
    f.knownContact = true; u.push(m[0]);
  }

  // ---- sectors
  const sectors = SECTORS.filter(([re]) => re.test(t)).map(([, s]) => s);
  if (sectors.length) { f.sectors = [...new Set(sectors)]; u.push(...sectors); }

  // ---- signals
  if ((m = /\b(?:new\s+|planned\s+|upcoming\s+)?gccs?\s*(?:plan|set[\s-]?up|entry|launch)s?\b|\bsetting\s+up\s+(?:a\s+)?gcc\b/i.exec(t))) { f.signalKinds = ["gcc"]; u.push(m[0]); }
  else if ((m = /\b(?:hiring|headcount\s+growth|growing\s+headcount|expanding|expansion)\b/i.exec(t))) { f.signalKinds = [/hir|headcount/i.test(m[0]) ? "hiring" : "expansion"]; u.push(m[0]); }
  if (f.signalKinds) { /* set above */ }
  else if ((m = /\b([a-z]+)\s+signals?\b/i.exec(t)) && !/^(a|any|new|recent|the|with)$/i.test(m[1])) { f.signalKinds = [m[1].toLowerCase()]; u.push(m[0]); }
  else if (/\b(?:with|has|having)\s+(?:a\s+|any\s+)?(?:new\s+|recent\s+)?signals?\b/i.test(t)) f.signalSince = edate(today, -3);
  if ((m = /\bsignals?\b[^.]*?\bsince\s+(\d{4}-\d{2}-\d{2})/i.exec(t))) { f.signalSince = m[1]; u.push(m[0]); }
  else if ((m = /\bsignals?\b[^.]*?\b(?:in\s+the\s+)?(?:last|past)\s+(\d{1,2})\s+months?\b/i.exec(t))) { f.signalSince = edate(today, -Number(m[1])); u.push(m[0]); }

  // ---- priority / requirement / deal
  if ((m = /\bvery\s+high\s+(?:priority|score)\b/i.exec(t))) { f.scoreBands = ["Very High"]; u.push(m[0]); }
  else if ((m = /\b(?:high[\s-]priority|hot\s+leads?|high\s+score)\b/i.exec(t))) { f.scoreBands = ["Very High", "High"]; u.push(m[0]); }
  if ((m = /\bconfirmed\s+requirements?\b/i.exec(t))) { f.requirementStatuses = ["client_confirmed"]; u.push(m[0]); }
  else if ((m = /\b(?:open|active|live)\s+requirements?\b|\bwith\s+a\s+requirement\b/i.exec(t))) { f.requirementStatuses = ["draft", "estimated", "client_confirmed"]; u.push(m[0]); }
  if ((m = /\b(?:no|without)\s+(?:an?\s+)?(?:open\s+)?(?:deal|opportunit(?:y|ies))\b/i.exec(t))) { f.hasOpenOpportunity = false; u.push(m[0]); }
  else if ((m = /\b(?:open|active|live)\s+(?:deal|opportunit(?:y|ies))s?\b/i.exec(t))) { f.hasOpenOpportunity = true; u.push(m[0]); }

  return { filter: f, understood: u.map((s) => s.trim()).filter(Boolean), ...(notFiltered.length ? { notFiltered } : {}) };
}
