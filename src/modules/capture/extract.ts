import { z } from "zod";
import { localDate } from "@/lib/util/time";

/**
 * Capture extraction contract (spec Part III "Example extraction/change contract", schema_version 1) and the
 * deterministic rule-based extractor used as the mock (and as the safety net applied to every model output).
 *
 * Rules that are code, never model judgement:
 *  - critical numbers (area/seats/budget) and dates always require confirmation;
 *  - confusable number words ("fifty"/"fifteen", "forty"/"fourteen", ...) become an ambiguity, never a value;
 *  - a month without a year ("by March") or a bare weekday ("Friday") becomes an ambiguity with concrete options;
 *  - entity IDs may only come from the permission-scoped candidate lists.
 */

export const FACT_FIELDS = ["area_target_sf", "seats_target", "budget_max", "occupation_date", "decision_date", "preferred_geography"] as const;
export type FactField = (typeof FACT_FIELDS)[number];
export const CRITICAL_FIELDS: FactField[] = ["area_target_sf", "seats_target", "budget_max", "occupation_date", "decision_date"];

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
  kind: z.enum(["date", "number", "entity"]),
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
export const ExtractionSchema = z.object({
  schema_version: z.literal("1"),
  interaction: z.object({ channel: z.enum(["call", "meeting", "visit", "whatsapp", "email", "note"]), summary: z.string().max(1000) }).nullable(),
  mentions: z.array(MentionSchema).max(30),
  facts: z.array(FactSchema).max(30),
  tasks: z.array(TaskSchema).max(20),
  ambiguities: z.array(AmbiguitySchema).max(30),
  drafts: z.array(DraftSchema).max(5),
});
export type Extraction = z.infer<typeof ExtractionSchema>;
export type Mention = z.infer<typeof MentionSchema>;
export type Fact = z.infer<typeof FactSchema>;
export type Ambiguity = z.infer<typeof AmbiguitySchema>;

export interface Candidate { id: string; entity_type: string; label: string; score: number; detail?: Record<string, unknown> }
/** Permission-scoped candidate lists, one per mention (kind + text) offered to the extractor. */
export type CandidateLists = { kind: Mention["kind"]; text: string; candidates: Candidate[] }[];

/** IDs a mention may legitimately carry: candidates offered for that mention text (fallback: any offered for its kind). */
export function allowedIds(lists: CandidateLists, m: Pick<Mention, "kind" | "text">): Set<string> {
  const exact = lists.filter((l) => l.kind === m.kind && l.text.toLowerCase() === m.text.toLowerCase());
  const pool = exact.length ? exact : lists.filter((l) => l.kind === m.kind);
  return new Set(pool.flatMap((l) => l.candidates.map((c) => c.id)));
}

// ------------------------------------------------------------------ numbers
const UNITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** "-teen" vs "-ty" words that speech recognition confuses. */
export const CONFUSABLE: Record<string, string> = { thirteen: "thirty", thirty: "thirteen", fourteen: "forty", forty: "fourteen",
  fifteen: "fifty", fifty: "fifteen", sixteen: "sixty", sixty: "sixteen", seventeen: "seventy", seventy: "seventeen",
  eighteen: "eighty", eighty: "eighteen", nineteen: "ninety", ninety: "nineteen" };
const WORD_NUM = [...Object.keys(UNITS), ...Object.keys(TENS)].join("|");
const MULT: Record<string, number> = { k: 1_000, thousand: 1_000, lakh: 1_00_000, lakhs: 1_00_000, lac: 1_00_000, l: 1_00_000, cr: 1_00_00_000, crore: 1_00_00_000, crores: 1_00_00_000 };

function wordValue(w: string): number | null {
  const lw = w.toLowerCase();
  return UNITS[lw] ?? TENS[lw] ?? null;
}

// ------------------------------------------------------------------ dates
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_RE = "sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?";

