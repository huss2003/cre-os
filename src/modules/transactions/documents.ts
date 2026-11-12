/**
 * Deterministic agreement comparison (§11) — PURE. Clause diff, changed dates / money / obligations, and reconciliation
 * of a document against the agreed commercial points. AI may only add suggestions on top (service layer); it never
 * clears or approves anything.
 */
export interface Clause { key: string; heading: string; text: string }

const CLAUSE_RE = /^\s*(?:clause\s+)?(\d+(?:\.\d+)*)[.)]?\s+(.*)$/i;

export function splitClauses(body: string): Clause[] {
  const lines = body.replace(/\r/g, "").split("\n");
  const out: Clause[] = [];
  let cur: Clause | null = null; let n = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const m = CLAUSE_RE.exec(line);
    if (m && !/^\d+(\.\d+)?\s*(%|months?|years?|sf|sq)/i.test(m[2])) {
      if (cur) out.push(cur);
      cur = { key: m[1], heading: m[2].split(/[.:]/)[0].trim().slice(0, 80), text: m[2].trim() };
    } else if (line.trim() === "") {
      if (cur && !/^\d/.test(cur.key)) { out.push(cur); cur = null; }
    } else if (cur) cur.text += `\n${line.trim()}`;
    else { n += 1; cur = { key: `p${n}`, heading: line.trim().slice(0, 60), text: line.trim() }; }
  }
  if (cur) out.push(cur);
  return out;
}

const DATE_RE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4})\b/gi;
const MONEY_RE = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s*(%|percent|months?|years?)/gi;
const OBLIG_RE = /[^.\n]*\b(shall|must|will be responsible|undertakes?)\b[^.\n]*/gi;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const all = (re: RegExp, s: string) => [...s.matchAll(re)].map((m) => norm(m[0]));

export interface ClauseChange { key: string; heading: string; change: "added" | "removed" | "modified"; before: string | null; after: string | null;
  dates: { before: string[]; after: string[] } | null; financial: { before: string[]; after: string[] } | null; obligations: { before: string[]; after: string[] } | null }

export function diffAgreements(prevBody: string, nextBody: string): { changes: ClauseChange[]; summary: { added: number; removed: number; modified: number; datesChanged: number; financialChanged: number; obligationsChanged: number } } {
  const a = splitClauses(prevBody); const b = splitClauses(nextBody);
  const ka = new Map(a.map((c) => [c.key, c])); const kb = new Map(b.map((c) => [c.key, c]));
  const changes: ClauseChange[] = [];
  const pair = (x: string[], y: string[]) => (JSON.stringify([...x].sort()) === JSON.stringify([...y].sort()) ? null : { before: x, after: y });
  for (const c of a) if (!kb.has(c.key)) changes.push({ key: c.key, heading: c.heading, change: "removed", before: c.text, after: null, dates: null, financial: null, obligations: null });
  for (const c of b) {
    const p = ka.get(c.key);
    if (!p) { changes.push({ key: c.key, heading: c.heading, change: "added", before: null, after: c.text, dates: null, financial: null, obligations: null }); continue; }
    if (norm(p.text) === norm(c.text)) continue;
    changes.push({ key: c.key, heading: c.heading, change: "modified", before: p.text, after: c.text,
      dates: pair(all(DATE_RE, p.text), all(DATE_RE, c.text)), financial: pair(all(MONEY_RE, p.text), all(MONEY_RE, c.text)),
      obligations: pair(all(OBLIG_RE, p.text), all(OBLIG_RE, c.text)) });
  }
  changes.sort((x, y) => x.key.localeCompare(y.key, undefined, { numeric: true }));
  return { changes, summary: {
    added: changes.filter((c) => c.change === "added").length, removed: changes.filter((c) => c.change === "removed").length,
    modified: changes.filter((c) => c.change === "modified").length, datesChanged: changes.filter((c) => c.dates).length,
    financialChanged: changes.filter((c) => c.financial).length, obligationsChanged: changes.filter((c) => c.obligations).length,
  } };
}

