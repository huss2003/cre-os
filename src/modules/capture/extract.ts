import { z } from "zod";
import { localDate } from "@/lib/util/time";
import { FIELD_BY_KEY, STAKEHOLDER_ROLES } from "@/modules/deals/requirements/contract";

/**
 * Capture extraction contract (spec Part III "Example extraction/change contract", schema_version 1) and the
 * deterministic rule-based extractor used as the mock (and as the safety net applied to every model output).
 * English and Roman-script Hinglish are handled by rules (no AI needed); Devanagari digits are normalised.
 *
 * Rules that are code, never model judgement:
 *  - critical numbers (area/seats/budget) and dates always require confirmation;
 *  - confusable number words ("fifty"/"fifteen", "saat"/"saath", ...) become an ambiguity, never a value;
 *  - a bare amount without a unit ("20k", "bees hazaar") is a UNIT question (sq ft vs rupees) — never assumed;
 *  - a month without a year ("by March", "March tak") or a bare weekday ("Friday ko") becomes an ambiguity with options;
 *  - entity IDs may only come from the permission-scoped candidate lists.
 */

export const FACT_FIELDS = ["area_target_sf", "seats_target", "budget_max", "occupation_date", "decision_date", "preferred_geography"] as const;
export type FactField = (typeof FACT_FIELDS)[number];
export const CRITICAL_FIELDS: FactField[] = ["area_target_sf", "seats_target", "budget_max", "occupation_date", "decision_date"];
/** Requirement contract keys (src/modules/deals/requirements/contract.ts) stored in requirement.constraints.values. */
export const DETAIL_KEYS = ["parking", "power", "transit", "security_access", "fitout_standard", "tenure_months", "lockin_months", "expansion", "employee_catchments"] as const;
export type DetailKey = (typeof DETAIL_KEYS)[number];
for (const k of DETAIL_KEYS) if (!FIELD_BY_KEY.has(k) || FIELD_BY_KEY.get(k)!.columns) throw new Error(`capture detail key ${k} is not a constraints field of the requirement contract`);

const span = { start: z.number().int().nonnegative(), end: z.number().int().nonnegative() };

export const MentionSchema = z.object({
  kind: z.enum(["person", "organisation", "geography"]),
  text: z.string().min(1).max(120),
  ...span,
  candidate_ids: z.array(z.string()).max(10),
});
export const FactSchema = z.object({
  entity_type: z.literal("requirement"),
  field: z.enum(FACT_FIELDS),
  proposed_value: z.union([z.number(), z.string(), z.null()]),
  raw_text: z.string().max(200),
  unit: z.string().nullable(),
  status: z.enum(["reported", "tentative"]),
  requires_confirmation: z.boolean(),
  ...span,
});
export const TaskSchema = z.object({
  description: z.string().min(1).max(300),
  due_date: z.string().nullable(),            // yyyy-mm-dd (tentative when an ambiguity references it)
  ...span,
});
export const AmbiguitySchema = z.object({
  kind: z.enum(["date", "number", "entity", "unit"]),
  question: z.string().max(300),
  options: z.array(z.object({ label: z.string(), value: z.union([z.string(), z.number(), z.null()]) })).max(10),
  fact_index: z.number().int().nullable(),
  task_index: z.number().int().nullable(),
  mention_index: z.number().int().nullable(),
  ...span,
});
export const DraftSchema = z.object({
  channel: z.enum(["email", "whatsapp"]),
  purpose: z.string().max(200),
  body: z.string().max(4000),
  recipient_mention_index: z.number().int().nullable(),
  task_index: z.number().int().nullable(),
});
/** A commitment made in the conversation. who = "me" (the adviser/user) or the counterparty's name. */
export const PromiseSchema = z.object({
  who: z.string().min(1).max(120),
  who_mention_index: z.number().int().nullable(),
  what: z.string().min(1).max(300),
  due: z.string().nullable(),                  // yyyy-mm-dd, tentative while an overlapping date question is open
  task_index: z.number().int().nullable(),
  ...span,
});
export const ObjectionSchema = z.object({ text: z.string().min(1).max(300), ...span });
export const StakeholderSchema = z.object({
  mention_index: z.number().int(),
  role: z.enum(STAKEHOLDER_ROLES),
  raw_text: z.string().max(200),
  ...span,
});
export const DetailSchema = z.object({
  key: z.enum(DETAIL_KEYS),
  value: z.union([z.string(), z.number(), z.null()]),
  raw_text: z.string().max(300),
  ...span,
});
export const ExtractionSchema = z.object({
  schema_version: z.literal("1"),
  interaction: z.object({ channel: z.enum(["call", "meeting", "visit", "whatsapp", "email", "note"]), summary: z.string().max(1000) }).nullable(),
  mentions: z.array(MentionSchema).max(30),
  facts: z.array(FactSchema).max(30),
  tasks: z.array(TaskSchema).max(20),
  ambiguities: z.array(AmbiguitySchema).max(30),
  drafts: z.array(DraftSchema).max(5),
  promises: z.array(PromiseSchema).max(20),
  objections: z.array(ObjectionSchema).max(20),
  stakeholders: z.array(StakeholderSchema).max(20),
  details: z.array(DetailSchema).max(20),
});
export type Extraction = z.infer<typeof ExtractionSchema>;
export type Mention = z.infer<typeof MentionSchema>;
export type Fact = z.infer<typeof FactSchema>;
export type Ambiguity = z.infer<typeof AmbiguitySchema>;
export type Promise_ = z.infer<typeof PromiseSchema>;
export type Detail = z.infer<typeof DetailSchema>;

export interface Candidate { id: string; entity_type: string; label: string; score: number; detail?: Record<string, unknown> }
/** Permission-scoped candidate lists, one per mention (kind + text) offered to the extractor. */
export type CandidateLists = { kind: Mention["kind"]; text: string; candidates: Candidate[] }[];

/** IDs a mention may legitimately carry: candidates offered for that mention text (fallback: any offered for its kind). */
export function allowedIds(lists: CandidateLists, m: Pick<Mention, "kind" | "text">): Set<string> {
  const exact = lists.filter((l) => l.kind === m.kind && l.text.toLowerCase() === m.text.toLowerCase());
  const pool = exact.length ? exact : lists.filter((l) => l.kind === m.kind);
  return new Set(pool.flatMap((l) => l.candidates.map((c) => c.id)));
}

/** Older stored extractions (before promises/objections/...) are read with empty arrays. */
export function withDefaults<T extends Partial<Extraction>>(e: T): T & Pick<Extraction, "promises" | "objections" | "stakeholders" | "details"> {
  return { ...e, promises: e.promises ?? [], objections: e.objections ?? [], stakeholders: e.stakeholders ?? [], details: e.details ?? [] };
}

