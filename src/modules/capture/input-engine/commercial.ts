/**
 * Commercial term extraction (spec §4.2, §4.3, §15 rules 2–5). Pure and deterministic.
 * Every term keeps its verbatim wording and source position. Nothing is converted or assumed:
 *  - carpet / chargeable / super built-up area are separate keys; an area without a stated basis is basis "unknown";
 *  - a rent is never assumed to include CAM (cam = "unknown" unless the text says included/extra);
 *  - a missing unit / period stays null and is listed in `missing` (never 0, never defaulted);
 *  - dates are classed confirmed (contractual, full date) / estimated (approximate) / informal (month or weekday only).
 */
export const TERM_KEYS = [
  "carpet_area", "chargeable_area", "super_built_up_area", "area", "rent_psf", "monthly_rent", "annual_rent", "budget",
  "cam", "security_deposit", "rent_free", "lock_in", "lease_duration", "escalation", "notice_period", "fitout_cost", "brokerage", "parking",
] as const;
export type TermKey = (typeof TERM_KEYS)[number];
export type AreaBasis = "carpet" | "chargeable" | "super_built_up" | "unknown";
export type CamTreatment = "included" | "extra" | "unknown";
export type DateClass = "confirmed" | "estimated" | "informal";

export interface CommercialTerm {
  key: TermKey;
  raw_text: string;                 // verbatim
  value: number | null;             // as stated (lakh/crore multipliers applied, nothing else)
  unit: string | null;              // sf | INR | INR/sf/month | INR/month | INR/year | months | % | days | null
  pricing_basis: string | null;     // per_sf_month | per_seat_month | total_month | total_year | null (unknown)
  area_basis: AreaBasis | null;     // only for area keys
  cam: CamTreatment | null;         // only for rent / budget keys
  approximate: boolean;
  missing: string[];
  page: number | null;              // 1-based when the source has pages (form-feed separated)
  start: number; end: number;
}

const NUM = String.raw`(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(lakhs?|lacs?|l|crores?|cr|k)?\b`;
const MULT: Record<string, number> = { lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, k: 1e3 };
const AREA_UNIT = String.raw`(?:sq\.?\s?ft\.?|sqft|sft|sf|square\s+f(?:ee|oo)t|sq\.?\s?feet|feet|ft)`;
const PSF = String.raw`(?:per\s+sq\.?\s?ft\.?|per\s+square\s+f(?:oo|ee)t|psf|\/\s?sq\.?\s?ft\.?|\/\s?sft|\/\s?sf|per\s+sft|per\s+sf)`;
const APPROX = /\b(around|approx(?:imately)?|about|roughly|~|nearly|close to|lagbhag|takriban|expected|tentative(?:ly)?|likely|estimated?)\b/i;
const CUR = String.raw`(?:₹|rs\.?|inr)`;

function num(raw: string, mult?: string): number {
  const n = Number(raw.replace(/,/g, ""));
  return mult ? n * (MULT[mult.toLowerCase()] ?? 1) : n;
}

/** Page number (1-based) of an offset in form-feed-separated text; null if the text has no page breaks. */
export function pageAt(text: string, offset: number): number | null {
  if (!text.includes("\f")) return null;
  let p = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\f") p++;
  return p;
}

function camNear(text: string, start: number, end: number): CamTreatment {
  const win = text.slice(Math.max(0, start - 60), Math.min(text.length, end + 80)).toLowerCase();
  if (/\b(incl(?:usive|uding|\.)?\s*(?:of\s+)?cam|cam\s+incl(?:uded|usive)|with\s+cam|all[- ]inclusive)\b/.test(win)) return "included";
  if (/\b(plus\s+cam|\+\s*cam|cam\s+(?:extra|additional|separate|payable|charged)|excl(?:usive|uding|\.)?\s*(?:of\s+)?cam|cam\s+will\s+be\s+extra|cam\s+@)/.test(win)) return "extra";
  return "unknown";
}

