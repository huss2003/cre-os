/**
 * Legal desk — deterministic clause extraction, redline comparison and exposure checklist.
 * This is the gateway `mock` and the validation baseline. Output is ALWAYS "for review by the tenant's legal team —
 * not legal advice"; a generated redline is never legal approval. No arithmetic beyond parsing stated numbers.
 */
import { LEGAL_DISCLAIMER } from "../common";

export const ENGINE_VERSION = "legal-v2";
export { LEGAL_DISCLAIMER };

export const CLAUSE_TYPES = [
  "rent", "escalation", "lock_in", "notice", "term", "renewal", "deposit", "cam", "fit_out", "possession", "reinstatement", "termination", "indemnity",
  "obligations", "permitted_use", "assignment", "insurance", "force_majeure", "dispute_resolution", "parking", "taxes",
] as const;
export type ClauseType = (typeof CLAUSE_TYPES)[number];
export const CLAUSE_LABEL: Record<ClauseType, string> = {
  rent: "Rent", escalation: "Escalation", lock_in: "Lock-in", notice: "Notice", term: "Term / tenure", deposit: "Security deposit",
  cam: "CAM / maintenance", fit_out: "Fit-out / rent-free", reinstatement: "Reinstatement", termination: "Termination / break", indemnity: "Indemnity / liability",
  renewal: "Renewal / extension", possession: "Possession / commencement dates", obligations: "Obligations / covenants", permitted_use: "Permitted use",
  assignment: "Assignment / sub-letting", insurance: "Insurance", force_majeure: "Force majeure", dispute_resolution: "Disputes / governing law",
  parking: "Parking", taxes: "Taxes / GST / stamp duty",
};

// More specific types first; rent is generic and weakest. Heading classification takes the first matching pattern.
const PATTERNS: [ClauseType, RegExp, number][] = [
  ["lock_in", /lock[\s-]?in/gi, 3],
  ["escalation", /escalat\w*|increase[sd]? (?:in |of )?(?:the )?(?:rent|licen[cs]e fee)|enhance(?:d|ment)? by/gi, 3],
  ["deposit", /security deposit|interest[- ]free refundable|refundable (?:security )?deposit|\bdeposit\b/gi, 3],
  ["cam", /\bCAM\b|common area maintenance|maintenance charges?/gi, 3],
  ["fit_out", /fit[\s-]?out|rent[\s-]?free|interiors? (?:period|works)/gi, 3],
  ["reinstatement", /reinstat\w*|restor(?:e|ation) (?:the premises|to)|bare[\s-]?shell condition|original condition|hand(?:ed|ing)? back/gi, 3],
  ["assignment", /assign(?:ment|ed|s)?\b|sub[\s-]?let\w*|sub[\s-]?licen[cs]\w*|part(?:ing)? with (?:the )?possession|transfer (?:of )?(?:this |the )?(?:lease|licen[cs]e)/gi, 3],
  ["possession", /possession|hand[\s-]?over|rent commencement|commencement date|date of commencement|effective date/gi, 2],
  ["indemnity", /indemn\w*|liabilit(?:y|ies)|consequential loss/gi, 3],
  ["force_majeure", /force majeure|act of god/gi, 3],
  ["dispute_resolution", /arbitrat\w*|governing law|jurisdiction|dispute resolution|disputes?\b/gi, 3],
  ["insurance", /insur\w*/gi, 3],
  ["parking", /parking|car[\s-]?parks?\b/gi, 3],
  ["taxes", /\bGST\b|goods and services tax|stamp duty|registration charges|property tax|municipal tax(?:es)?/gi, 3],
  ["permitted_use", /permitted use|use of (?:the )?premises|user clause|purpose of (?:the )?(?:lease|licen[cs]e)/gi, 3],
  ["renewal", /renew\w*|option to extend|extension of (?:the )?term/gi, 2],
  ["termination", /terminat\w*|break (?:clause|option)|early exit|determine (?:this|the) (?:lease|agreement)/gi, 2],
  ["obligations", /obligations?|covenants?|repairs?\b|(?:tenant|lessee|licensee|landlord|lessor|licensor) (?:shall|must|agrees? to|undertakes? to)(?! pay)|shall be responsible for|comply with/gi, 1],
  ["notice", /\bnotice\b/gi, 1],
  ["term", /\bterm\b|tenure|lease period|period of (?:the )?(?:lease|licen[cs]e)/gi, 1],
  ["rent", /\brent(?:al)?\b|licen[cs]e fee|monthly (?:charges|compensation)/gi, 1],
];

/** Exact clause position in the stored text: 1-based lines, 0-based char offsets, PDF page (null = unpaged text), paragraph ordinal. */
export interface Locator { line_start: number; line_end: number; char_start: number; char_end: number; page: number | null; page_end?: number | null; para_start?: number; para_end?: number }
export interface ClauseValidation { status: "heuristic" | "verified" | "values_corrected"; dropped: { key: string; value: unknown; reason: string }[]; corrected: { key: string; model: unknown; source: unknown }[] }
export interface ExtractedClause { clause_type: ClauseType; heading: string | null; clause_text: string; locator: Locator; extracted_values: Record<string, unknown>; validation?: ClauseValidation }

interface Segment { heading: string | null; lines: string[]; line_start: number; line_end: number; char_start: number; char_end: number; page: number | null; page_end: number | null; para_start: number; para_end: number }

export interface SegmentOptions { /** Text came from a paged source (PDF): page numbering starts at 1 and each form feed starts a new page. */ paged?: boolean }

