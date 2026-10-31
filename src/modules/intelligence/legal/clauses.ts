/**
 * Legal desk — deterministic clause extraction, redline comparison and exposure checklist.
 * This is the gateway `mock` and the validation baseline. Output is ALWAYS "for review by the tenant's legal team —
 * not legal advice"; a generated redline is never legal approval. No arithmetic beyond parsing stated numbers.
 */
import { LEGAL_DISCLAIMER } from "../common";

export const ENGINE_VERSION = "legal-v1";
export { LEGAL_DISCLAIMER };

export const CLAUSE_TYPES = ["rent", "escalation", "lock_in", "notice", "term", "deposit", "cam", "fit_out", "reinstatement", "termination", "indemnity"] as const;
export type ClauseType = (typeof CLAUSE_TYPES)[number];
export const CLAUSE_LABEL: Record<ClauseType, string> = {
  rent: "Rent", escalation: "Escalation", lock_in: "Lock-in", notice: "Notice", term: "Term / tenure", deposit: "Security deposit",
  cam: "CAM / maintenance", fit_out: "Fit-out / rent-free", reinstatement: "Reinstatement", termination: "Termination", indemnity: "Indemnity / liability",
};

// More specific types first; rent is generic and weakest.
const PATTERNS: [ClauseType, RegExp, number][] = [
  ["lock_in", /lock[\s-]?in/gi, 3],
  ["escalation", /escalat\w*|increase[sd]? (?:in |of )?(?:the )?(?:rent|licen[cs]e fee)|enhance(?:d|ment)? by/gi, 3],
  ["deposit", /security deposit|interest[- ]free refundable|refundable (?:security )?deposit|\bdeposit\b/gi, 3],
  ["cam", /\bCAM\b|common area maintenance|maintenance charges?/gi, 3],
  ["fit_out", /fit[\s-]?out|rent[\s-]?free|interiors? (?:period|works)/gi, 3],
  ["reinstatement", /reinstat\w*|restor(?:e|ation) (?:the premises|to)|bare[\s-]?shell condition|original condition|hand(?:ed|ing)? back/gi, 3],
  ["indemnity", /indemn\w*|liabilit(?:y|ies)|consequential loss/gi, 3],
  ["termination", /terminat\w*|break (?:clause|option)|early exit|determine (?:this|the) (?:lease|agreement)/gi, 2],
  ["notice", /\bnotice\b/gi, 1],
  ["term", /\bterm\b|tenure|lease period|period of (?:the )?(?:lease|licen[cs]e)|renewal/gi, 1],
  ["rent", /\brent(?:al)?\b|licen[cs]e fee|monthly (?:charges|compensation)/gi, 1],
];

export interface Locator { line_start: number; line_end: number; char_start: number; char_end: number; page: number | null }
export interface ExtractedClause { clause_type: ClauseType; heading: string | null; clause_text: string; locator: Locator; extracted_values: Record<string, unknown> }

interface Segment { heading: string | null; lines: string[]; line_start: number; line_end: number; char_start: number; char_end: number; page: number | null }

