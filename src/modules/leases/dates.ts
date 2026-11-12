/**
 * Contractual date calculation (USER-RULES #1, SPEC §4.2). PURE and deterministic — no AI, no clock.
 *
 * Every result carries the method + explicit convention used, so a reviewer can reproduce it. When the wording does
 * not pin down the convention (anchor missing, "from" vs "after" unclear, business-day calendar unknown, words like
 * "approximately") the result is `needs_review` and every plausible reading is listed in `alternatives` — the code
 * never silently picks one. A calculated date is NEVER a confirmed contractual deadline: confirmation is a human step
 * (service.confirmDate).
 *
 * Conventions:
 *  - Calendar-month addition uses the end-of-month rule: day clamps to the last day of the target month
 *    (31 Jan + 1 month = 28 Feb, or 29 Feb in a leap year). Optional `eomToEom`: a month-end start stays at month-end.
 *  - A term/period of N months "from/commencing on" D (inclusive of D) ends on edate(D, N) − 1 day
 *    (1 Jan 2027 + 36 months → 31 Dec 2029). The first day after the period is edate(D, N).
 *  - "after N months from D" (escalation/effective events) takes effect on edate(D, N).
 *  - "N days from/after D" excludes D (D + N). "N days including D" / "inclusive" → D + N − 1.
 *  - "not less than N months prior to X" → latest service date = edate(X, −N). "N clear days before X" → X − N − 1.
 *  - Business days skip Sat/Sun only; public holidays are unknown → always needs_review.
 */

export type VerificationStatus = "extracted" | "calculated" | "needs_review" | "confirmed" | "conflicting";
export const VERIFICATION_LABEL: Record<VerificationStatus, string> = {
  extracted: "Extracted (stated in document)", calculated: "Calculated — not verified", needs_review: "Needs review",
  confirmed: "Confirmed contractual deadline", conflicting: "Conflicting — review",
};