const HEADING_NUM = /^\s*(?:clause\s+|article\s+|section\s+)?(\d{1,2}(?:\.\d{1,2})*)[.)]?\s+([A-Za-z][A-Za-z &/,'()\-]{1,50})[:.]?\s*$/i;
const HEADING_CAPS = /^\s*([A-Z][A-Z0-9 &/,'()\-]{3,60}):?\s*$/;
const INLINE_LABEL = /^\s*(?:\d{1,2}(?:\.\d{1,2})*[.)]?\s+)?([A-Z][A-Za-z /&()\-]{2,40}):\s+(\S.*)$/;
const NUMBERED_PARA = /^\s*(?:clause\s+)?(\d{1,2}(?:\.\d{1,2})*)[.)]\s+(\S.*)$/i;
const PAGE_MARK = /^\s*(?:-\s*)?page\s+(\d+)(?:\s+of\s+\d+)?(?:\s*-)?\s*$/i;

export function segment(text: string, opts: SegmentOptions = {}): Segment[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  let offset = 0;
  let page: number | null = opts.paged || text.includes("\f") ? 1 : null;
  let para = 0;
  let prevBlank = true;
  const close = () => { if (cur && cur.lines.join("").trim()) segs.push(cur); cur = null; };
  const open = (heading: string | null, first: string[], lineNo: number, start: number, end: number): Segment =>
    ({ heading, lines: first, line_start: lineNo, line_end: lineNo, char_start: start, char_end: end, page, page_end: page, para_start: para, para_end: para });
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const start = offset;
    offset += rawLine.length + 1;
    let line = rawLine;
    if (line.includes("\f")) { page = (page ?? 1) + (line.split("\f").length - 1); line = line.replace(/\f/g, ""); prevBlank = true; }
    const pm = line.match(PAGE_MARK);
    if (pm) { page = Number(pm[1]); return; }
    if (!line.trim()) { // blank line ends un-headed paragraphs only
      prevBlank = true;
      if (cur && !cur.heading) close();
      return;
    }
    if (prevBlank) para++;
    prevBlank = false;
    // "36 months." / "6 years" are values, not numbered headings (HEADING_NUM allows "1 Rent" without a dot).
    const hn = line.match(HEADING_NUM);
    const valueLine = !!hn && !/^\s*(?:clause|article|section)?\s*\d{1,2}(?:\.\d{1,2})*[.)]/i.test(line) && /^(?:months?|years?|yrs?|days?|weeks?|sq|sft|per|lakhs?|crores?|percent)\b/i.test(hn[2]);
    const h = (valueLine ? null : hn) ?? (line.trim().length <= 60 ? line.match(HEADING_CAPS) : null);
    const inline = line.match(INLINE_LABEL);
    const numbered = line.match(NUMBERED_PARA);
    if (h) {
      close();
      cur = open((h[2] ?? h[1]).trim(), [], lineNo, start, start + rawLine.length);
      return;
    }
    if (inline) {
      close();
      segs.push(open(inline[1].trim(), [inline[2]], lineNo, start, start + rawLine.length));
      return;
    }
    if (numbered && (!cur || cur.lines.length > 0)) {
      close();
      cur = open(null, [numbered[2]], lineNo, start, start + rawLine.length);
      return;
    }
    if (!cur) cur = open(null, [], lineNo, start, start);
    cur.lines.push(line.trim());
    cur.line_end = lineNo;
    cur.char_end = start + rawLine.length;
    cur.page_end = page;
    cur.para_end = para;
  });
  close();
  return segs;
}