const HEADING_NUM = /^\s*(?:clause\s+|article\s+|section\s+)?(\d{1,2}(?:\.\d{1,2})*)[.)]?\s+([A-Za-z][A-Za-z &/,'()\-]{1,50})[:.]?\s*$/i;
const HEADING_CAPS = /^\s*([A-Z][A-Z0-9 &/,'()\-]{3,60}):?\s*$/;
const INLINE_LABEL = /^\s*(?:\d{1,2}(?:\.\d{1,2})*[.)]?\s+)?([A-Z][A-Za-z /&()\-]{2,40}):\s+(\S.*)$/;
const NUMBERED_PARA = /^\s*(?:clause\s+)?(\d{1,2}(?:\.\d{1,2})*)[.)]\s+(\S.*)$/i;
const PAGE_MARK = /^\s*(?:-\s*)?page\s+(\d+)(?:\s+of\s+\d+)?(?:\s*-)?\s*$/i;

export function segment(text: string): Segment[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  let offset = 0;
  let page: number | null = null;
  const close = () => { if (cur && cur.lines.join("").trim()) segs.push(cur); cur = null; };
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const start = offset;
    offset += rawLine.length + 1;
    let line = rawLine;
    if (line.includes("\f")) { page = (page ?? 1) + 1; line = line.replace(/\f/g, ""); }
    const pm = line.match(PAGE_MARK);
    if (pm) { page = Number(pm[1]); return; }
    if (!line.trim()) { // blank line ends un-headed paragraphs only
      if (cur && !cur.heading) close();
      return;
    }
    const h = line.match(HEADING_NUM) ?? (line.trim().length <= 60 ? line.match(HEADING_CAPS) : null);
    const inline = line.match(INLINE_LABEL);
    const numbered = line.match(NUMBERED_PARA);
    if (h) {
      close();
      cur = { heading: (h[2] ?? h[1]).trim(), lines: [], line_start: lineNo, line_end: lineNo, char_start: start, char_end: start + rawLine.length, page };
      return;
    }
    if (inline) {
      close();
      segs.push({ heading: inline[1].trim(), lines: [inline[2]], line_start: lineNo, line_end: lineNo, char_start: start, char_end: start + rawLine.length, page });
      return;
    }
    if (numbered && (!cur || cur.lines.length > 0)) {
      close();
      cur = { heading: null, lines: [numbered[2]], line_start: lineNo, line_end: lineNo, char_start: start, char_end: start + rawLine.length, page };
      return;
    }
    if (!cur) cur = { heading: null, lines: [], line_start: lineNo, line_end: lineNo, char_start: start, char_end: start, page };
    cur.lines.push(line.trim());
    cur.line_end = lineNo;
    cur.char_end = start + rawLine.length;
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
  return v;
}

/** Heuristic extractor (deterministic). Each clause keeps its source wording and line/char/page locator. */
export function extractClauses(text: string): ExtractedClause[] {
  const out: ExtractedClause[] = [];
  for (const s of segment(text)) {
    const body = s.lines.join(" ").replace(/\s+/g, " ").trim();
    if (!body && !s.heading) continue;
    const type = classify(s.heading, body);
    if (!type) continue;
    const clauseText = body || s.heading || "";
    out.push({
      clause_type: type, heading: s.heading, clause_text: clauseText,
      locator: { line_start: s.line_start, line_end: s.line_end, char_start: s.char_start, char_end: s.char_end, page: s.page },
      extracted_values: extractValues(type, `${s.heading ?? ""} ${body}`),
    });
  }
  return out;
}

/** Anti-hallucination: keep model-extracted clauses only if their wording appears in the source text. */
export function validateAgainstSource(text: string, clauses: ExtractedClause[]): ExtractedClause[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const src = norm(text);
  return clauses.filter((c) => src.includes(norm(c.clause_text).slice(0, 80)));
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
  ops: WordOp[];
  value_changes: { key: string; from: unknown; to: unknown }[];
}

function joinType(cs: ExtractedClause[], t: ClauseType) {
  const m = cs.filter((c) => c.clause_type === t);
  if (!m.length) return null;
  const values: Record<string, unknown> = {};
  for (const c of m) for (const [k, v] of Object.entries(c.extracted_values)) if (values[k] === undefined) values[k] = v;
  return { text: m.map((c) => c.clause_text).join("\n"), locator: m[0].locator, values };
}

export function compareClauses(base: ExtractedClause[], next: ExtractedClause[]): ClauseDiff[] {
  const out: ClauseDiff[] = [];
  for (const t of CLAUSE_TYPES) {
    const a = joinType(base, t), b = joinType(next, t);
    if (!a && !b) continue;
    if (a && !b) { out.push({ clause_type: t, change: "removed", base_text: a.text, new_text: null, base_locator: a.locator, new_locator: null, ops: [{ op: "del", text: a.text }], value_changes: [] }); continue; }
    if (!a && b) { out.push({ clause_type: t, change: "added", base_text: null, new_text: b.text, base_locator: null, new_locator: b.locator, ops: [{ op: "ins", text: b.text }], value_changes: [] }); continue; }
    const same = a!.text.replace(/\s+/g, " ") === b!.text.replace(/\s+/g, " ");
    const keys = new Set([...Object.keys(a!.values), ...Object.keys(b!.values)]);
    const value_changes = [...keys].filter((k) => JSON.stringify(a!.values[k] ?? null) !== JSON.stringify(b!.values[k] ?? null)).map((k) => ({ key: k, from: a!.values[k] ?? null, to: b!.values[k] ?? null }));
    out.push({ clause_type: t, change: same ? "unchanged" : "changed", base_text: a!.text, new_text: b!.text, base_locator: a!.locator, new_locator: b!.locator, ops: same ? [{ op: "eq", text: b!.text }] : wordDiff(a!.text, b!.text), value_changes });
  }
  return out;
}

// ------------------------------------------------------------------ exposure checklist
export interface ExposureItem {
  clause_type: ClauseType;
  locator: Locator | null;
  excerpt: string | null;
  exposure: string;
  question: string;
  alternative: string;
  severity: "low" | "medium" | "high";
  reviewer_status: "pending_legal_review";
}

const CORE: ClauseType[] = ["rent", "escalation", "lock_in", "notice", "term", "deposit", "cam", "fit_out", "reinstatement", "termination", "indemnity"];

export function exposureChecklist(clauses: ExtractedClause[], diff?: ClauseDiff[]): ExposureItem[] {
  const items: ExposureItem[] = [];
  const add = (c: ExtractedClause | null, t: ClauseType, exposure: string, question: string, alternative: string, severity: ExposureItem["severity"]) =>
    items.push({ clause_type: t, locator: c?.locator ?? null, excerpt: c ? c.clause_text.slice(0, 280) : null, exposure, question, alternative, severity, reviewer_status: "pending_legal_review" });
  const first = (t: ClauseType) => clauses.find((c) => c.clause_type === t) ?? null;

  for (const t of CORE) if (!first(t)) add(null, t, `${CLAUSE_LABEL[t]} wording not found in this text.`, `Is ${CLAUSE_LABEL[t].toLowerCase()} covered elsewhere (schedule, annexure, master lease)?`, "Ask for the clause to be stated explicitly in this document.", t === "rent" || t === "term" ? "high" : "medium");

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

  for (const d of diff ?? []) {
    if (d.change === "unchanged") continue;
    const c = clauses.find((x) => x.clause_type === d.clause_type) ?? null;
    const what = d.change === "removed" ? "removed in this version" : d.change === "added" ? "added in this version" : `changed${d.value_changes.length ? ` (${d.value_changes.map((v) => `${v.key}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`).join("; ")})` : ""}`;
    add(c, d.clause_type, `${CLAUSE_LABEL[d.clause_type]} ${what}.`, "Was this change agreed commercially, and does it match the approved term sheet?", "Confirm with the client and reflect the agreed position; flag for legal review.", d.change === "removed" || d.value_changes.length > 0 ? "high" : "medium");
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