function areaBasisNear(text: string, start: number): AreaBasis {
  // nearest label in the same clause: words before the number first, then words right after it
  const back = text.slice(Math.max(0, start - 40), start);
  const before = back.slice(Math.max(back.lastIndexOf(";"), back.lastIndexOf("\n"), back.search(/\.\s[^.]*$/)) + 1).toLowerCase();
  const fwd = text.slice(start, start + 45);
  const cut = fwd.search(/[;\n]|\.\s|,\s/);
  const after = (cut >= 0 ? fwd.slice(0, cut) : fwd).toLowerCase();
  const pick = (w: string): AreaBasis | null =>
    /super\s*built[- ]?up|\bsba\b|\bsuper area\b/.test(w) ? "super_built_up" : /chargeable|leasable|saleable|\bbua\b|built[- ]?up/.test(w) ? "chargeable" : /carpet|usable/.test(w) ? "carpet" : null;
  return pick(before) ?? pick(after) ?? "unknown";
}

function periodNear(text: string, end: number): "month" | "year" | null {
  const after = text.slice(end, end + 25).toLowerCase();
  if (/^\s*(?:\/|per|a|p\.?)\s*(?:month|mo\b|m\b|pm\b)|^\s*p\.?m\.?\b|^\s*monthly/.test(after)) return "month";
  if (/^\s*(?:\/|per|a|p\.?)\s*(?:year|annum|yr|a\b)|^\s*p\.?a\.?\b|^\s*annual/.test(after)) return "year";
  return null;
}