function monthIndex(s: string) { return MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3))); }
function weekdayIndex(s: string) { return WEEKDAYS.findIndex((d) => d.startsWith(s.toLowerCase().slice(0, 3))); }
function iso(y: number, m0: number, d: number) { return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
function lastDay(y: number, m0: number) { return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate(); }
function addDays(isoDate: string, n: number) { const d = new Date(`${isoDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

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

// ------------------------------------------------------------------ rule extractor
const TASK_VERBS = "send|share|call|email|mail|prepare|follow up|follow-up|schedule|arrange|check|book|set up|setup|confirm|remind|whatsapp|draft";
const CHANNEL_VERBS: [RegExp, Extraction["interaction"] extends infer T ? T extends { channel: infer C } ? C : never : never][] = [
  [/\b(spoke|spoken|talked|called|call|phoned|rang)\b/i, "call"],
  [/\b(met|meeting|catch-?up|lunch|coffee)\b/i, "meeting"],
  [/\b(visited|site visit|visit)\b/i, "visit"],
  [/\bwhats ?app\b/i, "whatsapp"],
  [/\b(emailed|mailed)\b/i, "email"],
];
const NAME = "[A-Z][a-zA-Z'.-]+(?: [A-Z][a-zA-Z'.-]+){0,2}";

interface Clause { text: string; start: number }
function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  const re = /[^;\n.!?]+/g;
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

export function ruleExtract(text: string, opts: RuleOptions = {}): Extraction {
  const src = localDate(opts.sourceAt ? new Date(opts.sourceAt) : new Date(), opts.timezone);
  const ex: Extraction = { schema_version: "1", interaction: null, mentions: [], facts: [], tasks: [], ambiguities: [], drafts: [] };
  const addMention = (kind: Mention["kind"], t: string, start: number) => {
    const existing = ex.mentions.findIndex((x) => x.kind === kind && x.text.toLowerCase() === t.toLowerCase());
    if (existing >= 0) return existing;
    ex.mentions.push({ kind, text: t, start, end: start + t.length, candidate_ids: [] });
    return ex.mentions.length - 1;
  };
  let personIdx: number | null = null;

  for (const c of clauses(text)) {
    const s = c.text;
    const at = (i: number) => c.start + i;
    let used = false;

    // interaction + who/where: "spoke to Raj at Acme", "met Priya from Zenith Labs"
    for (const [re, ch] of CHANNEL_VERBS) {
      if (re.test(s) && !ex.interaction) ex.interaction = { channel: ch, summary: text.trim().slice(0, 1000) };
    }
    const who = new RegExp(`\\b(?:spoke|spoken|talked|called|met|meeting|call|rang|phoned|visited|whatsapp(?:ed)?)\\s+(?:to\\s+|with\\s+)?(${NAME})(?:\\s+(?:at|from|of)\\s+(${NAME}))?`).exec(s);
    if (who) {
      personIdx = addMention("person", who[1], at(who.index + who[0].indexOf(who[1])));
      if (who[2]) addMention("organisation", who[2], at(who.index + who[0].lastIndexOf(who[2])));
      used = true;
    } else {
      const org = new RegExp(`\\b(?:at|from)\\s+(${NAME})`).exec(s);
      if (org && /\b(spoke|met|called|talked)\b/i.test(text)) addMention("organisation", org[1], at(org.index + org[0].indexOf(org[1])));
    }

    // area / seats / budget numbers
    const numRe = new RegExp(`(?:(₹|rs\\.?|inr)\\s*)?\\b(\\d+(?:\\.\\d+)?|${WORD_NUM})(?:[\\s-]+(${WORD_NUM}))?\\s*(k|thousand|lakhs?|lac|l|cr|crores?)?\\b\\s*(sq\\.?\\s?ft|sqft|sf|square feet|seats?|desks?|per sq\\.?\\s?ft|psf|/sf)?`, "gi");
    let n: RegExpExecArray | null;
    while ((n = numRe.exec(s))) {
      const [whole, cur, base, second, mult, unit] = n;
      if (!base) continue;
      const isWord = isNaN(Number(base));
      const preceding = s.slice(0, n.index);
      if (/\b(?:by|in|on|before|after)\s*$/i.test(preceding) && !mult && !unit) continue;   // dates like "by 15"
      if (!isWord && !mult && !unit && !cur) continue;                                         // bare numbers carry no field
      let value = isWord ? (wordValue(base) ?? 0) + (second ? wordValue(second) ?? 0 : 0) : Number(base);
      if (mult) value *= MULT[mult.toLowerCase()] ?? 1;
      const u = (unit ?? "").toLowerCase();
      let field: FactField = "area_target_sf";
      let unitLabel: string | null = "sf";
      if (/seat|desk/.test(u)) { field = "seats_target"; unitLabel = "seats"; }
      else if (cur || /per|psf|\/sf/.test(u)) { field = "budget_max"; unitLabel = "INR/sf/month"; }
      else if (!u && !mult && isWord) {
        // a bare number word with no unit or multiplier is not a fact we can place
        continue;
      }
      const tentative = /\b(maybe|around|approx|approximately|roughly|about|~|possibly)\b/i.test(s);
      const fi = ex.facts.push({ entity_type: "requirement", field, proposed_value: value, raw_text: whole.trim(), unit: unitLabel,
        status: tentative ? "tentative" : "reported", requires_confirmation: true, start: at(n.index), end: at(n.index + whole.trimEnd().length) }) - 1;
      const conf = [base, second].filter(Boolean).map((w) => w!.toLowerCase()).find((w) => CONFUSABLE[w]);
      if (conf) {
        const alt = CONFUSABLE[conf];
        const altValue = (() => {
          let v = (wordValue(alt) ?? 0) + (second && second.toLowerCase() !== conf ? wordValue(second) ?? 0 : 0);
          if (base.toLowerCase() !== conf && wordValue(base) != null) v = (wordValue(base) ?? 0) + (wordValue(alt) ?? 0);
          return mult ? v * (MULT[mult.toLowerCase()] ?? 1) : v;
        })();
        ex.ambiguities.push({ kind: "number", question: `Did they say "${conf}" or "${alt}"? (${value.toLocaleString("en-IN")} vs ${altValue.toLocaleString("en-IN")} ${unitLabel ?? ""})`.trim(),
          options: [{ label: `${value.toLocaleString("en-IN")} ${unitLabel ?? ""}`.trim(), value }, { label: `${altValue.toLocaleString("en-IN")} ${unitLabel ?? ""}`.trim(), value: altValue }],
          fact_index: fi, task_index: null, mention_index: null, start: at(n.index), end: at(n.index + whole.trimEnd().length) });
        ex.facts[fi].proposed_value = null;   // never silently pick one
      }
      used = true;
    }

    // occupation / decision dates: "by March", "decision by June 2027"
    const dm = new RegExp(`\\b(by|before|from|in|decision (?:by|in))\\s+(?:end of\\s+)?(${MONTH_RE})\\b(?:\\s+(\\d{4}))?`, "i").exec(s);
    if (dm && !/\b(send|share|call|email)\b/i.test(s.slice(0, dm.index))) {
      const m0 = monthIndex(dm[2]);
      const field: FactField = /decision/i.test(dm[1]) || /\bdecid/i.test(s) ? "decision_date" : "occupation_date";
      const start = at(dm.index), end = at(dm.index + dm[0].length);
      if (dm[3]) {
        const y = Number(dm[3]);
        ex.facts.push({ entity_type: "requirement", field, proposed_value: iso(y, m0, lastDay(y, m0)), raw_text: dm[0], unit: "date",
          status: "reported", requires_confirmation: true, start, end });
      } else {
        const [a, b] = monthOptions(src, m0);
        const fi = ex.facts.push({ entity_type: "requirement", field, proposed_value: null, raw_text: dm[0], unit: "date",
          status: "reported", requires_confirmation: true, start, end }) - 1;
        const label = MONTHS[m0][0].toUpperCase() + MONTHS[m0].slice(1);
        ex.ambiguities.push({ kind: "date", question: `Which ${label} — ${a.slice(0, 4)} or ${b.slice(0, 4)}?`,
          options: [{ label: `${label} ${a.slice(0, 4)}`, value: a }, { label: `${label} ${b.slice(0, 4)}`, value: b }],
          fact_index: fi, task_index: null, mention_index: null, start, end });
      }
      used = true;
    }

    // geography preference: "maybe Baner", "prefer Kharadi or Viman Nagar"
    const gm = /\b(maybe|prefer(?:s|red)?|ideally|likes?|looking at|in)\s+([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)?)(?:\s+or\s+([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)?))?/.exec(s);
    if (gm && monthIndex(gm[2]) < 0 && !who) {
      for (const g of [gm[2], gm[3]].filter(Boolean) as string[]) {
        const mi = addMention("geography", g, at(gm.index + gm[0].indexOf(g)));
        ex.facts.push({ entity_type: "requirement", field: "preferred_geography", proposed_value: g, raw_text: gm[0], unit: null,
          status: /maybe|ideally|likes?/i.test(gm[1]) ? "tentative" : "reported", requires_confirmation: true,
          start: ex.mentions[mi].start, end: ex.mentions[mi].end });
      }
      used = true;
    }

    // tasks: imperative clauses
    const tm = new RegExp(`^(?:(?:need to|to|pls|please|must|will|i'll|todo:?)\\s+)?(${TASK_VERBS})\\b(.*)$`, "i").exec(s);
    if (tm) {
      let desc = s.replace(/\s+/g, " ");
      let due: string | null = null;
      const wd = new RegExp(`\\b(?:by|on|before|next|this)?\\s*(${WEEKDAY_RE})\\b`, "i").exec(s);
      const ti = ex.tasks.length;
      if (wd) {
        const [a, b] = weekdayOptions(src, weekdayIndex(wd[1]));
        due = a;
        const dayLabel = WEEKDAYS[weekdayIndex(wd[1])];
        ex.ambiguities.push({ kind: "date", question: `Which ${dayLabel[0].toUpperCase() + dayLabel.slice(1)} is intended — ${a} or ${b}?`,
          options: [{ label: a, value: a }, { label: b, value: b }], fact_index: null, task_index: ti, mention_index: null,
          start: at(wd.index), end: at(wd.index + wd[0].length) });
        desc = desc.replace(wd[0], "").replace(/\s+/g, " ").trim();
      } else if (/\btomorrow\b/i.test(s)) {
        due = addDays(src, 1);
      }
      const person = personIdx != null ? ex.mentions[personIdx] : null;
      const org = ex.mentions.find((m) => m.kind === "organisation");
      if (person && !new RegExp(`\\b${person.text}\\b`, "i").test(desc)) desc += ` to ${person.text}${org ? ` (${org.text})` : ""}`;
      desc = desc[0].toUpperCase() + desc.slice(1);
      ex.tasks.push({ description: desc, due_date: due, start: c.start, end: c.start + s.length });
      if (/^(send|share|email|mail|whatsapp)\b/i.test(tm[1]) && person) {
        const channel = /whatsapp/i.test(tm[1]) ? "whatsapp" : "email";
        ex.drafts.push({ channel, purpose: desc.slice(0, 200), recipient_mention_index: personIdx, task_index: ti,
          body: `Hi ${person.text.split(" ")[0]},\n\nThanks for the time today. As discussed, ${tm[2].trim().replace(/\b(on|by)?\s*(${WEEKDAY_RE})\b/i, "").trim() || "the details"} — I'll share these shortly.\n\nRegards` });
      }
      used = true;
    }
    void used;
  }
  return ex;
}

// ------------------------------------------------------------------ sanitising model output
/**
 * Apply the code-level rules to any extraction (model or mock): drop candidate IDs that were not offered,
 * force confirmation on critical fields, re-add rule-detected ambiguities the model missed, and null any value
 * an ambiguity covers. Unknown keys are already rejected by the zod schema.
 */
export function enforceRules(model: Extraction, text: string, candidates: CandidateLists, opts: RuleOptions = {}): Extraction {
  const rules = ruleExtract(text, opts);
  const out: Extraction = structuredClone(model);
  out.mentions = out.mentions.map((m) => {
    const allowed = allowedIds(candidates, m);
    return { ...m, candidate_ids: [...new Set(m.candidate_ids)].filter((id) => allowed.has(id)) };
  });
  out.facts = out.facts.map((f) => ({ ...f, requires_confirmation: f.requires_confirmation || CRITICAL_FIELDS.includes(f.field) || f.status === "tentative" }));
  // rule ambiguities on overlapping spans win: the fact/task they refer to must stay unresolved
  for (const a of rules.ambiguities) {
    const covered = out.ambiguities.some((b) => b.kind === a.kind && b.start < a.end && a.start < b.end);
    let fact_index: number | null = null, task_index: number | null = null;
    if (a.fact_index != null) {
      const rf = rules.facts[a.fact_index];
      fact_index = out.facts.findIndex((f) => f.field === rf.field && f.start < rf.end && rf.start < f.end);
      if (fact_index < 0) fact_index = out.facts.push({ ...rf, proposed_value: null }) - 1;
      out.facts[fact_index].proposed_value = null;
      out.facts[fact_index].requires_confirmation = true;
    }
    if (a.task_index != null) {
      const rt = rules.tasks[a.task_index];
      task_index = out.tasks.findIndex((t) => t.start < rt.end && rt.start < t.end);
      if (task_index < 0) task_index = null;
    }
    if (!covered) out.ambiguities.push({ ...a, fact_index, task_index });
  }
  return out;
}

/** Text offsets of a claim, for capture_span.source_locator. */
export function locator(kind: "text" | "transcript", start: number, end: number) {
  return `${kind}:${start}-${end}`;
}