function classify(heading: string | null, body: string): ClauseType | null {
  if (heading) {
    for (const [t, re] of PATTERNS) { re.lastIndex = 0; if (re.test(heading)) return t; }
  }
  let best: ClauseType | null = null;
  let bestScore = 0;
  for (const [t, re, w] of PATTERNS) {
    re.lastIndex = 0;
    const hits = body.match(re)?.length ?? 0;
    const score = hits * w;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, eighteen: 18, twenty: 20, thirty: 30, "twenty four": 24, "thirty six": 36, sixty: 60, ninety: 90 };
function n(s: string): number | null {
  const t = s.toLowerCase().replace(/,/g, "").trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return WORD_NUM[t] ?? null;
}
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|eighteen|twenty four|twenty|thirty six|thirty|sixty|ninety)`;
const durRe = (unit: string) => new RegExp(String.raw`${NUM}\s*(?:\(\s*(\d+)\s*\)\s*)?${unit}`, "i");

function duration(text: string, unit: "months?" | "years?" | "days?"): number | null {
  const m = text.match(durRe(unit));
  if (!m) return null;
  return m[2] ? Number(m[2]) : n(m[1]);
}

/** Parse stated values only (raw strings kept). No derived arithmetic. */
export function extractValues(type: ClauseType, text: string): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  const money = text.match(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d+)?)\s*(?:\/-)?\s*(?:per|\/|psf|p\.s\.f\.?)\s*(sq\.?\s*ft\.?|sft|sq\s*ft|square\s+feet|sf|seat)?/i);
  if (money) { v.amount = n(money[1]); v.amount_raw = money[0].trim(); if (money[2]) v.amount_basis = /seat/i.test(money[2]) ? "per_seat" : "per_sf"; }
  if (/carpet/i.test(text)) v.area_basis = "carpet"; else if (/chargeable|super built|built[- ]up/i.test(text)) v.area_basis = "chargeable";
  const pct = text.match(/(\d+(?:\.\d+)?)\s*(?:%|per\s*cent|percent)/i);
  if (pct) v.percent = Number(pct[1]);
  const every = text.match(new RegExp(String.raw`every\s+${NUM}\s*(?:\(\s*(\d+)\s*\)\s*)?(years?|months?)`, "i"));
  if (every) { v.every = every[2] ? Number(every[2]) : n(every[1]); v.every_unit = every[3].toLowerCase().startsWith("year") ? "years" : "months"; }
  if (/annual(?:ly)?|per annum|each year|every year/i.test(text) && !every) { v.every = 1; v.every_unit = "years"; }
  const months = duration(text, "months?");
  const years = duration(text, "years?");
  const days = duration(text, "days?");
  if (months !== null) v.months = months;
  if (years !== null) v.years = years;
  if (days !== null) v.days = days;
  const rentMonths = text.match(new RegExp(String.raw`${NUM}\s*(?:\(\s*(\d+)\s*\)\s*)?months?'?\s*(?:of\s+)?(?:the\s+)?(?:monthly\s+)?(?:rent|rental|licen[cs]e fee)`, "i"));
  if (rentMonths) v.months_of_rent = rentMonths[2] ? Number(rentMonths[2]) : n(rentMonths[1]);
  if (type === "lock_in") v.mutual = /mutual|both parties|either party/i.test(text) ? true : /tenant|licensee|lessee/i.test(text) ? false : null;
  if (type === "cam") { v.has_cap = /\bcap(?:ped)?\b|not exceed|maximum/i.test(text); v.has_reconciliation = /reconcil|audit|actuals|true[- ]up/i.test(text); }
  if (type === "indemnity") { v.capped = /\bcap(?:ped)?\b|limited to|shall not exceed|aggregate liability/i.test(text); v.unlimited = /unlimited|without limit|all (?:losses|claims)|any and all/i.test(text); v.mutual = /mutual|each party|either party/i.test(text); v.consequential_excluded = /(?:exclud|not be liable)[^.]*consequential/i.test(text); }
  if (type === "termination") { v.cure_period = /cure|remed(?:y|ied)/i.test(text); v.landlord_right = /lessor|landlord|licensor/i.test(text); }
  if (type === "reinstatement") { v.bare_shell = /bare[\s-]?shell|original condition/i.test(text); v.wear_and_tear_carveout = /wear and tear/i.test(text); }
  if (type === "fit_out") v.rent_free = /rent[\s-]?free/i.test(text);
  if (type === "notice") v.day_rule = /business days|working days/i.test(text) ? "business" : /calendar days/i.test(text) ? "calendar" : null;
  if (type === "deposit") { v.interest_free = /interest[- ]free/i.test(text); v.refund_timing_stated = /refund(?:ed)?[^.]*(?:within|on|upon|at the time)/i.test(text); }
  if (type === "obligations") {
    const tenant = /(?:tenant|lessee|licensee)\s+(?:shall|must|agrees?|undertakes?|covenants?)/i.test(text);
    const landlord = /(?:landlord|lessor|licensor)\s+(?:shall|must|agrees?|undertakes?|covenants?)/i.test(text);
    v.obligor = tenant && landlord ? "both" : tenant ? "tenant" : landlord ? "landlord" : null;
    v.repairs = /repair|maintain|maintenance/i.test(text);
    v.compliance = /compl(?:y|iance)|statutory|licen[cs]es|approvals|permits?/i.test(text);
  }
  if (type === "assignment") { v.consent_required = /consent|approval|permission/i.test(text); v.group_company_carveout = /group compan|affiliate|subsidiar|holding compan/i.test(text); v.prohibited = /shall not|not be entitled|prohibited/i.test(text); }
  if (type === "renewal") {
    v.landlord_discretion = /(?:sole |absolute )?discretion of the (?:landlord|lessor|licensor)|mutually agreed|subject to (?:the )?(?:landlord|lessor|licensor)/i.test(text);
    v.renewal_rent_basis_stated = /escalat|market rent|same terms|increase|\d+(?:\.\d+)?\s*(?:%|per\s*cent)/i.test(text);
  }
  if (type === "force_majeure") v.rent_abatement = /abate|abatement|suspen\w* (?:of )?(?:the )?(?:rent|licen[cs]e fee)|no rent|waive/i.test(text);
  if (type === "dispute_resolution") {
    v.arbitration = /arbitrat/i.test(text);
    const seat = text.match(/(?:courts?|seat(?:ed)?|venue)(?: of (?:the )?arbitration)?\s+(?:shall be\s+)?(?:at|in)\s+([A-Z][a-z]+)/);
    if (seat) v.seat = seat[1];
  }
  if (type === "insurance") v.insurer = /(?:tenant|lessee|licensee)[^.]{0,60}insur/i.test(text) && /(?:landlord|lessor|licensor)[^.]{0,60}insur/i.test(text) ? "both" : /(?:tenant|lessee|licensee)[^.]{0,60}insur/i.test(text) ? "tenant" : /(?:landlord|lessor|licensor)[^.]{0,60}insur/i.test(text) ? "landlord" : null;
  if (type === "parking") {
    const slots = text.match(/(\d+)\s*(?:\(\s*\w+\s*\)\s*)?(?:car\s*parks?|parking\s*(?:slots?|spaces?|bays?)|slots?)/i);
    if (slots) v.slots = Number(slots[1]);
    v.chargeable = /charg|payable|per slot|per car/i.test(text) && !/free of (?:cost|charge)|without (?:any )?charge/i.test(text);
  }
  if (type === "taxes") { v.gst_extra = /plus GST|exclusive of GST|GST (?:as applicable|extra|shall be (?:paid|borne|payable))|applicable (?:GST|taxes)/i.test(text); v.stamp_duty_borne_by = /stamp duty[^.]*(?:shared equally|50\s*:\s*50|equally)/i.test(text) ? "shared" : /stamp duty[^.]*(?:tenant|lessee|licensee)/i.test(text) ? "tenant" : /stamp duty[^.]*(?:landlord|lessor|licensor)/i.test(text) ? "landlord" : null; }
  const dates = statedDates(text);
  if (dates.length) v.dates = dates;
  return v;
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DATE_RES = [
  new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:${MONTHS})\.?,?\s+\d{4}\b`, "gi"),
  new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b`, "gi"),
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{4}\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
];
/** Dates exactly as written (raw strings, no parsing or arithmetic). */
export function statedDates(text: string): string[] {
  const out: string[] = [];
  for (const re of DATE_RES) { re.lastIndex = 0; for (const m of text.matchAll(re)) if (!out.includes(m[0].trim())) out.push(m[0].trim()); }
  return out.slice(0, 10);
}