// ------------------------------------------------------------------ numbers (English + Roman Hindi)
const UNITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** Roman-script Hindi number words (common spellings). Ambiguous English words ("do", "teen", "das") are left out. */
export const HINDI_NUM: Record<string, number> = {
  ek: 1, paanch: 5, panch: 5, chhe: 6, chhah: 6, saat: 7, aath: 8, nau: 9,
  gyarah: 11, barah: 12, baarah: 12, terah: 13, chaudah: 14, pandrah: 15, solah: 16, satrah: 17, atharah: 18, unnees: 19,
  bees: 20, bis: 20, pachees: 25, pachchis: 25, tees: 30, chalis: 40, chaalis: 40, pachaas: 50, pachas: 50,
  saath: 60, sattar: 70, assi: 80, assee: 80, nabbe: 90, dedh: 1.5, dhai: 2.5, dhaai: 2.5,
};
/** "-teen" vs "-ty" words that speech recognition confuses (English) and Hindi near-homophones. */
export const CONFUSABLE: Record<string, string> = { thirteen: "thirty", thirty: "thirteen", fourteen: "forty", forty: "fourteen",
  fifteen: "fifty", fifty: "fifteen", sixteen: "sixty", sixty: "sixteen", seventeen: "seventy", seventy: "seventeen",
  eighteen: "eighty", eighty: "eighteen", nineteen: "ninety", ninety: "nineteen",
  saat: "saath", saath: "saat", satrah: "sattar", sattar: "satrah" };
const WORD_NUM = [...Object.keys(UNITS), ...Object.keys(TENS), ...Object.keys(HINDI_NUM)].sort((a, b) => b.length - a.length).join("|");
const MULT: Record<string, number> = { k: 1_000, thousand: 1_000, hazaar: 1_000, hazar: 1_000, hajar: 1_000, sau: 100,
  lakh: 1_00_000, lakhs: 1_00_000, lac: 1_00_000, l: 1_00_000, cr: 1_00_00_000, crore: 1_00_00_000, crores: 1_00_00_000, karod: 1_00_00_000, karor: 1_00_00_000 };
const MULT_RE = "k|thousand|hazaar|hazar|hajar|sau|lakhs?|lac|l|cr|crores?|karod|karor";

function wordValue(w: string): number | null {
  const lw = w.toLowerCase();
  return UNITS[lw] ?? TENS[lw] ?? HINDI_NUM[lw] ?? null;
}
/** Devanagari digits -> ASCII (same string length, so offsets stay valid). */
export function normaliseDigits(s: string) {
  return s.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
}
const fmtNum = (n: number) => n.toLocaleString("en-IN");

/** Unit-question option values: "<fact field>" or "<fact field>|<budget_basis>". */
export type UnitSpec = { field: Exclude<FactField, "preferred_geography" | "occupation_date" | "decision_date">; basis: string | null };
export function parseUnitSpec(v: unknown): UnitSpec | null {
  if (typeof v !== "string") return null;
  const [field, basis] = v.split("|");
  if (!["area_target_sf", "seats_target", "budget_max"].includes(field)) return null;
  if (basis && !["per_sf_month", "per_seat_month", "total_month"].includes(basis)) return null;
  return { field: field as UnitSpec["field"], basis: basis || null };
}
const BASIS_BY_UNIT: Record<string, string> = { "INR/sf/month": "per_sf_month", "INR/seat/month": "per_seat_month", "INR/month": "total_month" };
export function basisForUnit(unit: string | null): string | null { return unit ? BASIS_BY_UNIT[unit] ?? null : null; }

// ------------------------------------------------------------------ dates
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_RE = "sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar|ravivar";
const HINDI_WEEKDAY: Record<string, number> = { ravivar: 0, somvar: 1, mangalvar: 2, budhvar: 3, guruvar: 4, shukravar: 5, shanivar: 6 };

