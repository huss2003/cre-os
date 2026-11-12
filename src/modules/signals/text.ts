/**
 * Pure text helpers for pasted / adapter text (untrusted — pattern-matched only, S7) and for plain-language labels.
 *  - extractCompanyName: "Quillwave Robotics announces …" → "Quillwave Robotics" (a candidate, never auto-linked)
 *  - eventDateFromText: "from Q1 2027", "by March 2027", "next quarter", "15 March 2027" → { date, basis }
 *  - counterCue: text that argues AGAINST a space need ("will work remotely", "no additional office space")
 *  - shortAction / humanize / plural: UI copy
 */
import { citiesIn } from "./engine";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthIdx = (m: string) => MONTHS.findIndex((x) => x.startsWith(m.toLowerCase().slice(0, 3)));
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const valid = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= lastDay(y, m);

export type DateBasis = "announced" | "estimated";
export interface TextDate { date: string; basis: DateBasis; phrase: string }

/**
 * Event date stated in the text. A full calendar date is "announced"; a month, quarter, year or relative phrase is
 * "estimated" (start of the period, or its end after "by / before / end of"). Nothing is guessed when no phrase matches.
 * Quarters are calendar quarters unless written "FY" (Indian fiscal year: Q1 FY27 = Apr–Jun 2026).
 */