/** Heuristic extractor (deterministic). Each clause keeps its source wording and line/char/page/paragraph locator. */
export function extractClauses(text: string, opts: SegmentOptions = {}): ExtractedClause[] {
  const out: ExtractedClause[] = [];
  for (const s of segment(text, opts)) {
    const body = s.lines.join(" ").replace(/\s+/g, " ").trim();
    if (!body && !s.heading) continue;
    const type = classify(s.heading, body);
    if (!type) continue;
    const clauseText = body || s.heading || "";
    out.push({
      clause_type: type, heading: s.heading, clause_text: clauseText,
      locator: { line_start: s.line_start, line_end: s.line_end, char_start: s.char_start, char_end: s.char_end, page: s.page, page_end: s.page_end, para_start: s.para_start, para_end: s.para_end },
      extracted_values: extractValues(type, `${s.heading ?? ""} ${body}`),
      validation: { status: "heuristic", dropped: [], corrected: [] },
    });
  }
  return out;
}

// ------------------------------------------------------------------ source validation (anti-hallucination)
const normText = (s: string) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\f/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Find the clause wording in the raw source; returns an exact locator computed from the source (never the model's). */
export function locate(text: string, clauseText: string, opts: SegmentOptions = {}): Locator | null {
  const words = normText(clauseText).split(" ").filter(Boolean);
  if (!words.length) return null;
  const quoteish = (w: string) => escRe(w).replace(/'/g, "['\u2018\u2019]").replace(/"/g, "[\"\u201c\u201d]").replace(/-/g, "[-\u2013\u2014]");
  const re = new RegExp(words.map(quoteish).join("[\\s\\f]+"), "i");
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index, end = start + m[0].length;
  const before = text.slice(0, start);
  const lineStart = before.split("\n").length;
  const lineEnd = lineStart + (m[0].match(/\n/g)?.length ?? 0);
  const paged = opts.paged || text.includes("\f");
  const page = paged ? 1 + (before.match(/\f/g)?.length ?? 0) : null;
  const pageEnd = paged ? (page ?? 1) + (m[0].match(/\f/g)?.length ?? 0) : null;
  return { line_start: lineStart, line_end: lineEnd, char_start: start, char_end: end, page, page_end: pageEnd, para_start: paraAtLine(text, lineStart), para_end: paraAtLine(text, lineEnd) };
}

/** Paragraph ordinal of a 1-based line, counted exactly like segment(): a non-blank line after a blank line / page break starts a paragraph. */
export function paraAtLine(text: string, lineNo: number): number {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let para = 0, prevBlank = true;
  for (let i = 0; i < Math.min(lineNo, lines.length); i++) {
    let line = lines[i];
    if (line.includes("\f")) { prevBlank = true; line = line.replace(/\f/g, ""); }
    if (PAGE_MARK.test(line)) continue;
    if (!line.trim()) { prevBlank = true; continue; }
    if (prevBlank) para++;
    prevBlank = false;
  }
  return Math.max(1, para);
}