function monthIndex(s: string) { return MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3))); }
function weekdayIndex(s: string) {
  const l = s.toLowerCase();
  if (l in HINDI_WEEKDAY) return HINDI_WEEKDAY[l];
  return WEEKDAYS.findIndex((d) => d.startsWith(l.slice(0, 3)));
}
function iso(y: number, m0: number, d: number) { return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
function lastDay(y: number, m0: number) { return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate(); }
function addDays(isoDate: string, n: number) { const d = new Date(`${isoDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Next two occurrences of a weekday strictly after the source date (local workspace date). */
export function weekdayOptions(sourceLocalDate: string, weekday: number): [string, string] {
  const dow = new Date(`${sourceLocalDate}T00:00:00Z`).getUTCDay();
  let delta = (weekday - dow + 7) % 7;
  if (delta === 0) delta = 7;
  const first = addDays(sourceLocalDate, delta);
  return [first, addDays(first, 7)];
}
/** "by March" -> end of the next March on/after the source date, and the one a year later. */
export function monthOptions(sourceLocalDate: string, month0: number): [string, string] {
  const [y, m] = sourceLocalDate.split("-").map(Number);
  const year = month0 >= m - 1 ? y : y + 1;
  return [iso(year, month0, lastDay(year, month0)), iso(year + 1, month0, lastDay(year + 1, month0))];
}

// ------------------------------------------------------------------ vocabulary
const TASK_VERBS = "send|share|call|email|mail|prepare|follow up|follow-up|schedule|arrange|check|book|set up|setup|confirm|remind|whatsapp|draft";
/** Verbs whose task is something owed to the counterparty (a promise), not just an internal to-do. */
const PROMISE_VERBS = /^(send|share|email|mail|whatsapp|call|confirm|arrange|schedule|set up|setup|book|prepare|show|meet)\b/i;
/** Hinglish verb (at the end of the clause) -> English imperative. */
const HI_VERBS: [RegExp, string][] = [
  [/^bhej(?:na|ni|ne|o|\s+(?:dena|do|denge|dunga|dungi)|unga|ungi|enge)$/i, "Send"],
  [/^share\s+kar(?:na|ni|\s+dena|\s+do|unga|enge)$/i, "Share"],
  [/^(?:call|phone)\s+kar(?:na|ni|unga|enge)$/i, "Call"],
  [/^follow[ -]?up\s+kar(?:na|unga|enge)$/i, "Follow up"],
  [/^confirm\s+kar(?:na|ni|unga|enge)$/i, "Confirm"],
  [/^(?:schedule|fix|set)\s+kar(?:na|ni|unga|enge)$/i, "Schedule"],
  [/^(?:e?mail)\s+kar(?:na|ni|unga|enge)$/i, "Email"],
  [/^whats\s?app\s+kar(?:na|ni|unga|enge)$/i, "WhatsApp"],
  [/^(?:dikhana|dikhane|dikhani|visit\s+karwana)$/i, "Show"],
  [/^(?:milna|milne\s+jana)$/i, "Meet"],
  [/^(?:tayyar|taiyar|ready)\s+kar(?:na|ni)$/i, "Prepare"],
  [/^(?:check|verify)\s+kar(?:na|ni)$/i, "Check"],
];
const HI_VERB_RE = "bhej(?:na|ni|ne|o|\\s+(?:dena|do|denge|dunga|dungi)|unga|ungi|enge)|(?:share|call|phone|confirm|schedule|fix|set|e?mail|whats\\s?app|tayyar|taiyar|ready|check|verify)\\s+kar(?:na|ni|\\s+dena|\\s+do|unga|enge)|follow[ -]?up\\s+kar(?:na|unga|enge)|dikhana|dikhane|dikhani|visit\\s+karwana|milna|milne\\s+jana";
const CHANNEL_VERBS: [RegExp, Extraction["interaction"] extends infer T ? T extends { channel: infer C } ? C : never : never][] = [
  [/\b(spoke|spoken|talked|called|call|phoned|rang)\b|\bbaat\s+(?:hui|ki|kari|huyi)\b|\b(?:call|phone)\s+(?:kiya|kia)\b/i, "call"],
  [/\b(met|meeting|catch-?up|lunch|coffee|mile|mila|mili|mulaqat|mulakat)\b/i, "meeting"],
  [/\b(visited|site visit|visit)\b|\bdekhne\s+gaye\b/i, "visit"],
  [/\bwhats ?app\b/i, "whatsapp"],
  [/\b(emailed|mailed)\b/i, "email"],
];
const NAME = "[A-Z][a-zA-Z'.-]+(?: [A-Z][a-zA-Z'.-]+){0,2}";
const PLACE = "[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)?";
const NOT_NAMES = new Set(["the", "he", "she", "they", "we", "i", "client", "company", "team", "finance", "procurement", "legal", "admin", "it", "hr",
  "ceo", "cfo", "cto", "coo", "maybe", "send", "share", "call", "need", "please", "also", "and", "but", "then", "today", "tomorrow", "kal", "aaj"]);
/** Hindi/Hinglish function words (pronouns, postpositions, particles) that are never part of a name or place:
 *  sentence-initial capitals make "Unko Kharadi" look like a two-word place. */
const HI_FUNCTION_WORDS = new Set(["unko", "unako", "inako", "usako", "isako", "unhe", "unhen", "unka", "unki", "unke", "inko", "inhe", "inka", "inki", "inke", "usko", "use", "isko", "ise",
  "hum", "humko", "hume", "humein", "hamein", "hamko", "humara", "hamara", "mujhe", "mera", "meri", "tum", "aap", "aapko", "woh", "wo", "ye", "yeh", "vo",
  "mein", "me", "main", "ko", "ka", "ki", "ke", "se", "pe", "par", "tak", "wala", "wale", "wali", "waala", "waale", "waali", "bhi", "toh", "to", "hi", "aur", "ya",
  "abhi", "phir", "fir", "sirf", "bas", "ji"]);
/** Drop Hindi function words from both ends of a candidate. Returns the kept text and its offset inside `t` ("" if nothing left). */
export function stripFunctionWords(t: string): { text: string; offset: number } {
  const words = [...t.matchAll(/\S+/g)];
  let a = 0, b = words.length;
  while (a < b && HI_FUNCTION_WORDS.has(words[a][0].toLowerCase())) a++;
  while (b > a && HI_FUNCTION_WORDS.has(words[b - 1][0].toLowerCase())) b--;
  if (a >= b) return { text: "", offset: 0 };
  const start = words[a].index!, end = words[b - 1].index! + words[b - 1][0].length;
  return { text: t.slice(start, end), offset: start };
}
const isName = (s: string) => !!stripFunctionWords(s).text && !NOT_NAMES.has(s.toLowerCase()) && monthIndex(s) < 0 && weekdayIndex(s.split(" ")[0]) < 0;
const SELF = new Set(["we", "i", "hum", "main", "mai", "me", "self"]);
/** Drop leading stop-words ("Then Raj") and trailing weekday/month words ("Raj Monday") from a captured name. */
function cleanName(raw: string): string {
  const w = raw.split(" ");
  while (w.length > 1 && (NOT_NAMES.has(w[0].toLowerCase()) || ["then", "so", "also"].includes(w[0].toLowerCase()))) w.shift();
  while (w.length > 1 && (weekdayIndex(w[w.length - 1]) >= 0 || monthIndex(w[w.length - 1]) >= 0)) w.pop();
  return w.join(" ");
}
/** Case-insensitive alternation without the /i flag (so NAME stays capitalised-only). */
function ci(alt: string) { return alt.replace(/[a-z]/gi, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`); }
/** Remove when-words (weekday phrases, tomorrow/kal) and stray Hindi particles from a task/promise object. */
function stripWhen(str: string) {
  return str.replace(new RegExp(`\\b(?:by|on|before|next|this|agle)?\\s*(?:${WEEKDAY_RE})\\b(?:\\s+(?:ko|tak))?`, "gi"), " ")
    .replace(/\b(tomorrow|kal)\b/gi, " ").replace(/\b(ko|tak|ka|ki|ke)\b/gi, " ").replace(/\s+/g, " ").trim();
}

const OBJECTION_RE = /\b(too expensive|expensive|costly|over budget|too far|far from|concerns?|concerned|worried|not happy|unhappy|issue with|problem with|objection|(?:do|does|did)\s?n[o']?t like|push ?back|not convinced|hesitant|too small|too big|no parking|mehe?nga|bahut door|door hai|pasand nahi?n?|nahi?n? chalega|dikkat|problem hai)\b/i;

const ROLE_WORDS: [RegExp, (typeof STAKEHOLDER_ROLES)[number]][] = [
  [/decision[- ]?maker|final approver|approver|final say|sign[- ]?off|decides?|approve|decision|faisla/i, "approver"],
  [/sponsor|budget owner|champion/i, "sponsor"],
  [/cfo|finance|accounts/i, "finance"],
  [/procurement|purchase|vendor/i, "procurement"],
  [/legal|lawyer|counsel/i, "legal"],
  [/\bit\b|cto|technology|tech|facilit|infra/i, "technical"],
  [/admin|hr|people team|workplace/i, "user"],
  [/influencer|advisor|consultant/i, "influencer"],
];
const ROLE_TERMS = "decision[- ]?maker|final approver|approver|final say|sponsor|budget owner|cfo|finance head|head of finance|finance|procurement head|procurement|legal head|legal|it head|cto|admin head|facilities head|facilities|hr head|influencer";
function roleOf(s: string) { return ROLE_WORDS.find(([re]) => re.test(s))?.[1] ?? "other"; }

const FITOUT: [RegExp, string][] = [
  [/\bbare[- ]?shell\b/i, "bare"], [/\bwarm[- ]?shell\b/i, "warm_shell"],
  [/\b(fully[- ]?fitted|fitted out|fully furnished|furnished|plug[- ]and[- ]play|ready to move)\b/i, "fitted"], [/\bmanaged (office|space)\b/i, "managed"],
];
const DETAIL_PATTERNS: [DetailKey, RegExp][] = [
  ["parking", /\b(parking|car parks?|two[- ]wheelers?|2[- ]wheelers?|four[- ]wheelers?)\b/i],
  ["power", /\b(\d+\s*kva|kva|power backup|dg backup|dg sets?|ups|power load|100% backup|power)\b/i],
  ["transit", /\b(metro|railway station|bus stop|public transport|transit|near (?:the )?station)\b/i],
  ["security_access", /\b(security|access control|biometric|cctv|guards?|client audit|secure floor)\b/i],
  ["expansion", /\b(expan(?:d|sion)|grow(?:th)? to|scale (?:up )?to|additional floor|option to expand|badhana)\b/i],
];

interface Clause { text: string; start: number }
/** Clauses split on ; . ! ? newlines and ", " (commas followed by space, so 20,000 stays intact). */
function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  const re = /(?:[^;\n.!?,]|,(?!\s))+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t) out.push({ text: t, start: m.index + lead });
  }
  return out;
}