export function eventDateFromText(text: string, ref: string): TextDate | null {
  const t = text.replace(/\s+/g, " ");
  const by = (pre?: string) => !!pre && /^(by|before|until|till|end of|by the end of)$/i.test(pre.trim());
  let m: RegExpMatchArray | null;
  if ((m = t.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/)) && valid(+m[1], +m[2], +m[3])) return { date: m[0], basis: "announced", phrase: m[0] };
  if ((m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? ${MON},? (20\\d\\d)\\b`, "i"))) && valid(+m[3], monthIdx(m[2]) + 1, +m[1]))
    return { date: ymd(+m[3], monthIdx(m[2]) + 1, +m[1]), basis: "announced", phrase: m[0] };
  if ((m = t.match(new RegExp(`\\b${MON} (\\d{1,2})(?:st|nd|rd|th)?,? (20\\d\\d)\\b`, "i"))) && valid(+m[3], monthIdx(m[1]) + 1, +m[2]))
    return { date: ymd(+m[3], monthIdx(m[1]) + 1, +m[2]), basis: "announced", phrase: m[0] };
  if ((m = t.match(/\b(by the end of|by|before|until|till|end of|from|in|during|starting|beginning)?\s*Q([1-4])\s*(FY\s*)?'?((?:20)?\d\d)\b/i))) {
    let y = +m[4]; if (y < 100) y += 2000;
    const q = +m[2];
    let startM = (q - 1) * 3 + 1;
    if (m[3]) { startM += 3; y -= 1; if (startM > 12) { startM -= 12; y += 1; } }
    const endM = startM + 2;
    return { date: by(m[1]) ? ymd(y, endM, lastDay(y, endM)) : ymd(y, startM, 1), basis: "estimated", phrase: m[0].trim() };
  }
  if ((m = t.match(new RegExp(`\\b(by the end of|by|before|until|till|end of|from|in|during|starting|beginning|early|mid|late)?\\s*${MON},? (20\\d\\d)\\b`, "i")))) {
    const y = +m[3]; const mo = monthIdx(m[2]) + 1;
    return { date: by(m[1]) ? ymd(y, mo, lastDay(y, mo)) : ymd(y, mo, 1), basis: "estimated", phrase: m[0].trim() };
  }
  const [ry, rm] = ref.split("-").map(Number);
  if ((m = t.match(/\bnext quarter\b/i))) {
    let q = Math.floor((rm - 1) / 3) + 1 + 1; let y = ry; if (q > 4) { q = 1; y += 1; }
    return { date: ymd(y, (q - 1) * 3 + 1, 1), basis: "estimated", phrase: m[0] };
  }
  if ((m = t.match(/\bnext month\b/i))) { const y = rm === 12 ? ry + 1 : ry; const mo = rm === 12 ? 1 : rm + 1; return { date: ymd(y, mo, 1), basis: "estimated", phrase: m[0] }; }
  if ((m = t.match(/\bnext year\b/i))) return { date: ymd(ry + 1, 1, 1), basis: "estimated", phrase: m[0] };
  if ((m = t.match(/\b(by the end of|by|before|end of|from|in|during|starting)\s+(20\d\d)\b/i))) {
    const y = +m[2];
    return { date: by(m[1]) ? ymd(y, 12, 31) : ymd(y, 1, 1), basis: "estimated", phrase: m[0] };
  }
  return null;
}

const VERB = "announce[sd]?|said|says|plans?|planned|will|has|have|is|was|to|signs?|signed|opens?|opened|expands?|expanded|expanding|raises?|raised|leases?|leased|acquires?|acquired|launch(?:es|ed)?|hires?|hired|inaugurat\\w*|unveil\\w*|reported|reports|moves?|moved|relocat\\w*|consolidat\\w*|cuts?|lays?|laid|appoint\\w*|named|confirms?|confirmed|sets?|setting|takes?|took|shuts?|closes?|closed|exits?|announcing";
const WORD = "[A-Z][A-Za-z0-9&'.\\-]*";
const STOP = new Set(["the", "a", "an", "in", "on", "at", "this", "that", "its", "it", "our", "we", "they", "new", "according", "today", "yesterday", "india", "indian", "government", "state", "city", "news", "report", "sources", "mr", "ms", "dr", ...MONTHS]);

/** First "<Capitalised Name> <verb>" in the text, e.g. "Quillwave Robotics announces …" → "Quillwave Robotics". */
export function extractCompanyName(text: string): string | null {
  const re = new RegExp(`(?:^|[.!?;:"“(]\\s*|\\s)(${WORD}(?:\\s+(?:${WORD}|&|of|and))*)(?:'s|’s)?\\s+(?:${VERB})\\b`, "g");
  for (const m of text.slice(0, 2000).matchAll(re)) {
    let words = m[1].split(/\s+/);
    while (words.length && STOP.has(words[0].toLowerCase().replace(/[^a-z]/g, ""))) words = words.slice(1);
    while (words.length && /^(of|and|&)$/i.test(words[words.length - 1])) words = words.slice(0, -1);
    if (!words.length || words.length > 6) continue;
    const name = words.join(" ").replace(/[.,]+$/, "");
    if (name.length < 3) continue;
    // A place is not a company ("Pune will get …").
    if (words.every((w) => citiesIn([w]).length > 0)) continue;
    return name;
  }
  return null;
}

const COUNTER = /\bwork(?:ing)?\s+(?:fully\s+|entirely\s+)?remote(?:ly)?\b|\bremote[- ]first\b|\bfully remote\b|\bno (?:additional|new|extra|more) (?:office )?(?:space|office|offices|premises)\b|\bwill not (?:need|require|take|lease|add) (?:any )?(?:additional |new |more )?(?:office )?(?:space|offices?)\b|\bdoes not (?:need|require|plan to take) (?:any )?(?:additional |new )?(?:office )?space\b|\bno plans? (?:to|for) (?:a )?(?:new |additional )?(?:office|space|expansion)\b|\b(?:put|kept|placed) on hold\b|\bshelved\b|\bscrapp(?:ed|ing)\b|\bcall(?:ed|s) off\b|\b(?:cancel(?:led|ed|s)?|withdr[ae]wn?) (?:the |its )?(?:plan|expansion|office|lease)/i;
/** True when the text argues against a space need (counter-evidence, spec §14). */
export const counterCue = (text: string) => COUNTER.test(text);

/** Short task title (≤ max chars, cut at a word boundary) from a long recommended action. */
export function shortAction(text: string, max = 80): string {
  const first = text.split(" On record:")[0].split(" Possible outcomes")[0].trim();
  const sentence = (first.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? first).replace(/[.!?]+$/, "");
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).replace(/[,;:\-–—\s]+$/, "")}…`;
}

const WORDS: Record<string, string> = {
  calculated_from_source_tenure: "Calculated from the lease tenure", contractual: "Contractual", reported: "Reported", estimated: "Estimated", announced: "Announced",
  unknown: "Unknown", confirmed: "Confirmed", manual_paste: "Pasted text", user_upload: "Uploaded document", database: "CRE OS records", rss: "News feed",
  single_unverified: "Single unverified source", credible_reported: "Credible report", documentary_current: "Current document", ai_inference: "AI inference",
  currently_confirmed: "Currently confirmed", external_id: "Company identifier", exact_name: "Exact name", alias: "Approved alias", multiple_identifiers: "Several identifiers",
  ambiguous: "Several possible matches", user_selected: "Chosen by a user", options_visits: "Options & site visits",
};
/** Plain label for a stored code: known words first, otherwise "snake_case" → "Snake case". Empty / "none" → "". */
export function humanize(v: string | null | undefined): string {
  if (!v || v === "none" || v === "(none)") return "";
  if (WORDS[v]) return WORDS[v];
  const s = String(v).replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "1 month" / "3 months". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