const NUMERIC_KEYS = new Set(["amount", "percent", "every", "months", "years", "days", "months_of_rent", "slots"]);
const WORD_FOR: Record<number, string[]> = Object.entries(WORD_NUM).reduce((acc, [w, n2]) => { (acc[n2] ??= []).push(w); return acc; }, {} as Record<number, string[]>);
function numberInText(n2: number, text: string): boolean {
  const t = text.replace(/,/g, "");
  if (new RegExp(String.raw`(?<![\d.])${escRe(String(n2))}(?![\d]|\.\d)`).test(t)) return true;
  return (WORD_FOR[n2] ?? []).some((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
}

export interface ValidationResult { clauses: ExtractedClause[]; rejected: { clause_type: string; excerpt: string; reason: string }[] }

/**
 * Anti-hallucination for model output:
 *  1. the WHOLE clause wording must appear in the source (whitespace/quote-insensitive), not just its first words;
 *  2. the locator is recomputed from the source (the model's locator is ignored);
 *  3. every extracted value is re-derived from the source wording: deterministic values win; model-only numbers are kept only
 *     when that number literally appears in the clause; anything else is dropped and recorded.
 */
export function validateClauses(text: string, clauses: ExtractedClause[], opts: SegmentOptions = {}): ValidationResult {
  const src = normText(text);
  const out: ExtractedClause[] = [];
  const rejected: ValidationResult["rejected"] = [];
  for (const c of clauses) {
    const body = normText(c.clause_text ?? "");
    if (body.length < 8) { rejected.push({ clause_type: c.clause_type, excerpt: c.clause_text ?? "", reason: "clause text too short to verify" }); continue; }
    if (!src.includes(body)) { rejected.push({ clause_type: c.clause_type, excerpt: (c.clause_text ?? "").slice(0, 120), reason: "clause wording not found verbatim in the source" }); continue; }
    if (!(CLAUSE_TYPES as readonly string[]).includes(c.clause_type)) { rejected.push({ clause_type: String(c.clause_type), excerpt: c.clause_text.slice(0, 120), reason: "unknown clause type" }); continue; }
    const loc = locate(text, c.clause_text, opts);
    if (!loc) { rejected.push({ clause_type: c.clause_type, excerpt: c.clause_text.slice(0, 120), reason: "could not locate clause in the source" }); continue; }
    const det = extractValues(c.clause_type, `${c.heading ?? ""} ${c.clause_text}`);
    const values: Record<string, unknown> = { ...det };
    const dropped: ClauseValidation["dropped"] = [];
    const corrected: ClauseValidation["corrected"] = [];
    for (const [k, v] of Object.entries(c.extracted_values ?? {})) {
      if (k in det) {
        if (JSON.stringify(det[k]) !== JSON.stringify(v)) corrected.push({ key: k, model: v, source: det[k] });
        continue;
      }
      if (NUMERIC_KEYS.has(k) && typeof v === "number" && numberInText(v, c.clause_text)) { values[k] = v; continue; }
      if (k.endsWith("_raw") && typeof v === "string" && normText(c.clause_text).includes(normText(v))) { values[k] = v; continue; }
      dropped.push({ key: k, value: v, reason: "value not supported by the clause wording" });
    }
    out.push({ ...c, locator: loc, extracted_values: values, validation: { status: dropped.length || corrected.length ? "values_corrected" : "verified", dropped, corrected } });
  }
  return { clauses: out, rejected };
}

/** Back-compatible wrapper: model clauses that survive whole-clause + value validation. */
export function validateAgainstSource(text: string, clauses: ExtractedClause[]): ExtractedClause[] {
  return validateClauses(text, clauses).clauses;
}

export function locatorLabel(loc: Partial<Locator> | null | undefined, version?: number | string | null): string {
  if (!loc || loc.line_start === undefined) return version !== undefined && version !== null ? `v${version} · location unknown` : "location unknown";
  const parts: string[] = [];
  if (version !== undefined && version !== null) parts.push(`v${version}`);
  if (loc.page) parts.push(loc.page_end && loc.page_end !== loc.page ? `pp.${loc.page}–${loc.page_end}` : `p.${loc.page}`);
  if (loc.para_start) parts.push(loc.para_end && loc.para_end !== loc.para_start ? `¶${loc.para_start}–${loc.para_end}` : `¶${loc.para_start}`);
  parts.push(loc.line_end && loc.line_end !== loc.line_start ? `lines ${loc.line_start}–${loc.line_end}` : `line ${loc.line_start}`);
  return parts.join(" · ");
}

// ------------------------------------------------------------------ redline
export type WordOp = { op: "eq" | "del" | "ins"; text: string };

export function wordDiff(a: string, b: string): WordOp[] {
  const A = a.split(/(\s+)/).filter((x) => x.length > 0);
  const B = b.split(/(\s+)/).filter((x) => x.length > 0);
  if (A.length * B.length > 4_000_000) return [{ op: "del", text: a }, { op: "ins", text: b }];
  const dp: Uint32Array[] = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: WordOp[] = [];
  const push = (op: WordOp["op"], text: string) => { const last = ops[ops.length - 1]; if (last && last.op === op) last.text += text; else ops.push({ op, text }); };
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { push("eq", A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push("del", A[i]); i++; }
    else { push("ins", B[j]); j++; }
  }
  while (i < A.length) push("del", A[i++]);
  while (j < B.length) push("ins", B[j++]);
  return ops;
}

export interface ClauseDiff {
  clause_type: ClauseType;
  change: "added" | "removed" | "changed" | "unchanged";
  base_text: string | null;
  new_text: string | null;
  base_locator: Locator | null;
  new_locator: Locator | null;
  /** Every clause of this type (a type may occur in several places). */
  base_locators?: Locator[];
  new_locators?: Locator[];
  ops: WordOp[];
  value_changes: { key: string; from: unknown; to: unknown }[];
}

function joinType(cs: ExtractedClause[], t: ClauseType) {
  const m = cs.filter((c) => c.clause_type === t);
  if (!m.length) return null;
  const values: Record<string, unknown> = {};
  for (const c of m) for (const [k, v] of Object.entries(c.extracted_values)) if (values[k] === undefined) values[k] = v;
  return { text: m.map((c) => c.clause_text).join("\n"), locator: m[0].locator, locators: m.map((c) => c.locator), values };
}

export function compareClauses(base: ExtractedClause[], next: ExtractedClause[]): ClauseDiff[] {
  const out: ClauseDiff[] = [];
  for (const t of CLAUSE_TYPES) {
    const a = joinType(base, t), b = joinType(next, t);
    if (!a && !b) continue;
    if (a && !b) { out.push({ clause_type: t, change: "removed", base_text: a.text, new_text: null, base_locator: a.locator, new_locator: null, base_locators: a.locators, new_locators: [], ops: [{ op: "del", text: a.text }], value_changes: [] }); continue; }
    if (!a && b) { out.push({ clause_type: t, change: "added", base_text: null, new_text: b.text, base_locator: null, new_locator: b.locator, base_locators: [], new_locators: b.locators, ops: [{ op: "ins", text: b.text }], value_changes: [] }); continue; }
    const same = a!.text.replace(/\s+/g, " ") === b!.text.replace(/\s+/g, " ");
    const keys = new Set([...Object.keys(a!.values), ...Object.keys(b!.values)]);
    const value_changes = [...keys].filter((k) => JSON.stringify(a!.values[k] ?? null) !== JSON.stringify(b!.values[k] ?? null)).map((k) => ({ key: k, from: a!.values[k] ?? null, to: b!.values[k] ?? null }));
    out.push({ clause_type: t, change: same ? "unchanged" : "changed", base_text: a!.text, new_text: b!.text, base_locator: a!.locator, new_locator: b!.locator, base_locators: a!.locators, new_locators: b!.locators, ops: same ? [{ op: "eq", text: b!.text }] : wordDiff(a!.text, b!.text), value_changes });
  }
  return out;
}

// ------------------------------------------------------------------ full-document redline
export interface RedlineLine { op: "eq" | "del" | "ins"; base_line: number | null; new_line: number | null; base_page: number | null; new_page: number | null; text: string; ops?: WordOp[] }
export interface RedlineHunk { base_start: number; new_start: number; lines: RedlineLine[] }
export interface DocumentRedline { hunks: RedlineHunk[]; stats: { added: number; removed: number; unchanged: number }; coarse: boolean; truncated: boolean }

function pagesOf(lines: string[], paged: boolean): (number | null)[] {
  let page = paged ? 1 : null;
  return lines.map((l) => {
    if (l.includes("\f")) page = (page ?? 1) + (l.split("\f").length - 1);
    const pm = l.replace(/\f/g, "").match(PAGE_MARK);
    if (pm) page = Number(pm[1]);
    return page;
  });
}

/**
 * Whole-document line redline (in addition to the per-clause view), so wording changed outside recognised clauses is
 * never missed. Common prefix/suffix are trimmed, the middle is diffed by LCS (coarse block replace beyond ~4M cells).
 * Adjacent removed/added lines are paired with a word-level diff. Every line keeps its line number and page.
 */
export function documentRedline(baseText: string, newText: string, opts: { basePaged?: boolean; newPaged?: boolean; context?: number; maxLines?: number } = {}): DocumentRedline {
  const A = baseText.replace(/\r\n?/g, "\n").split("\n");
  const B = newText.replace(/\r\n?/g, "\n").split("\n");
  const pa = pagesOf(A, !!opts.basePaged || baseText.includes("\f"));
  const pb = pagesOf(B, !!opts.newPaged || newText.includes("\f"));
  const key = (l: string) => l.replace(/\f/g, "").replace(/\s+/g, " ").trim();
  let pre = 0;
  while (pre < A.length && pre < B.length && key(A[pre]) === key(B[pre])) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && key(A[A.length - 1 - suf]) === key(B[B.length - 1 - suf])) suf++;
  const a = A.slice(pre, A.length - suf), b = B.slice(pre, B.length - suf);
  type Op = { op: "eq" | "del" | "ins"; i: number | null; j: number | null };
  const seq: Op[] = [];
  for (let k = 0; k < pre; k++) seq.push({ op: "eq", i: k, j: k });
  let coarse = false;
  if (a.length * b.length > 4_000_000) {
    coarse = true;
    a.forEach((_, k) => seq.push({ op: "del", i: pre + k, j: null }));
    b.forEach((_, k) => seq.push({ op: "ins", i: null, j: pre + k }));
  } else {
    const dp: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = key(a[i]) === key(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (key(a[i]) === key(b[j])) { seq.push({ op: "eq", i: pre + i, j: pre + j }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { seq.push({ op: "del", i: pre + i, j: null }); i++; }
      else { seq.push({ op: "ins", i: null, j: pre + j }); j++; }
    }
    while (i < a.length) seq.push({ op: "del", i: pre + i++, j: null });
    while (j < b.length) seq.push({ op: "ins", i: null, j: pre + j++ });
  }
  for (let k = 0; k < suf; k++) seq.push({ op: "eq", i: A.length - suf + k, j: B.length - suf + k });

  const lines: RedlineLine[] = seq.map((o) => ({
    op: o.op, base_line: o.i === null ? null : o.i + 1, new_line: o.j === null ? null : o.j + 1,
    base_page: o.i === null ? null : pa[o.i], new_page: o.j === null ? null : pb[o.j],
    text: (o.i !== null ? A[o.i] : B[o.j!]).replace(/\f/g, ""),
  }));
  // pair runs of removed lines with the following added lines -> word diff
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].op !== "del") continue;
    let d = k; while (d < lines.length && lines[d].op === "del") d++;
    let n2 = d; while (n2 < lines.length && lines[n2].op === "ins") n2++;
    const pairs = Math.min(d - k, n2 - d);
    for (let p = 0; p < pairs; p++) {
      const ops = wordDiff(lines[k + p].text, lines[d + p].text);
      lines[k + p].ops = ops.filter((o) => o.op !== "ins");
      lines[d + p].ops = ops.filter((o) => o.op !== "del");
    }
    k = n2 - 1;
  }
  const stats = { added: lines.filter((l) => l.op === "ins").length, removed: lines.filter((l) => l.op === "del").length, unchanged: lines.filter((l) => l.op === "eq").length };
  const ctx = opts.context ?? 2;
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, k) => { if (l.op !== "eq" && l.text.trim()) for (let x = Math.max(0, k - ctx); x <= Math.min(lines.length - 1, k + ctx); x++) keep[x] = true; });
  const hunks: RedlineHunk[] = [];
  let cur: RedlineHunk | null = null;
  let emitted = 0;
  const max = opts.maxLines ?? 1500;
  let truncated = false;
  lines.forEach((l, k) => {
    if (!keep[k]) { cur = null; return; }
    if (emitted >= max) { truncated = true; return; }
    if (!cur) { cur = { base_start: l.base_line ?? 0, new_start: l.new_line ?? 0, lines: [] }; hunks.push(cur); }
    cur.lines.push(l);
    emitted++;
  });
  return { hunks, stats, coarse, truncated };
}