export interface RuleOptions { sourceAt?: Date | string; timezone?: string }

export function ruleExtract(input: string, opts: RuleOptions = {}): Extraction {
  const text = normaliseDigits(input);
  const src = localDate(opts.sourceAt ? new Date(opts.sourceAt) : new Date(), opts.timezone);
  const ex: Extraction = { schema_version: "1", interaction: null, mentions: [], facts: [], tasks: [], ambiguities: [], drafts: [],
    promises: [], objections: [], stakeholders: [], details: [] };
  const addMention = (kind: Mention["kind"], raw: string, rawStart: number) => {
    const st = stripFunctionWords(raw);
    const t = st.text || raw, start = rawStart + st.offset;
    const existing = ex.mentions.findIndex((x) => x.kind === kind && x.text.toLowerCase() === t.toLowerCase());
    if (existing >= 0) return existing;
    ex.mentions.push({ kind, text: t, start, end: start + t.length, candidate_ids: [] });
    return ex.mentions.length - 1;
  };
  const amb = (a: Omit<Ambiguity, "fact_index" | "task_index" | "mention_index"> & Partial<Ambiguity>) =>
    ex.ambiguities.push({ fact_index: null, task_index: null, mention_index: null, ...a }) - 1;
  let personIdx: number | null = null;
  const personNames = () => new Set(ex.mentions.filter((m) => m.kind === "person").map((m) => m.text.toLowerCase()));

  for (const c of clauses(text)) {
    const s = c.text;
    const at = (i: number) => c.start + i;

    // ---- interaction + who/where: "spoke to Raj at Acme", "met Priya from Zenith Labs", "Raj se baat hui", "Acme ke Raj se mila"
    for (const [re, ch] of CHANNEL_VERBS) {
      if (re.test(s) && !ex.interaction) ex.interaction = { channel: ch, summary: input.trim().slice(0, 1000) };
    }
    const who = new RegExp(`\\b(?:${ci("spoke|spoken|talked|called|met|meeting|call|rang|phoned|visited|whatsapp")}(?:ed)?)\\s+(?:${ci("to")}\\s+|${ci("with")}\\s+)?(${NAME})(?:\\s+(?:at|from|of)\\s+(${NAME}))?`).exec(s);
    const hiWho = new RegExp(`(?:^|\\s)(?:(${NAME})\\s+(?:ke|ki|wale|waale|from|at|of)\\s+)?(${NAME})(?:\\s+ji)?\\s+(?:se|ke\\s+sa+th|ko)\\s+(?:baat|meeting|mil[aie]|mulaqat|mulakat|call|phone)`).exec(s);
    if (who && isName(who[1])) {
      personIdx = addMention("person", who[1], at(who.index + who[0].indexOf(who[1])));
      if (who[2]) addMention("organisation", who[2], at(who.index + who[0].lastIndexOf(who[2])));
    } else if (hiWho && isName(hiWho[2])) {
      const off = hiWho.index + (hiWho[0].length - hiWho[0].trimStart().length);
      const body = hiWho[0].trimStart();
      if (hiWho[1]) addMention("organisation", hiWho[1], at(off + body.indexOf(hiWho[1])));
      personIdx = addMention("person", hiWho[2], at(off + body.indexOf(hiWho[2], hiWho[1] ? hiWho[1].length : 0)));
    } else {
      const org = new RegExp(`\\b(?:at|from)\\s+(${NAME})`).exec(s);
      if (org && /\b(spoke|met|called|talked)\b/i.test(text)) addMention("organisation", org[1], at(org.index + org[0].indexOf(org[1])));
    }
    const hasWho = !!(who || hiWho);

    // ---- area / seats / budget numbers
    const numRe = new RegExp(`(?:(₹|rs\\.?|inr)\\s*)?\\b(\\d{1,3}(?:,\\d{2,3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?|${WORD_NUM})(?:[\\s-]+(${WORD_NUM}))?\\s*(${MULT_RE})?\\b\\s*(sq\\.?\\s?ft|sqft|sft|sf|square f(?:ee|oo)t|sq\\.?\\s?feet|feet|ft|per sq\\.?\\s?ft|psf|\\/sf|\\/sq\\.?\\s?ft|per seat|\\/seat|per desk|seats?|seater|desks?|rupees|rupaye|rupay)?`, "gi");
    let n: RegExpExecArray | null;
    while ((n = numRe.exec(s))) {
      const [whole, cur, base, second, mult, unit] = n;
      if (!base) continue;
      const digits = base.replace(/,/g, "");
      const isWord = isNaN(Number(digits));
      const preceding = s.slice(0, n.index);
      if (/\b(?:by|in|on|before|after)\s*$/i.test(preceding) && !mult && !unit) continue;   // dates like "by 15"
      // "Budget is 85": a bare number right after budget/rent words is a budget with UNKNOWN unit and pricing basis —
      // kept raw, never assumed; one question covers unit, basis and CAM (spec §2.1 / §16).
      if (!isWord && !mult && !unit && !cur && /\b(budget|rent|rental|kiraya|bajat)\b[^\d\n]{0,12}$/i.test(preceding) && Number(digits) < 10_000) {
        const v = Number(digits);
        const start = at(n.index), end = at(n.index + whole.trimEnd().length);
        const fi = ex.facts.push({ entity_type: "requirement", field: "budget_max", proposed_value: v, raw_text: whole.trim(), unit: null,
          status: "reported", requires_confirmation: true, start, end }) - 1;
        amb({ kind: "unit", question: `Budget "${whole.trim()}" — does that mean ₹${fmtNum(v)} per sq ft per month? Is CAM extra?`, fact_index: fi, start, end,
          options: [
            { label: `Yes — ₹${fmtNum(v)}/sq ft/month, CAM extra`, value: "budget_max|per_sf_month|cam_extra" },
            { label: `₹${fmtNum(v)}/sq ft/month including CAM`, value: "budget_max|per_sf_month|cam_included" },
            { label: `₹${fmtNum(v)}/sq ft/month, CAM not discussed`, value: "budget_max|per_sf_month|cam_unknown" },
            { label: `₹${fmtNum(v)} per seat per month`, value: "budget_max|per_seat_month" },
            { label: `₹${fmtNum(v)} total per month`, value: "budget_max|total_month" },
          ] });
        continue;
      }
      if (!isWord && !mult && !unit && !cur) continue;                                         // bare numbers carry no field
      if (/^\d{4}$/.test(base) && !mult && !unit && !cur) continue;                            // years
      if (/lock[- ]?in|lease|tenure|term|saal|years?|months?/i.test(s.slice(n.index + whole.length, n.index + whole.length + 12)) && !unit && !cur) continue; // tenure, handled below
      let value = isWord ? (wordValue(base) ?? 0) + (second ? wordValue(second) ?? 0 : 0) : Number(digits);
      if (mult) value *= MULT[mult.toLowerCase()] ?? 1;
      if (isWord && !unit && !mult) continue;                                                   // a bare number word is not a fact we can place
      value = Math.round(value * 100) / 100;
      const u = (unit ?? "").toLowerCase();
      const start = at(n.index), end = at(n.index + whole.trimEnd().length);
      const tentative = /\b(maybe|around|approx|approximately|roughly|about|~|possibly|lagbhag|takriban|shayad)\b/i.test(s);
      const fact = (field: FactField, unitLabel: string | null, val: number | null) =>
        ex.facts.push({ entity_type: "requirement", field, proposed_value: val, raw_text: whole.trim(), unit: unitLabel,
          status: tentative ? "tentative" : "reported", requires_confirmation: true, start, end }) - 1;
      const unitQuestion = (v: number, kinds: ("area" | "budget")[]) => {
        const i = fact(kinds.includes("area") ? "area_target_sf" : "budget_max", null, v);
        const options = [
          ...(kinds.includes("area") ? [{ label: `${fmtNum(v)} sq ft (area)`, value: "area_target_sf" }] : []),
          ...(kinds.includes("budget") ? [
            { label: `₹${fmtNum(v)} per seat per month (budget)`, value: "budget_max|per_seat_month" },
            { label: `₹${fmtNum(v)} total per month (budget)`, value: "budget_max|total_month" },
            ...(kinds.length === 1 ? [{ label: `₹${fmtNum(v)} per sq ft per month (budget)`, value: "budget_max|per_sf_month" }] : []),
          ] : []),
        ];
        amb({ kind: "unit", question: `"${whole.trim()}" — is that sq ft or rupees (and on what basis)?`, options, fact_index: i, start, end });
        return i;
      };
      let fi: number;
      if (/per seat|\/seat|per desk/.test(u)) fi = fact("budget_max", "INR/seat/month", value);
      else if (/per|psf|\/s/.test(u)) fi = fact("budget_max", "INR/sf/month", value);
      else if (/seat|desk/.test(u)) fi = fact("seats_target", "seats", value);
      else if (u) {
        if (/rupe|rupay/.test(u)) fi = unitQuestion(value, ["budget"]);
        else fi = fact("area_target_sf", "sf", value);
      } else if (cur) fi = unitQuestion(value, ["budget"]);
      else {
        // "20k", "bees hazaar", "2 lakh": sq ft or rupees? Never assume — ask.
        const budgety = /\b(budget|rent|rental|cost|price|kiraya|bajat|per month|monthly)\b/i.test(s);
        const areay = /\b(area|space|office of|carpet|chargeable|jagah)\b/i.test(s);
        fi = unitQuestion(value, budgety && !areay ? ["budget"] : areay && !budgety ? ["area"] : ["area", "budget"]);
      }
      const conf = [base, second].filter(Boolean).map((w) => w!.toLowerCase()).find((w) => CONFUSABLE[w]);
      if (conf) {
        const alt = CONFUSABLE[conf];
        const altValue = (() => {
          let v = (wordValue(alt) ?? 0) + (second && second.toLowerCase() !== conf ? wordValue(second) ?? 0 : 0);
          if (base.toLowerCase() !== conf && wordValue(base) != null) v = (wordValue(base) ?? 0) + (wordValue(alt) ?? 0);
          return mult ? v * (MULT[mult.toLowerCase()] ?? 1) : v;
        })();
        const ul = ex.facts[fi].unit ?? "";
        amb({ kind: "number", question: `Did they say "${conf}" or "${alt}"? (${fmtNum(value)} vs ${fmtNum(altValue)} ${ul})`.trim(),
          options: [{ label: `${fmtNum(value)} ${ul}`.trim(), value }, { label: `${fmtNum(altValue)} ${ul}`.trim(), value: altValue }],
          fact_index: fi, start, end });
        ex.facts[fi].proposed_value = null;   // never silently pick one
      }
    }

    // ---- occupation / decision dates: "by March", "decision by June 2027", "March tak", "June 2027 se pehle"
    const dm = new RegExp(`\\b(by|before|from|in|decision (?:by|in))\\s+(?:end of\\s+)?(${MONTH_RE})\\b(?:\\s+(\\d{4}))?`, "i").exec(s)
      ?? (() => {
        const h = new RegExp(`\\b(${MONTH_RE})\\b(?:\\s+(\\d{4}))?\\s+(?:tak|se\\s+pe?hle|ke\\s+andar|mein|me|main)\\b`, "i").exec(s);
        return h ? Object.assign([h[0], "by", h[1], h[2]], { index: h.index, input: h.input }) as unknown as RegExpExecArray : null;
      })();
    if (dm && !/\b(send|share|call|email)\b/i.test(s.slice(0, dm.index))) {
      const m0 = monthIndex(dm[2]);
      const field: FactField = /decision/i.test(dm[1]) || /\b(decid|decision|faisla)/i.test(s) ? "decision_date" : "occupation_date";
      const start = at(dm.index), end = at(dm.index + dm[0].length);
      if (dm[3]) {
        const y = Number(dm[3]);
        ex.facts.push({ entity_type: "requirement", field, proposed_value: iso(y, m0, lastDay(y, m0)), raw_text: dm[0], unit: "date",
          status: "reported", requires_confirmation: true, start, end });
      } else {
        const [a, b] = monthOptions(src, m0);
        const fi = ex.facts.push({ entity_type: "requirement", field, proposed_value: null, raw_text: dm[0], unit: "date",
          status: "reported", requires_confirmation: true, start, end }) - 1;
        const label = cap(MONTHS[m0]);
        amb({ kind: "date", question: `Which ${label} — ${a.slice(0, 4)} or ${b.slice(0, 4)}?`,
          options: [{ label: `${label} ${a.slice(0, 4)}`, value: a }, { label: `${label} ${b.slice(0, 4)}`, value: b }], fact_index: fi, start, end });
      }
    }

    // ---- geography preference: "maybe Baner", "prefer Kharadi or Viman Nagar", "Baner ho sakta hai", "shayad Baner"
    const geo = (g0: string, idx0: number, tentative: boolean, raw: string) => {
      const st = stripFunctionWords(g0);
      if (!st.text) return;
      const g = st.text, idx = idx0 + st.offset;
      if (monthIndex(g) >= 0 || weekdayIndex(g.split(" ")[0]) >= 0 || personNames().has(g.toLowerCase())) return;
      const mi = addMention("geography", g, at(idx));
      ex.facts.push({ entity_type: "requirement", field: "preferred_geography", proposed_value: g, raw_text: raw, unit: null,
        status: tentative ? "tentative" : "reported", requires_confirmation: true, start: ex.mentions[mi].start, end: ex.mentions[mi].end });
    };
    const gm = new RegExp(`\\b(maybe|prefer(?:s|red)?|ideally|likes?|looking at|in|shayad|shaayad)\\s+(${PLACE})(?:\\s+(?:or|ya)\\s+(${PLACE}))?`).exec(s);
    const hgm = new RegExp(`\\b(${PLACE})(?:\\s+(?:ya|or)\\s+(${PLACE}))?\\s+(ho\\s+sakta\\s+hai|ho\\s+sakti\\s+hai|chalega|chal\\s+jayega|prefer|pasand\\s+hai|best\\s+rahega|(?:mein|me|main)\\s+(?:chahiye|dekh|dekhna|dhoondh)|(?:mein|me|main)\\s+[^.]{0,40}?\\bchahiye)`).exec(s);
    const catchmentClause = /\b(employees?|staff|team|people|log)\b.*\b(live|lives|stay|stays|come|comes|commute|commutes|rehte|aate)\b/i.test(s);
    if (catchmentClause) { /* catchments are not location preferences */ }
    else if (gm && monthIndex(gm[2]) < 0 && !hasWho) {
      for (const g of [gm[2], gm[3]].filter(Boolean) as string[]) geo(g, gm.index + gm[0].indexOf(g), /maybe|ideally|likes?|shay?a?ad/i.test(gm[1]), gm[0]);
    } else if (hgm && !hasWho) {
      for (const g of [hgm[1], hgm[2]].filter(Boolean) as string[]) geo(g, hgm.index + hgm[0].indexOf(g), /sakta|sakti|chal/i.test(hgm[3]), hgm[0]);
    }

    // ---- tasks: English imperative clause ("send options Friday") or Hinglish verb-final ("Friday ko options bhejna hai")
    const tm = new RegExp(`^(?:(?:need to|to|pls|please|must|will|i'll|todo:?)\\s+)?(${TASK_VERBS})\\b(.*)$`, "i").exec(s);
    const htm = !tm ? new RegExp(`^(.*?)\\s*\\b(${HI_VERB_RE})\\b(?:\\s+(?:hai|h|he|hain|padega|hoga|hogi))?\\s*$`, "i").exec(s) : null;
    if (tm || (htm && !/\b(bhejega|bhejegi|bhejenge|karega|karegi|karenge)\b/i.test(s))) {
      const verbEn = tm ? tm[1] : HI_VERBS.find(([re]) => re.test(htm![2].replace(/\s+/g, " ")))?.[1] ?? "Follow up";
      let desc = tm ? s.replace(/\s+/g, " ") : `${verbEn} ${htm![1]}`.replace(/\s+/g, " ");
      let due: string | null = null;
      const wd = new RegExp(`\\b(?:by|on|before|next|this|agle|is)?\\s*(${WEEKDAY_RE})\\b(?:\\s+(?:ko|tak))?`, "i").exec(s);
      const ti = ex.tasks.length;
      if (wd) {
        const [a, b] = weekdayOptions(src, weekdayIndex(wd[1]));
        due = a;
        const dayLabel = cap(WEEKDAYS[weekdayIndex(wd[1])]);
        amb({ kind: "date", question: `Which ${dayLabel} is intended — ${a} or ${b}?`, options: [{ label: a, value: a }, { label: b, value: b }],
          task_index: ti, start: at(wd.index), end: at(wd.index + wd[0].length) });
        desc = desc.replace(new RegExp(`\\b(?:by|on|before|next|this|agle|is)?\\s*${wd[1]}\\b(?:\\s+(?:ko|tak))?`, "i"), "").replace(/\s+/g, " ").trim();
      } else if (/\b(tomorrow|kal)\b/i.test(s)) {
        due = addDays(src, 1);
        if (htm) desc = desc.replace(/\bkal\b/i, "").replace(/\s+/g, " ").trim();
      }
      if (htm) desc = desc.replace(/\s+\b(ko|ka|ki|ke|tak|ye|yeh|woh|wo)\b\s*$/i, "").replace(/\s+\b(ko|tak)\b/gi, "").trim();
      const person = personIdx != null ? ex.mentions[personIdx] : null;
      const org = ex.mentions.find((m) => m.kind === "organisation");
      if (person && !new RegExp(`\\b${person.text}\\b`, "i").test(desc)) desc += ` to ${person.text}${org ? ` (${org.text})` : ""}`;
      desc = cap(desc);
      ex.tasks.push({ description: desc, due_date: due, start: c.start, end: c.start + s.length });
      const sendish = tm ? /^(send|share|email|mail|whatsapp)\b/i.test(tm[1]) : ["Send", "Share", "Email", "WhatsApp"].includes(verbEn);
      if (sendish && person) {
        const channel = /whatsapp/i.test(tm ? tm[1] : verbEn) ? "whatsapp" : "email";
        const what = tm ? tm[2].trim().replace(new RegExp(`\\b(on|by)?\\s*(${WEEKDAY_RE})\\b`, "i"), "").trim() : (htm![1].replace(new RegExp(`\\b(${WEEKDAY_RE})\\b(?:\\s+(?:ko|tak))?`, "i"), "").trim());
        ex.drafts.push({ channel, purpose: desc.slice(0, 200), recipient_mention_index: personIdx, task_index: ti,
          body: `Hi ${person.text.split(" ")[0]},\n\nThanks for the time today. As discussed, ${what || "the details"} — I'll share these shortly.\n\nRegards` });
      }
      if (PROMISE_VERBS.test(tm ? tm[1] : verbEn)) {
        ex.promises.push({ who: "me", who_mention_index: null, what: desc.slice(0, 300), due, task_index: ti, start: c.start, end: c.start + s.length });
      }
    }

    // ---- counterparty promises: "Raj will send floor plans by Monday", "Raj Monday tak floor plan bhejega"
    let cpWho: string | null = null, cpWhat = "", cpIdx = 0;
    const ecp = new RegExp(`\\b(${NAME}|[Hh]e|[Ss]he|[Tt]hey|[Cc]lient|[Ww]e|I)\\s+(?:will|'ll|would|promised to|agreed to|said (?:he|she|they)(?:'d| would))\\s+(send|share|confirm|revert|get back|come back|provide|check|arrange|sign|approve|introduce)\\b(.*)$`).exec(s);
    const hcp = !ecp ? new RegExp(`\\b(${NAME})(?:\\s+ji)?\\s+(.*?)\\s*\\b(bhejega|bhejegi|bhejenge|bhej dega|bhej denge|confirm karega|confirm karegi|confirm karenge|batayega|batayegi|batayenge|share karega|share karenge|revert karega|revert karenge)\\b`).exec(s) : null;
    if (ecp) {
      cpWho = cleanName(ecp[1]); cpIdx = ecp.index + ecp[0].indexOf(ecp[1]) + ecp[1].indexOf(cpWho || ecp[1]);
      cpWhat = `${ecp[2]} ${stripWhen(ecp[3])}`;
    } else if (hcp) {
      cpWho = cleanName(hcp[1]); cpIdx = hcp.index + hcp[1].indexOf(cpWho || hcp[1]);
      const verb = /bhej/i.test(hcp[3]) ? "send" : /confirm/i.test(hcp[3]) ? "confirm" : /share/i.test(hcp[3]) ? "share" : "revert on";
      const restStart = cpIdx + (cpWho ?? "").length;
      cpWhat = `${verb} ${stripWhen(s.slice(restStart, hcp.index + hcp[0].lastIndexOf(hcp[3])).replace(/^\s*ji\b/i, ""))}`;
    }
    if (cpWho && !tm && !SELF.has(cpWho.toLowerCase())) {
      const named = /^[A-Z]/.test(cpWho) && isName(cpWho) && !/^(He|She|They|Client)$/.test(cpWho);
      const wmi = named ? addMention("person", cpWho, at(cpIdx)) : (personIdx ?? null);
      let due: string | null = null;
      const wd = new RegExp(`\\b(${WEEKDAY_RE})\\b`, "i").exec(s);
      const what = cap(cpWhat.replace(/\s+/g, " ").trim()).slice(0, 300);
      if (wd) {
        const [a, b] = weekdayOptions(src, weekdayIndex(wd[1]));
        due = a;
        const dayLabel = cap(WEEKDAYS[weekdayIndex(wd[1])]);
        amb({ kind: "date", question: `${named ? cpWho : "The client"} promised to ${what.toLowerCase()} — which ${dayLabel}: ${a} or ${b}?`,
          options: [{ label: a, value: a }, { label: b, value: b }], start: at(wd.index), end: at(wd.index + wd[0].length) });
      } else if (/\b(tomorrow|kal)\b/i.test(s)) due = addDays(src, 1);
      ex.promises.push({ who: named ? cpWho : wmi != null ? ex.mentions[wmi].text : "client", who_mention_index: wmi, what, due,
        task_index: null, start: c.start, end: c.start + s.length });
    }

    // ---- objections
    if (OBJECTION_RE.test(s)) ex.objections.push({ text: s.slice(0, 300), start: c.start, end: c.start + s.length });

    // ---- stakeholder roles: "Raj is the decision maker", "CFO Meera", "Amit from procurement", "decision Raj lega"
    const sts: { name: string; idx: number; role: (typeof STAKEHOLDER_ROLES)[number]; raw: string }[] = [];
    const s1 = new RegExp(`\\b(${NAME})\\s+(?:is|is the|as|as the|will be the)\\s+(?:the\\s+|our\\s+|their\\s+)?(${ci(ROLE_TERMS)})\\b`).exec(s);
    if (s1) sts.push({ name: s1[1], idx: s1.index, role: roleOf(s1[2]), raw: s1[0] });
    const s2 = new RegExp(`\\b(${ci("cfo|cto|finance head|head of finance|procurement head|legal head|it head|admin head|facilities head|hr head")})\\s+(${NAME})`).exec(s);
    if (s2) sts.push({ name: s2[2], idx: s2.index + s2[0].lastIndexOf(s2[2]), role: roleOf(s2[1]), raw: s2[0] });
    const s3 = new RegExp(`\\b(${NAME})\\s+(?:from|in|handles|heads|runs|looks after)\\s+(finance|procurement|legal|IT|technology|admin|facilities|HR)\\b`).exec(s);
    if (s3) sts.push({ name: s3[1], idx: s3.index, role: roleOf(s3[2]), raw: s3[0] });
    const s4 = new RegExp(`\\b(?:decision|final (?:approval|decision)|sign[- ]off)\\s+(?:is\\s+|lies\\s+)?(?:with\\s+)?(${NAME})(?:\\s+ji)?(?:\\s+(?:lega|legi|lenge|karega|karegi|karenge|ka|ki|ke\\s+paas))?\\b`).exec(s);
    if (s4) sts.push({ name: s4[1], idx: s4.index + s4[0].indexOf(s4[1]), role: "approver", raw: s4[0] });
    const s5 = new RegExp(`\\b(${NAME})(?:\\s+ji)?\\s+(finance|procurement|legal|admin|IT|HR)\\s+(?:dekhta|dekhti|dekhte|sambhalta|sambhalti|handle karta|handle karti)`).exec(s);
    if (s5) sts.push({ name: s5[1], idx: s5.index, role: roleOf(s5[2]), raw: s5[0] });
    for (const st0 of sts) {
      const st = { ...st0, name: cleanName(st0.name) };
      if (!st.name || !isName(st.name)) continue;
      const mi = addMention("person", st.name, at(st.idx + Math.max(0, s.slice(st.idx).indexOf(st.name))));
      if (!ex.stakeholders.some((x) => x.mention_index === mi)) ex.stakeholders.push({ mention_index: mi, role: st.role, raw_text: st.raw.slice(0, 200), start: c.start, end: c.start + s.length });
    }

    // ---- other requirement fields (stored in requirement.constraints.values, always "estimated")
    const detail = (key: DetailKey, value: string | number | null) => {
      if (!ex.details.some((d) => d.key === key && d.start === c.start)) ex.details.push({ key, value, raw_text: s.slice(0, 300), start: c.start, end: c.start + s.length });
    };
    for (const [key, re] of DETAIL_PATTERNS) if (re.test(s)) detail(key, s.slice(0, 300));
    const fit = FITOUT.find(([re]) => re.test(s));
    if (fit) detail("fitout_standard", fit[1]);
    const lock = /lock[- ]?in\s*(?:of\s*|period\s*(?:of\s*)?)?(\d+(?:\.\d+)?)\s*(months?|years?|yrs?|saal)\b|(\d+(?:\.\d+)?)\s*(months?|years?|yrs?|saal)\s*(?:ka\s+|ki\s+)?lock[- ]?in/i.exec(s);
    if (lock) {
      const v = Number(lock[1] ?? lock[3]);
      const months = /month/i.test(lock[2] ?? lock[4]) ? v : v * 12;
      if (Number.isInteger(months)) detail("lockin_months", months);
    }
    const ten = /(\d+(?:\.\d+)?)\s*[- ]?(years?|yrs?|saal|months?)\s*(?:ka\s+|ki\s+|of\s+)?(?:lease|tenure|term)\b|(?:lease|tenure|term)\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*(years?|yrs?|months?)/i.exec(s);
    if (ten) {
      const v = Number(ten[1] ?? ten[3]);
      const months = /month/i.test(ten[2] ?? ten[4]) ? v : v * 12;
      if (Number.isInteger(months)) detail("tenure_months", months);
    }
    const catchment = new RegExp(`\\b(?:employees?|staff|team|people|log)\\s+(?:mostly\\s+|mainly\\s+)?(?:live|lives|stay|stays|come|comes|commute|commutes|rehte|aate)\\s+(?:hain\\s+)?(?:from|in|near|se|mein)?\\s*(${PLACE}(?:\\s*(?:,|and|or|aur)\\s*${PLACE})*)`).exec(s)
      ?? new RegExp(`\\b(?:employees?|staff|team|log)\\s+(${PLACE}(?:\\s*(?:,|and|or|aur)\\s*${PLACE})*)\\s+(?:se|mein)\\s+(?:aate|rehte)`).exec(s);
    if (catchment) detail("employee_catchments", catchment[1].split(/\s*(?:,|\band\b|\bor\b|\baur\b)\s*/).filter(Boolean).join(", "));
  }
  return ex;
}