/** Extract commercial terms from free text (notes, OCR, documents). */
export function extractCommercialTerms(text: string): CommercialTerm[] {
  const out: CommercialTerm[] = [];
  const seen = new Set<string>();
  const push = (t: Omit<CommercialTerm, "page" | "approximate"> & { approximate?: boolean }) => {
    const k = `${t.start}:${t.end}`;
    if (seen.has(k) || out.some((o) => t.start < o.end && o.start < t.end)) return;
    seen.add(k);
    const ctx = text.slice(Math.max(0, t.start - 30), t.end);
    out.push({ ...t, approximate: t.approximate ?? APPROX.test(ctx), page: pageAt(text, t.start) });
  };

  // ---- rent per sq ft: "rent ₹95/sf", "Rs. 85 per sq ft per month", "quoted 95 psf + CAM"
  for (const m of text.matchAll(new RegExp(String.raw`(?:${CUR}\s*)?${NUM}\s*${PSF}(?:\s*(?:per\s+month|\/\s?month|pm|p\.m\.|per\s+annum|p\.a\.))?`, "gi"))) {
    const s = m.index!, e = s + m[0].length;
    const lead = text.slice(Math.max(0, s - 30), s).toLowerCase();
    const isCam = /\bcam\b[^\d]{0,12}$/.test(lead) || /\bmaintenance\b[^\d]{0,12}$/.test(lead);
    const isParking = /\bparking\b[^\d]{0,15}$/.test(lead);
    const isFitout = /fit[- ]?out[^\d]{0,15}$/.test(lead);
    const isBudget = /\bbudget\b[^\d]{0,15}$/.test(lead);
    const period = /per\s+annum|p\.a\./i.test(m[0]) ? "year" : /month|pm|p\.m\./i.test(m[0]) ? "month" : periodNear(text, e);
    const key: TermKey = isCam ? "cam" : isParking ? "parking" : isFitout ? "fitout_cost" : isBudget ? "budget" : "rent_psf";
    const missing = period ? [] : ["period"];
    push({ key, raw_text: m[0].trim(), value: num(m[1], m[2]), unit: period ? `INR/sf/${period}` : "INR/sf", pricing_basis: period ? `per_sf_${period}` : null,
      area_basis: null, cam: key === "rent_psf" || key === "budget" ? camNear(text, s, e) : null, missing: key === "rent_psf" || key === "budget" ? [...missing, ...(camNear(text, s, e) === "unknown" ? ["cam"] : [])] : missing, start: s, end: e });
  }
  // ---- areas with unit: "12,000 sq ft carpet", "chargeable area 15,600 sft", "20,000 feet"
  for (const m of text.matchAll(new RegExp(String.raw`${NUM}\s*${AREA_UNIT}`, "gi"))) {
    const s = m.index!, e = s + m[0].length;
    const basis = areaBasisNear(text, s);
    const key: TermKey = basis === "carpet" ? "carpet_area" : basis === "chargeable" ? "chargeable_area" : basis === "super_built_up" ? "super_built_up_area" : "area";
    push({ key, raw_text: m[0].trim(), value: num(m[1], m[2]), unit: "sf", pricing_basis: null, area_basis: basis, cam: null,
      missing: basis === "unknown" ? ["area_basis"] : [], start: s, end: e });
  }
  // ---- labelled money: rent / CAM / deposit / brokerage / fit-out / budget (without per-sf unit)
  const LABELS: [TermKey, RegExp][] = [
    ["cam", /\b(?:cam|common area maintenance|maintenance charges?)\b/i],
    ["security_deposit", /\b(?:security deposit|deposit|sd)\b/i],
    ["brokerage", /\bbrokerage\b/i],
    ["fitout_cost", /\bfit[- ]?out(?:\s+cost)?\b/i],
    ["parking", /\bparking\b/i],
    ["budget", /\bbudget\b/i],
    ["monthly_rent", /\b(?:monthly rent|rent|rental|license fee|licence fee|quoted|kiraya)\b/i],
  ];
  for (const m of text.matchAll(new RegExp(String.raw`(?:${CUR}\s*)?${NUM}(?!\s*(?:${AREA_UNIT}|%|months?|years?|yrs?|days?|seats?))`, "gi"))) {
    const s = m.index!, e = s + m[0].length;
    if (out.some((o) => s < o.end && o.start < e)) continue;
    const lead = text.slice(Math.max(0, s - 35), s);
    const label = LABELS.find(([, re]) => new RegExp(`${re.source}[^\\d\\n.;]{0,18}$`, "i").test(lead));
    if (!label) continue;
    const [key] = label;
    const value = num(m[1], m[2]);
    if (key === "security_deposit" && /^\s*months?/i.test(text.slice(e, e + 8))) continue; // handled as months below
    const period = periodNear(text, e);
    const hasCur = new RegExp(`^${CUR}`, "i").test(m[0].trim());
    const missing: string[] = [];
    let unit: string | null = null, basis: string | null = null;
    if (key === "budget" || key === "monthly_rent") {
      // a bare number ("Budget is 85") has unknown unit AND unknown pricing basis — never assumed
      if (!hasCur && !m[2] && value < 1000) { missing.push("unit", "pricing_basis"); }
      else { unit = period ? `INR/${period}` : "INR"; basis = period ? `total_${period}` : null; if (!period) missing.push("pricing_basis"); }
      if (camNear(text, s, e) === "unknown") missing.push("cam");
    } else {
      unit = hasCur || m[2] ? "INR" : null;
      if (!unit) missing.push("unit");
    }
    const k: TermKey = key === "monthly_rent" && period === "year" ? "annual_rent" : key;
    push({ key: k, raw_text: text.slice(Math.max(s - (lead.length - lead.search(label[1])), 0), e).trim().slice(0, 200), value, unit, pricing_basis: basis, area_basis: null,
      cam: key === "budget" || key === "monthly_rent" ? camNear(text, s, e) : null, missing, start: s, end: e });
  }
  // ---- durations and percentages
  const DUR: [TermKey, RegExp][] = [
    ["lock_in", /lock[- ]?in(?:\s+period)?\s*(?:of|:|-|is)?\s*(\d+(?:\.\d+)?)\s*(months?|years?|yrs?)/gi],
    ["lease_duration", /(?:lease|licen[cs]e)\s*(?:term|period|tenure|duration)?\s*(?:of|:|-|is)?\s*(\d+(?:\.\d+)?)\s*(months?|years?|yrs?)/gi],
    ["notice_period", /notice(?:\s+period)?\s*(?:of|:|-|is)?\s*(\d+(?:\.\d+)?)\s*(months?|days?)/gi],
    ["rent_free", /(?:rent[- ]free|fit[- ]?out)\s*(?:period)?\s*(?:of|:|-|is)?\s*(\d+(?:\.\d+)?)\s*(months?|days?)/gi],
    ["security_deposit", /(?:security\s+)?deposit\s*(?:of|:|-|is)?\s*(\d+(?:\.\d+)?)\s*(months?)/gi],
  ];
  for (const [key, re] of DUR) for (const m of text.matchAll(re)) {
    const s = m.index!, e = s + m[0].length;
    const unit = /day/i.test(m[2]) ? "days" : /month/i.test(m[2]) ? "months" : "years";
    push({ key, raw_text: m[0].trim(), value: Number(m[1]), unit: key === "security_deposit" ? "months_rent" : unit, pricing_basis: null, area_basis: null, cam: null, missing: [], start: s, end: e });
  }
  for (const m of text.matchAll(/escalation\s*(?:of|:|-|is)?\s*(\d+(?:\.\d+)?)\s*%(?:\s*(?:every|per|after)\s*(\d+)\s*(months?|years?))?/gi)) {
    const s = m.index!, e = s + m[0].length;
    push({ key: "escalation", raw_text: m[0].trim(), value: Number(m[1]), unit: "%", pricing_basis: null, area_basis: null, cam: null,
      missing: m[2] ? [] : ["frequency"], start: s, end: e });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ------------------------------------------------------------------------------------------------ dates (§4.3)
const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const CONTRACT = /\b(agreement|commencement|expiry|expires|effective|executed|signed|registered|possession date|handover date|lease start|lease end|valid (?:till|until)|validity)\b/i;

export interface DateMention { raw_text: string; date_class: DateClass; iso: string | null; start: number; end: number; kind: "full" | "month" | "weekday" }

/** Every date-like phrase with its class. A spreadsheet/OCR/note date is never "confirmed" unless the source is contractual AND the date is complete. */
export function classifyDates(text: string, opts: { contractualSource?: boolean } = {}): DateMention[] {
  const out: DateMention[] = [];
  const ctx = (s: number, e: number) => text.slice(Math.max(0, s - 50), Math.min(text.length, e + 20));
  const full = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?[\s\-/]+(${MONTH}|\d{1,2})[\s\-/,]+(\d{4})\b`, "gi");
  for (const m of text.matchAll(full)) {
    const s = m.index!, e = s + m[0].length;
    const mi = isNaN(Number(m[2])) ? monthIdx(m[2]) : Number(m[2]) - 1;
    const iso = mi >= 0 && mi < 12 ? `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}` : null;
    const c = ctx(s, e);
    const cls: DateClass = APPROX.test(c) ? "estimated" : opts.contractualSource && CONTRACT.test(c) ? "confirmed" : "estimated";
    out.push({ raw_text: m[0], date_class: cls, iso, start: s, end: e, kind: "full" });
  }
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:by|before|in|from|till|until|end of|tak)?\s*(${MONTH})\b(?:\s+(\d{4}))?`, "gi"))) {
    const s = m.index! + (m[0].length - m[0].trimStart().length), e = m.index! + m[0].length;
    if (out.some((o) => s < o.end && o.start < e)) continue;
    if (/^may$/i.test(m[1]) && !m[2] && !/\b(by|in|before|from|till|until)\s+may\b/i.test(m[0])) continue; // modal "may"
    out.push({ raw_text: m[0].trim(), date_class: m[2] && APPROX.test(ctx(s, e)) ? "estimated" : m[2] ? "estimated" : "informal", iso: null, start: s, end: e, kind: "month" });
  }
  for (const m of text.matchAll(/\b(?:by|on|before|next|this)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar|ravivar)\b/gi)) {
    const s = m.index! + (m[0].length - m[0].trimStart().length), e = m.index! + m[0].length;
    out.push({ raw_text: m[0].trim(), date_class: "informal", iso: null, start: s, end: e, kind: "weekday" });
  }
  return out.sort((a, b) => a.start - b.start);
}
function monthIdx(s: string) {
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(s.toLowerCase().slice(0, 3));
}

export const TERM_LABEL: Record<TermKey, string> = {
  carpet_area: "Carpet area", chargeable_area: "Chargeable area", super_built_up_area: "Super built-up area", area: "Area (basis not stated)",
  rent_psf: "Rent per sq ft", monthly_rent: "Monthly rent", annual_rent: "Annual rent", budget: "Budget", cam: "CAM charges",
  security_deposit: "Security deposit", rent_free: "Rent-free period", lock_in: "Lock-in period", lease_duration: "Lease duration",
  escalation: "Rent escalation", notice_period: "Notice period", fitout_cost: "Fit-out cost", brokerage: "Brokerage", parking: "Parking charges",
};