// ---------------------------------------------------------------------------------------------- term extraction
const NUM = "([\\d,]+(?:\\.\\d+)?)";
const PATTERNS: { key: string; re: RegExp; unit?: "months_or_years" }[] = [
  { key: "rentPerSf", re: new RegExp(`(?:base\\s+)?rent[^.\\n%]{0,60}?(?:₹|rs\\.?|inr)\\s*${NUM}\\s*(?:/|per)\\s*(?:sq\\.?\\s*ft|sf|sft|square\\s+feet)`, "i") },
  { key: "camPerSf", re: new RegExp(`(?:cam|common area maintenance)[^.\\n%]{0,60}?(?:₹|rs\\.?|inr)\\s*${NUM}\\s*(?:/|per)\\s*(?:sq\\.?\\s*ft|sf|sft|square\\s+feet)`, "i") },
  { key: "depositMonths", re: new RegExp(`(?:security\\s+)?deposit[^.\\n]{0,60}?${NUM}\\s*months?`, "i") },
  { key: "rentFreeMonths", re: new RegExp(`rent[- ]free[^.\\n]{0,40}?${NUM}\\s*months?`, "i") },
  { key: "lockInMonths", re: new RegExp(`lock[- ]in[^.\\n]{0,40}?${NUM}\\s*(months?|years?)`, "i"), unit: "months_or_years" },
  { key: "escalationPct", re: new RegExp(`escalat\\w*[^.\\n]{0,60}?${NUM}\\s*(?:%|percent)`, "i") },
  { key: "tenureMonths", re: new RegExp(`(?:term|tenure|duration)\\s+of(?:\\s+the\\s+lease)?[^.\\n]{0,30}?${NUM}\\s*(months?|years?)`, "i"), unit: "months_or_years" },
  { key: "fitoutContribution", re: new RegExp(`fit[- ]?out[^.\\n]{0,60}?(?:₹|rs\\.?|inr)\\s*${NUM}`, "i") },
  { key: "areaSf", re: new RegExp(`${NUM}\\s*(?:sq\\.?\\s*ft|sf|sft|square\\s+feet)\\b(?![^.\\n]{0,5}(?:/|per))`, "i") },
  { key: "possessionDate", re: /possession[^.\n]{0,40}?(\d{4}-\d{2}-\d{2})/i },
];

/** Extract stated terms from text. A value not found is simply absent (unknown), never 0. Durations are in months. */
export function extractTerms(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    let v = m[1].replace(/,/g, "");
    if (p.unit === "months_or_years" && /year/i.test(m[2] ?? "")) v = String(Number(v) * 12); // stated unit conversion, not commercial maths
    out[p.key] = v;
  }
  return out;
}

export interface Reconciliation { key: string; label: string; agreed: string | null; document: string | null; status: "match" | "mismatch" | "missing_in_document" }

const same = (a: string, b: string) => (/^-?[\d.]+$/.test(a) && /^-?[\d.]+$/.test(b) ? Number(a) === Number(b) : a.trim().toLowerCase() === b.trim().toLowerCase());

/** §11.2 compare the document against the agreed commercial position (agreed-or-later points only). */
export function reconcile(docText: string, agreed: { term_key: string; label: string; value: string | null }[]): Reconciliation[] {
  const found = extractTerms(docText);
  return agreed.filter((p) => PATTERNS.some((x) => x.key === p.term_key)).map((p) => {
    const d = found[p.term_key] ?? null;
    return { key: p.term_key, label: p.label, agreed: p.value, document: d, status: d === null ? "missing_in_document" : p.value !== null && same(p.value, d) ? "match" : "mismatch" };
  });
}

// ---------------------------------------------------------------------------------------------- commitments in messages
const COMMERCIAL_WORDS = /\b(rent|cam|deposit|rent[- ]free|escalation|lock[- ]in|tenure|fit[- ]?out|possession|counter[- ]?offer|offer|accept|agree[ds]?|concession|per\s*(?:sq\.?\s*ft|sf))\b/i;
const FIGURE = /(?:₹|rs\.?|inr)\s*[\d,]+|\b\d+(?:\.\d+)?\s*(?:%|months?|years?|sf|sq\.?\s*ft)\b|\b\d{4}-\d{2}-\d{2}\b/i;
/** True when a message would communicate commercial terms (a figure next to a commercial word, or acceptance language). */
export function mentionsCommercialTerms(text: string): boolean {
  if (/\b(we|client)\s+(accept|agree|confirm)s?\b/i.test(text)) return true;
  return COMMERCIAL_WORDS.test(text) && FIGURE.test(text);
}