export interface Convention {
  monthRule?: "eom_clamp" | "eom_to_eom";
  counting?: "period_inclusive_end" | "effective_on_anniversary" | "exclusive_of_anchor" | "inclusive_of_anchor" | "clear_days";
  direction?: "before" | "after";
  unit?: "months" | "days" | "business_days" | "years";
  anchor?: string;
  holidays?: "not_applied";
}
export interface Alternative { date: string; reading: string }
export interface DateCalc {
  date: string | null;
  status: "calculated" | "needs_review";
  method: string;
  convention: Convention;
  alternatives: Alternative[];
  reason?: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isIso = (s: unknown): s is string => typeof s === "string" && ISO.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const lastDay = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** Calendar-month add with end-of-month rule. `eomToEom`: a start on the last day of its month lands on the last day. */
export function addMonths(iso: string, months: number, opts: { eomToEom?: boolean } = {}): string {
  if (!isIso(iso)) throw new Error(`addMonths: bad date ${iso}`);
  if (!Number.isInteger(months)) throw new Error(`addMonths: non-integer months (${months}) — needs review`);
  const [y, m, d] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12), nm = ((total % 12) + 12) % 12;
  const ld = lastDay(ny, nm);
  const wasEom = d === lastDay(y, m - 1);
  const nd = opts.eomToEom && wasEom ? ld : Math.min(d, ld);
  return `${pad(ny, 4)}-${pad(nm + 1)}-${pad(nd)}`;
}
export function addDays(iso: string, days: number): string {
  const t = Date.parse(iso + "T00:00:00Z") + days * 86_400_000;
  const d = new Date(t);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function addBusinessDays(iso: string, days: number): string {
  let cur = iso; let left = Math.abs(days); const step = days >= 0 ? 1 : -1;
  while (left > 0) { cur = addDays(cur, step); const wd = new Date(cur + "T00:00:00Z").getUTCDay(); if (wd !== 0 && wd !== 6) left--; }
  return cur;
}
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

// ------------------------------------------------------------------ number words
const ONES: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
export function wordsToNumber(s: string): number | null {
  const t = s.toLowerCase().replace(/-/g, " ").trim().split(/\s+/);
  let n = 0; let any = false;
  for (const w of t) {
    if (w in ONES) { n += ONES[w]; any = true; } else if (w in TENS) { n += TENS[w]; any = true; } else if (w === "hundred") { n = (n || 1) * 100; any = true; } else if (w === "and") continue; else return null;
  }
  return any ? n : null;
}

const NUMW = "(?:\\d+(?:\\.\\d+)?|(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|hundred|and)[\\s-]?)+)";
const DUR_RE = new RegExp(`(${NUMW})\\s*(?:\\(\\s*(${NUMW})\\s*\\)\\s*)?(clear\\s+)?(calendar\\s+)?(business|working)?\\s*(months?|days?|years?)`, "i");

export interface Duration { n: number; unit: "months" | "days" | "business_days" | "years"; clear: boolean; raw: string; mismatch?: string }
/** First duration in the text ("six (6) months", "36 months", "90 working days"). Words/digits disagreeing → mismatch. */
export function parseDuration(text: string): Duration | null {
  const m = DUR_RE.exec(text);
  if (!m) return null;
  const a = /\d/.test(m[1]) ? Number(m[1]) : wordsToNumber(m[1]);
  const b = m[2] ? (/\d/.test(m[2]) ? Number(m[2]) : wordsToNumber(m[2])) : null;
  if (a === null) return null;
  const unitWord = m[6].toLowerCase();
  const unit = unitWord.startsWith("month") ? "months" : unitWord.startsWith("year") ? "years" : m[5] ? "business_days" : "days";
  return { n: a, unit, clear: !!m[3], raw: m[0].trim(), ...(b !== null && b !== a ? { mismatch: `words say ${a}, figures say ${b}` } : {}) };
}

const VAGUE = /\b(approximately|about|around|on or about|tentative(?:ly)?|estimated|subject to|mutually agreed|to be agreed|tbd|tba)\b/i;

// ------------------------------------------------------------------ calculators
/** End of a term/period of N months starting on `start` (inclusive). Lock-in of 36 months from 1 Jan 2027 → 31 Dec 2029. */
export function periodEnd(start: string, months: number, opts: { eomToEom?: boolean } = {}): DateCalc {
  const convention: Convention = { monthRule: opts.eomToEom ? "eom_to_eom" : "eom_clamp", counting: "period_inclusive_end", unit: "months", anchor: start };
  if (!Number.isInteger(months)) {
    return { date: null, status: "needs_review", method: `period of ${months} months from ${start}`, convention, alternatives: [], reason: "Fractional months — the agreement must state how part-months are counted." };
  }
  const first = addMonths(start, months, opts);
  return { date: addDays(first, -1), status: "calculated", method: `edate(${start}, ${months}) − 1 day (period includes the start date; end-of-month rule)`, convention, alternatives: [] };
}

/** Event that takes effect "after N months" from `start` (e.g. escalation): on edate(start, N). */
export function effectiveAfter(start: string, months: number): DateCalc {
  const convention: Convention = { monthRule: "eom_clamp", counting: "effective_on_anniversary", unit: "months", anchor: start, direction: "after" };
  if (!Number.isInteger(months)) return { date: null, status: "needs_review", method: `after ${months} months from ${start}`, convention, alternatives: [], reason: "Fractional months." };
  return { date: addMonths(start, months), status: "calculated", method: `edate(${start}, ${months}) — takes effect on the month-anniversary (end-of-month rule)`, convention, alternatives: [] };
}

function shift(anchor: string, d: Duration, dir: 1 | -1): string {
  if (d.unit === "months") return addMonths(anchor, dir * d.n);
  if (d.unit === "years") return addMonths(anchor, dir * d.n * 12);
  if (d.unit === "business_days") return addBusinessDays(anchor, dir * d.n);
  return addDays(anchor, dir * d.n);
}

/**
 * Notice / deadline from a clause and its anchor dates. Handles:
 *  "not less than six (6) months prior to (the) expiry"  → edate(expiry, −6), latest date to serve notice
 *  "at least 90 days before the expiry"                   → expiry − 90 days
 *  "N clear days before …"                                → expiry − N − 1
 *  "within 90 days of/from <anchor>"                      → anchor + 90 (anchor must be known; else needs_review)
 *  "within 90 days" (no anchor)                           → needs_review with alternatives
 */
export function noticeDeadline(clause: string, anchors: { expiry?: string | null; commencement?: string | null; lockinEnd?: string | null; base?: string | null }): DateCalc {
  const text = clause.replace(/\s+/g, " ");
  const d = parseDuration(text);
  const base: Convention = {};
  if (!d) return { date: null, status: "needs_review", method: "no period found in clause", convention: base, alternatives: [], reason: "Notice period not stated in a recognisable form." };
  if (!Number.isInteger(d.n)) return { date: null, status: "needs_review", method: d.raw, convention: base, alternatives: [], reason: "Fractional notice period." };
  const reasons: string[] = [];
  if (d.mismatch) reasons.push(`Number in words and figures differ (${d.mismatch}).`);
  if (VAGUE.test(text)) reasons.push("Wording is qualified (e.g. 'approximately', 'subject to').");
  if (d.unit === "business_days") reasons.push("Business days: weekends skipped; public holidays not applied — verify against the holiday list.");

  const before = /\b(prior\s+to|before|preceding|in\s+advance\s+of|ahead\s+of)\b/i.test(text);
  const within = /\bwithin\b/i.test(text);
  const afterW = /\b(after|from|following|of\s+(?:receipt|the\s+date))\b/i.test(text);
  const toExpiry = /\b(expiry|expiration|end\s+of\s+the\s+(?:term|lease)|term\s+end|determination)\b/i.test(text);
  const toLockin = /\block[\s-]?in\b/i.test(text);
  const toCommence = /\bcommencement\b/i.test(text);
  const named = toExpiry ? anchors.expiry : toLockin ? anchors.lockinEnd : toCommence ? anchors.commencement : anchors.base ?? null;
  const anchorName = toExpiry ? "expiry" : toLockin ? "lock-in end" : toCommence ? "commencement" : "stated event";

  if (before && !within) {
    const convention: Convention = { monthRule: "eom_clamp", counting: d.clear ? "clear_days" : "exclusive_of_anchor", direction: "before", unit: d.unit, anchor: anchorName, ...(d.unit === "business_days" ? { holidays: "not_applied" } : {}) };
    if (!named) return { date: null, status: "needs_review", method: `${d.raw} before ${anchorName}`, convention, alternatives: [], reason: `The ${anchorName} date is not known/confirmed, so the deadline cannot be calculated.` };
    let date = shift(named, d, -1);
    if (d.clear) date = addDays(date, -1);
    const alts: Alternative[] = [];
    if (!/\bnot\s+less\s+than|at\s+least|no\s+later\s+than|minimum\b/i.test(text)) {
      reasons.push("Clause does not say 'not less than'/'at least' — unclear whether notice must be served exactly or at least that far in advance.");
      alts.push({ date, reading: `latest date to serve: ${d.raw} before ${anchorName}` });
    }
    if (d.unit === "days" && !d.clear) alts.push({ date: addDays(date, -1), reading: "if counted as clear days (neither service day nor expiry counted)" });
    const status = reasons.length ? "needs_review" : "calculated";
    return { date, status, method: `${d.unit === "months" ? `edate(${named}, −${d.n})` : `${named} − ${d.n} ${d.unit.replace("_", " ")}`}${d.clear ? " − 1 (clear days)" : ""} = latest date to serve notice`, convention, alternatives: status === "needs_review" ? alts : [], ...(reasons.length ? { reason: reasons.join(" ") } : {}) };
  }

  if (within) {
    const convention: Convention = { counting: "exclusive_of_anchor", direction: "after", unit: d.unit, anchor: anchorName };
    const anchorDate = named ?? null;
    if (!anchorDate || !afterW) {
      const alts: Alternative[] = [];
      for (const [nm, v] of [["commencement", anchors.commencement], ["expiry", anchors.expiry], ["lock-in end", anchors.lockinEnd], ["stated event", anchors.base]] as const) {
        if (v) alts.push({ date: shift(v, d, 1), reading: `${d.raw} after ${nm}` });
      }
      return { date: null, status: "needs_review", method: `within ${d.raw} — start point unclear`, convention, alternatives: alts, reason: "'Within' period has no clear start point (from what event?). Choose the correct reading." };
    }
    const date = shift(anchorDate, d, 1);
    const alts = d.unit === "days" ? [{ date: addDays(date, -1), reading: "if the anchor day itself is counted as day 1" }] : [];
    reasons.push("'Within N days of' — whether the anchor day counts depends on the agreement's interpretation clause.");
    return { date, status: "needs_review", method: `${anchorDate} + ${d.n} ${d.unit} (anchor day excluded)`, convention, alternatives: [{ date, reading: "anchor day excluded" }, ...alts], reason: reasons.join(" ") };
  }

  // no direction words at all → ambiguous
  const alts: Alternative[] = [];
  if (anchors.expiry) alts.push({ date: shift(anchors.expiry, d, -1), reading: `${d.raw} before expiry` });
  if (anchors.lockinEnd) alts.push({ date: shift(anchors.lockinEnd, d, -1), reading: `${d.raw} before lock-in end` });
  return { date: null, status: "needs_review", method: `${d.raw} — direction/anchor not stated`, convention: { unit: d.unit }, alternatives: alts, reason: "Notice period stated without 'prior to'/'before' and an event — can't tell when notice is due." };
}

/** Lock-in / term from wording: "lock-in period of 36 (thirty six) months from the commencement date". */
export function periodFromClause(clause: string, start: string | null): DateCalc & { months: number | null } {
  const d = parseDuration(clause);
  if (!d || (d.unit !== "months" && d.unit !== "years")) return { months: null, date: null, status: "needs_review", method: "no month/year period found", convention: {}, alternatives: [], reason: "Period not stated in months/years." };
  const months = d.unit === "years" ? d.n * 12 : d.n;
  if (!start) return { months, date: null, status: "needs_review", method: `${months} months from (unknown start)`, convention: {}, alternatives: [], reason: "Start date unknown." };
  const afterWord = /\bafter\b/i.test(clause) && !/\bfrom\b/i.test(clause);
  const r = periodEnd(start, months);
  const reasons: string[] = [];
  if (d.mismatch) reasons.push(`Number in words and figures differ (${d.mismatch}).`);
  if (VAGUE.test(clause)) reasons.push("Qualified wording.");
  if (afterWord) reasons.push("'after' rather than 'from' — the period may be counted from the day after the start date.");
  if (!reasons.length) return { ...r, months };
  return { ...r, months, status: "needs_review", reason: reasons.join(" "), alternatives: r.date ? [
    { date: r.date, reading: "period includes the start date" },
    { date: addMonths(start, months), reading: "period counted from the day after the start date" },
  ] : [] };
}
