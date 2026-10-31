import { addDays, endOfMonth, format, parseISO } from "date-fns";
import { localDate } from "@/lib/util/time";

/**
 * Deadlines and commitments in email (workflow 04). The model (or the deterministic mock below) only quotes WHO, WHAT and
 * the verbatim date phrase. Turning that phrase into a calendar date is done here in code (rule S5: no LLM date maths).
 * Ambiguous phrases ("next Friday", "early next month") stay unknown (rule S6) — the task gets no due date.
 */
export type CommitmentWho = "sender" | "adviser" | "other";
export interface ExtractedCommitment {
  kind: "deadline" | "commitment";
  who: CommitmentWho;
  who_name: string | null;
  what: string;
  due_text: string | null;
  evidence: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MON = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DAY = "\\d{1,2}(?:st|nd|rd|th)?";
const DATE_ALTERNATIVES = [
  "\\d{4}-\\d{2}-\\d{2}",
  `${DAY}\\s+${MON}(?:,?\\s+\\d{4})?`,
  `${MON}\\s+${DAY}(?:,?\\s+\\d{4})?`,
  "\\d{1,2}[/.-]\\d{1,2}(?:[/.-]\\d{2,4})?",
  "(?:next\\s+|this\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)",
  "tomorrow", "today", "tonight", "eod", "end of (?:the )?(?:day|week|month)",
];
const DATE_RE = new RegExp(`(?:by|before|on|until|till|no later than|latest by|deadline(?: is)?|due(?: on| by)?|expires?(?: on)?|valid (?:till|until)|last date(?: is)?)\\s*:?\\s*(${DATE_ALTERNATIVES.join("|")})\\b`, "i");
const DEADLINE_WORDS = /(deadline|last date|expir|lock[- ]?in|notice period|\bdue\b|valid (till|until)|no later than|offer)/i;
const SENDER_PROMISE = /(^|[\s,;])(i|we)\s*('ll|’ll| will| shall| would| can| am going to| are going to)\b/i;
const ASK_ADVISER = /\b(can you|could you|would you|please|kindly|you will|you'll|need you to|request you to|we need|send (us|me)|share (us|me|the))\b/i;

/** Pure: resolve a verbatim date phrase relative to the message's local date. Returns YYYY-MM-DD or null (unknown). */
export function resolveDueDate(dueText: string | null | undefined, receivedAt: string, tz = "Asia/Kolkata"): string | null {
  if (!dueText) return null;
  const t = dueText.trim().toLowerCase().replace(/\s+/g, " ");
  const base = localDate(new Date(receivedAt), tz);
  const baseDate = parseISO(base);
  const iso = (d: Date) => format(d, "yyyy-MM-dd");
  const valid = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  };
  const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const withYear = (m: number, d: number, y: number | null) => {
    if (y !== null) return valid(y, m, d) ? ymd(y, m, d) : null;
    const by = Number(base.slice(0, 4));
    if (!valid(by, m, d)) return null;
    const cand = ymd(by, m, d);
    // no year given and the date already passed => next year (an email never sets a deadline in the past)
    return cand < base ? (valid(by + 1, m, d) ? ymd(by + 1, m, d) : null) : cand;
  };
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return valid(+m[1], +m[2], +m[3]) ? ymd(+m[1], +m[2], +m[3]) : null;
  if ((m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?(?:,?\s+(\d{4}))?$/))) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3));
    return mi < 0 ? null : withYear(mi + 1, +m[1], m[3] ? +m[3] : null);
  }
  if ((m = t.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/))) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3));
    return mi < 0 ? null : withYear(mi + 1, +m[2], m[3] ? +m[3] : null);
  }
  if ((m = t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/))) {
    // India: DD/MM[/YYYY]
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
    return withYear(+m[2], +m[1], y);
  }
  if (t === "today" || t === "tonight" || t === "eod" || t === "end of day" || t === "end of the day") return base;
  if (t === "tomorrow") return iso(addDays(baseDate, 1));
  if (t === "end of month" || t === "end of the month") return iso(endOfMonth(baseDate));
  if (t === "end of week" || t === "end of the week") {
    const dow = baseDate.getDay();
    return iso(addDays(baseDate, dow <= 5 ? 5 - dow : 6)); // coming Friday (working week)
  }
  if ((m = t.match(/^(this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/))) {
    const target = WEEKDAYS.indexOf(m[2]);
    const diff = (target - baseDate.getDay() + 7) % 7;
    return iso(addDays(baseDate, diff));
  }
  return null; // "next friday", "early next month", ... are ambiguous: unknown stays unknown
}

const sentences = (text: string) =>
  text.replace(/\r/g, "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length >= 8 && s.length <= 400);

/** Deterministic extraction used in mock mode and as a baseline: dated asks/deadlines and first-person promises. */
export function extractCommitmentsMock(text: string, fromName: string | null): ExtractedCommitment[] {
  const out: ExtractedCommitment[] = [];
  const seen = new Set<string>();
  for (const s of sentences(text)) {
    if (/^(on .* wrote:|from:|sent:|to:|subject:)/i.test(s)) continue;
    const dm = s.match(DATE_RE);
    const promise = SENDER_PROMISE.test(s);
    const ask = ASK_ADVISER.test(s);
    if (!dm && !promise) continue;
    const kind: ExtractedCommitment["kind"] = DEADLINE_WORDS.test(s) && !promise ? "deadline" : "commitment";
    const who: CommitmentWho = promise ? "sender" : ask ? "adviser" : kind === "deadline" ? "adviser" : "other";
    const what = s.replace(/^(hi|hello|dear)\b[^,]*,\s*/i, "").replace(/[.!]+$/, "").slice(0, 200);
    const key = what.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, who, who_name: who === "sender" ? fromName : null, what, due_text: dm ? dm[1] : null, evidence: s.slice(0, 300) });
    if (out.length >= 6) break;
  }
  return out;
}

/** Stable identity of one commitment within a message (dedupe key for its task). */
export function commitmentKey(c: Pick<ExtractedCommitment, "kind" | "who" | "what">) {
  return `${c.kind}:${c.who}:${c.what.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120)}`;
}

/** Task title for a commitment. Sender promises become "expect from" follow-ups; asks/deadlines become actions. */
export function commitmentTaskTitle(c: ExtractedCommitment, sender: string) {
  if (c.who === "sender") return `Expect from ${sender}: ${c.what}`.slice(0, 200);
  if (c.kind === "deadline") return `Deadline (${sender}): ${c.what}`.slice(0, 200);
  return `${c.what} — ${sender}`.slice(0, 200);
}