// ------------------------------------------------------------------ sanitising model output
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/**
 * Apply the code-level rules to any extraction (model or mock): drop candidate IDs that were not offered,
 * force confirmation on critical fields, re-add rule-detected ambiguities the model missed, and null any value
 * a number/date ambiguity covers (unit questions keep the number but block the fact until answered).
 * Rule-detected promises, objections, stakeholder roles and requirement details the model skipped are added back.
 * Unknown keys are already rejected by the zod schema.
 */
export function enforceRules(model: Extraction, text: string, candidates: CandidateLists, opts: RuleOptions = {}): Extraction {
  const rules = ruleExtract(text, opts);
  const out: Extraction = withDefaults(structuredClone(model));
  out.mentions = out.mentions.map((m) => {
    const allowed = allowedIds(candidates, m);
    return { ...m, candidate_ids: [...new Set(m.candidate_ids)].filter((id) => allowed.has(id)) };
  });
  out.facts = out.facts.map((f) => ({ ...f, requires_confirmation: f.requires_confirmation || CRITICAL_FIELDS.includes(f.field) || f.status === "tentative" }));
  // rule ambiguities on overlapping spans win: the fact/task they refer to must stay unresolved
  for (const a of rules.ambiguities) {
    const covered = out.ambiguities.some((b) => b.kind === a.kind && overlaps(a, b));
    let fact_index: number | null = null, task_index: number | null = null;
    if (a.fact_index != null) {
      const rf = rules.facts[a.fact_index];
      const numeric = ["area_target_sf", "seats_target", "budget_max"];
      fact_index = out.facts.findIndex((f) => (a.kind === "unit" ? numeric.includes(f.field) && numeric.includes(rf.field) : f.field === rf.field) && overlaps(f, rf));
      if (fact_index < 0) fact_index = out.facts.push({ ...rf, proposed_value: a.kind === "unit" ? rf.proposed_value : null }) - 1;
      if (a.kind !== "unit") out.facts[fact_index].proposed_value = null;
      out.facts[fact_index].requires_confirmation = true;
    }
    if (a.task_index != null) {
      const rt = rules.tasks[a.task_index];
      task_index = out.tasks.findIndex((t) => overlaps(t, rt));
      if (task_index < 0) task_index = null;
    }
    if (!covered) out.ambiguities.push({ ...a, fact_index, task_index });
    else if (a.kind === "unit" && fact_index != null) {
      // the model asked too, but must not have picked a unit for the fact silently
      const b = out.ambiguities.find((x) => x.kind === "unit" && overlaps(a, x))!;
      b.fact_index = fact_index;
    }
  }
  // mention index mapping rule -> output (by kind + text), adding rule mentions the model missed
  const mapMention = (ri: number | null): number | null => {
    if (ri == null) return null;
    const rm = rules.mentions[ri];
    if (!rm) return null;
    const i = out.mentions.findIndex((m) => m.kind === rm.kind && m.text.toLowerCase() === rm.text.toLowerCase());
    if (i >= 0) return i;
    return out.mentions.push({ ...rm, candidate_ids: [] }) - 1;
  };
  for (const p of rules.promises) {
    if (out.promises.some((x) => overlaps(x, p))) continue;
    const ti = p.task_index != null ? out.tasks.findIndex((t) => overlaps(t, rules.tasks[p.task_index!])) : -1;
    out.promises.push({ ...p, who_mention_index: mapMention(p.who_mention_index), task_index: ti >= 0 ? ti : null });
  }
  for (const o of rules.objections) if (!out.objections.some((x) => overlaps(x, o))) out.objections.push(o);
  for (const d of rules.details) if (!out.details.some((x) => x.key === d.key && overlaps(x, d))) out.details.push(d);
  for (const s of rules.stakeholders) {
    const mi = mapMention(s.mention_index);
    if (mi != null && !out.stakeholders.some((x) => x.mention_index === mi)) out.stakeholders.push({ ...s, mention_index: mi });
  }
  // a stakeholder must point at a person mention
  out.stakeholders = out.stakeholders.filter((s) => out.mentions[s.mention_index]?.kind === "person");
  out.promises = out.promises.map((p) => ({ ...p, who_mention_index: p.who_mention_index != null && out.mentions[p.who_mention_index]?.kind === "person" ? p.who_mention_index : null }));
  return out;
}

/** Text offsets of a claim, for capture_span.source_locator. */
export function locator(kind: "text" | "transcript" | "photo_text", start: number, end: number) {
  return `${kind}:${start}-${end}`;
}