// ------------------------------------------------------------------ exposure checklist
export interface DocRef { id: string; title: string; version: number }
export interface ExposureItem {
  clause_type: ClauseType;
  locator: Locator | null;
  excerpt: string | null;
  exposure: string;
  question: string;
  alternative: string;
  severity: "low" | "medium" | "high";
  reviewer_status: "pending_legal_review";
  /** Document version the locator points into (null only for "not found" items). */
  document: DocRef | null;
  /** For redline items: where the clause sat in the earlier version. */
  base_document?: DocRef | null;
  base_locator?: Locator | null;
  /** Visible uncertainty: heuristic extraction / OCR text / model values corrected. */
  certainty: "verify_against_source" | "ocr_unverified" | "not_found";
}

const CORE: ClauseType[] = ["rent", "escalation", "lock_in", "notice", "term", "deposit", "cam", "fit_out", "reinstatement", "termination", "indemnity", "obligations", "possession"];
/** Commonly expected but not always present: missing => low-severity question. */
const OPTIONAL: ClauseType[] = ["renewal", "assignment", "force_majeure", "dispute_resolution", "insurance", "taxes"];

export function exposureChecklist(clauses: ExtractedClause[], diff?: ClauseDiff[], refs: { document?: DocRef | null; base?: DocRef | null; ocrUnverified?: boolean } = {}): ExposureItem[] {
  const items: ExposureItem[] = [];
  const doc = refs.document ?? null;
  const add = (c: ExtractedClause | null, t: ClauseType, exposure: string, question: string, alternative: string, severity: ExposureItem["severity"], base?: { locator: Locator | null }) =>
    items.push({
      clause_type: t, locator: c?.locator ?? null, excerpt: c ? c.clause_text.slice(0, 280) : null, exposure, question, alternative, severity, reviewer_status: "pending_legal_review",
      document: c || !base ? doc : null, base_document: base ? refs.base ?? null : undefined, base_locator: base ? base.locator : undefined,
      certainty: !c && !base ? "not_found" : refs.ocrUnverified ? "ocr_unverified" : "verify_against_source",
    });
  const first = (t: ClauseType) => clauses.find((c) => c.clause_type === t) ?? null;

  for (const t of CORE) if (!first(t)) add(null, t, `${CLAUSE_LABEL[t]} wording not found in this text.`, `Is ${CLAUSE_LABEL[t].toLowerCase()} covered elsewhere (schedule, annexure, master lease)?`, "Ask for the clause to be stated explicitly in this document.", t === "rent" || t === "term" ? "high" : "medium");
  for (const t of OPTIONAL) if (!first(t)) add(null, t, `${CLAUSE_LABEL[t]} wording not found in this text.`, `Should ${CLAUSE_LABEL[t].toLowerCase()} be addressed in this document?`, "Raise with the legal team whether the clause is needed at this stage.", "low");

  const esc = first("escalation");
  if (esc) {
    const v = esc.extracted_values;
    add(esc, "escalation", `Escalation ${v.percent ?? "?"}%${v.every ? ` every ${v.every} ${v.every_unit}` : ", frequency not stated"}; compounding over the term raises total occupancy cost.`, "Is escalation on the base rent only (not CAM/parking)? Does it compound? From which date does it run?", "Model the full term in the finance engine; consider a lower rate, longer interval or escalation cap.", v.every === undefined ? "high" : "medium");
  }
  const lock = first("lock_in");
  if (lock) {
    const v = lock.extracted_values;
    add(lock, "lock_in", `Lock-in ${v.months ?? (v.years ? `${v.years} years` : "?")}${v.mutual === false ? " — appears tenant-only" : v.mutual ? " — appears mutual" : ""}. Exit during lock-in may require paying rent for the remaining period.`, "Is the lock-in mutual? What is payable on early exit? Any business-closure or force-majeure carve-out?", "Seek a mutual lock-in, shorter period or a defined early-exit payment.", v.mutual === false ? "high" : "medium");
  }
  const notice = first("notice");
  if (notice) add(notice, "notice", `Notice ${notice.extracted_values.months ?? notice.extracted_values.days ?? "?"} ${notice.extracted_values.months ? "months" : "days"}${notice.extracted_values.day_rule ? ` (${notice.extracted_values.day_rule} days)` : " — day-counting rule not stated"}.`, "When does the notice period start counting, and how must notice be served?", "Clarify calendar vs business days and service method; diarise the notice deadline separately from expiry.", "medium");
  const dep = first("deposit");
  if (dep) add(dep, "deposit", `Security deposit ${dep.extracted_values.months_of_rent ?? "?"} months${dep.extracted_values.refund_timing_stated ? "" : "; refund timing not stated"}.`, "When is the deposit refunded, can deductions be disputed, is interest payable on late refund?", "Ask for refund within a fixed period of handover, interest on delay, or a bank guarantee instead of cash.", dep.extracted_values.refund_timing_stated ? "low" : "medium");
  const cam = first("cam");
  if (cam && (!cam.extracted_values.has_cap || !cam.extracted_values.has_reconciliation)) add(cam, "cam", `CAM charges${cam.extracted_values.has_cap ? "" : " without a stated cap"}${cam.extracted_values.has_reconciliation ? "" : " and without reconciliation/audit rights"}.`, "How is CAM calculated, what does it include, and is there an annual reconciliation?", "Seek a CAM cap or fixed escalation, inclusion list and audit/reconciliation rights.", "medium");
  const fit = first("fit_out");
  if (fit && !fit.extracted_values.rent_free) add(fit, "fit_out", "Fit-out terms found but no rent-free period stated.", "Is there a rent-free fit-out period, and when does rent commence?", "Ask for a rent-free period aligned to the fit-out programme and approvals.", "medium");
  const rein = first("reinstatement");
  if (rein && rein.extracted_values.bare_shell) add(rein, "reinstatement", `Reinstatement to bare-shell/original condition${rein.extracted_values.wear_and_tear_carveout ? "" : " without a wear-and-tear carve-out"} — potentially significant exit cost.`, "What exactly must be removed at exit, and can the landlord elect to retain fit-outs?", "Seek a wear-and-tear carve-out, retention of fit-outs or a fixed reinstatement sum.", "high");
  const term = first("termination");
  if (term && term.extracted_values.landlord_right && !term.extracted_values.cure_period) add(term, "termination", "Landlord termination right without a stated cure period.", "What defaults allow termination, and is there notice and an opportunity to remedy?", "Seek a cure period and limit termination to material, unremedied defaults.", "high");
  const ind = first("indemnity");
  if (ind && (!ind.extracted_values.capped || ind.extracted_values.unlimited)) add(ind, "indemnity", `Indemnity appears ${ind.extracted_values.unlimited ? "unlimited" : "uncapped"}${ind.extracted_values.mutual ? "" : " and one-sided"}${ind.extracted_values.consequential_excluded ? "" : "; consequential losses not excluded"}.`, "Is liability capped, mutual, and are indirect/consequential losses excluded?", "Seek a mutual indemnity, an aggregate liability cap and exclusion of consequential losses.", "high");

  const obl = first("obligations");
  if (obl) {
    const v = obl.extracted_values;
    add(obl, "obligations", `Obligations clause${v.obligor === "tenant" ? " places duties on the tenant only" : v.obligor === "landlord" ? " places duties on the landlord" : ""}${v.repairs ? "; includes repair/maintenance duties" : ""}${v.compliance ? "; includes compliance/approvals duties" : ""}.`, "Which repair, compliance and approval duties sit with the tenant vs the landlord, and are structural/common-area items excluded?", "Split duties explicitly (structural and common areas with the landlord) and add timelines for landlord obligations.", v.obligor === "tenant" ? "medium" : "low");
  }
  const pos = first("possession");
  if (pos) {
    const ds = (pos.extracted_values.dates as string[] | undefined) ?? [];
    add(pos, "possession", ds.length ? `Dates stated: ${ds.join(", ")}. Verify which events (handover, rent commencement, lock-in start) each date drives.` : "Possession / commencement terms found but no calendar date is stated.", "What exactly triggers handover, rent commencement and the lock-in start, and what if handover is late?", "Tie rent commencement to actual handover (plus fit-out period) and add a long-stop date with a remedy for late handover.", ds.length ? "medium" : "high");
  }
  const asg = first("assignment");
  if (asg && (asg.extracted_values.prohibited || !asg.extracted_values.group_company_carveout)) add(asg, "assignment", `Assignment / sub-letting ${asg.extracted_values.prohibited ? "restricted" : "subject to consent"}${asg.extracted_values.group_company_carveout ? "" : " with no group-company carve-out"}.`, "Can the tenant assign or share space with group companies without consent? Is consent not to be unreasonably withheld?", "Seek a group-company carve-out and a 'consent not unreasonably withheld' standard.", "medium");
  const ren = first("renewal");
  if (ren && (ren.extracted_values.landlord_discretion || !ren.extracted_values.renewal_rent_basis_stated)) add(ren, "renewal", `Renewal${ren.extracted_values.landlord_discretion ? " appears to be at the landlord's discretion / mutual agreement" : ""}${ren.extracted_values.renewal_rent_basis_stated ? "" : "; renewal rent basis not stated"}.`, "Is renewal a tenant option, and how is the renewal rent set?", "Seek a tenant renewal option with a stated rent basis (fixed escalation or capped market review).", "medium");
  const fm = first("force_majeure");
  if (fm && !fm.extracted_values.rent_abatement) add(fm, "force_majeure", "Force majeure clause without rent abatement / suspension.", "Is rent suspended if the premises cannot be used, and can either party exit after a prolonged event?", "Seek rent abatement during force majeure and an exit right after a defined period.", "medium");
  const tax = first("taxes");
  if (tax && tax.extracted_values.gst_extra) add(tax, "taxes", "Rent stated exclusive of GST / taxes — the effective cost is higher than the headline.", "Which taxes and charges (GST, property tax, stamp duty, registration) are on the tenant?", "Confirm the tax split and model GST in the finance comparison.", "low");

  for (const d of diff ?? []) {
    if (d.change === "unchanged") continue;
    const c = clauses.find((x) => x.clause_type === d.clause_type) ?? null;
    const what = d.change === "removed" ? "removed in this version" : d.change === "added" ? "added in this version" : `changed${d.value_changes.length ? ` (${d.value_changes.map((v) => `${v.key}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`).join("; ")})` : ""}`;
    add(c, d.clause_type, `${CLAUSE_LABEL[d.clause_type]} ${what}.`, "Was this change agreed commercially, and does it match the approved term sheet?", "Confirm with the client and reflect the agreed position; flag for legal review.", d.change === "removed" || d.value_changes.length > 0 ? "high" : "medium", { locator: d.base_locator });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
