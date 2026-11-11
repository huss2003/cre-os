/**
 * Prospect researcher — rule-based business-signal detection over stored / pasted evidence (pure, deterministic).
 * Output is a HYPOTHESIS per signal kind (status ai_inference, tier inference) that links back to the evidence it came from
 * and expires. Hiring activity is never treated as proof of an office-size commitment; no seat/area figure is derived.
 */
import { HIRING_NOTE } from "./dossier";

export type SignalKind = "expansion" | "consolidation" | "rto" | "gcc_plan" | "hiring" | "leadership_change" | "funding" | "lease_expiry";

export interface DetectedSignal { kind: SignalKind; rule: string; matched: string; context: string; surge?: boolean; withinMonths?: number }

interface Rule { kind: SignalKind; rule: string; re: RegExp }

const RULES: Rule[] = [
  { kind: "expansion", rule: "expansion_terms", re: /\b(expan(?:d|ds|ding|sion)|new (?:office|campus|centre|center|facility|site|hub)|second (?:office|site|campus|centre|center)|additional (?:office|space|floors?|seats)|open(?:s|ed|ing)? (?:a )?new (?:office|centre|center|campus)|scal(?:e|es|ing) up (?:its |our |the )?(?:presence|operations|team)|lease[sd]? (?:a )?new)\b/i },
  { kind: "consolidation", rule: "consolidation_terms", re: /\b(consolidat\w*|downsiz\w*|exit(?:s|ing|ed)? (?:the |its |their )?(?:office|lease|premises|campus)|shut(?:s|ting)? down (?:its |the |their )?(?:office|centre|center|campus)|merg(?:e|es|ing) (?:offices|sites|campuses)|rationali[sz]\w* (?:of )?(?:real estate|space|footprint|offices)|sublet\w*|surrender\w* (?:of )?(?:space|floors?))\b/i },
  { kind: "rto", rule: "return_to_office", re: /\b(return[- ]to[- ](?:the[- ])?office|back to (?:the )?office|(?:\d|three|four|five) days (?:a|per) week in (?:the )?office|in[- ]office mandate|office attendance (?:policy|mandate)|hybrid (?:policy|mandate))\b/i },
  { kind: "rto", rule: "rto_acronym", re: /\bRTO\b/ },
  { kind: "gcc_plan", rule: "gcc_terms", re: /\b(global capability (?:centre|center)s?|captive (?:centre|center|unit)|global (?:in-house|technology|innovation|delivery|business services) (?:centre|center)|cent(?:re|er) of excellence|offshore (?:development )?(?:centre|center))\b/i },
  { kind: "gcc_plan", rule: "gcc_acronym", re: /\bGCCs?\b/ },
  { kind: "hiring", rule: "hiring_terms", re: /\b(hiring|recruit(?:s|ing|ment)|to hire|plans? to add \d[\d,]* (?:people|employees|engineers|staff)|headcount (?:growth|increase)|job openings|open (?:roles|positions)|walk-in drive)\b/i },
  { kind: "leadership_change", rule: "leadership_terms", re: /\b(appoint(?:s|ed|ment)|names? [A-Z][\w.]*(?: [A-Z][\w.]*){0,3} as|new (?:CEO|CFO|COO|CTO|MD|managing director|country head|head of [a-z]+|president|site (?:head|leader)|chief [a-z]+ officer)|join(?:s|ed) as|steps? down|stepped down|resign(?:s|ed|ation)|elevated to|promoted to|takes? (?:over )?charge)\b/i },
  { kind: "lease_expiry", rule: "lease_expiry_terms", re: /\b(lease[sd]?\b[^.]{0,60}?\b(?:expir\w*|(?:is |are )?due (?:to (?:expire|end)|for renewal)|ends?|ending|runs? out|up for renewal|renewal)|(?:expir\w*|renewal) of (?:its |the |their )?(?:existing |current )?(?:\w+ )?lease)\b/i },
  { kind: "funding", rule: "funding_terms", re: /\b(rais(?:ed|es|ing) (?:\$|₹|rs\.?|inr|usd|us\$)?\s?[\d.,]+\s?(?:million|mn|crore|cr|billion|bn|lakh)?|series [a-h]\b|funding round|seed round|pre-ipo|\bIPO\b|investment from|growth capital|private equity)\b/i },
];

const SURGE = /\b(mass hiring|hiring spree|ramp(?:s|ing)? up hiring|aggressive hiring|(?:hire|add|recruit)\w* (?:over |more than |about |around )?(?:[1-9]\d{2,}|[5-9]\d)[\d,]* (?:people|employees|engineers|staff|professionals|roles))\b/i;
const NEGATION = /\b(no|not|never|den(?:y|ies|ied)|rule[sd]? out|without|unlikely)\b[^.]{0,30}$/i;

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, six: 6, nine: 9, twelve: 12, eighteen: 18, twenty: 20, "twenty-four": 24 };
/** "within 12 months" / "in the next six months" / "within a year" -> months (only when stated; never guessed). */
export function withinMonths(text: string): number | null {
  const m = /\b(?:within|in(?: the)?(?: next)?|over the next)\s+(\d{1,2}|one|two|three|four|six|nine|twelve|eighteen|twenty|twenty-four|a)\s+(months?|years?)\b/i.exec(text);
  if (!m) return null;
  const n = m[1].toLowerCase() === "a" ? 1 : /^\d+$/.test(m[1]) ? Number(m[1]) : WORDS[m[1].toLowerCase()] ?? null;
  if (n === null) return null;
  return /year/i.test(m[2]) ? n * 12 : n;
}

function contextOf(text: string, idx: number, len: number): string {
  const s = Math.max(0, idx - 80);
  const e = Math.min(text.length, idx + len + 80);
  return `${s > 0 ? "…" : ""}${text.slice(s, e).replace(/\s+/g, " ").trim()}${e < text.length ? "…" : ""}`;
}

/** One hypothesis per signal kind (first non-negated match). Untrusted text is only pattern-matched, never executed. */
export function detectSignals(text: string): DetectedSignal[] {
  const t = (text ?? "").slice(0, 20_000);
  const out = new Map<SignalKind, DetectedSignal>();
  for (const r of RULES) {
    if (out.has(r.kind)) continue;
    const re = new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : `${r.re.flags}g`);
    for (const m of t.matchAll(re)) {
      const idx = m.index ?? 0;
      const before = t.slice(Math.max(0, idx - 40), idx);
      if (NEGATION.test(before)) continue;
      const sig: DetectedSignal = { kind: r.kind, rule: r.rule, matched: m[0], context: contextOf(t, idx, m[0].length) };
      if (r.kind === "hiring") sig.surge = SURGE.test(t);
      if (r.kind === "lease_expiry") { const n = withinMonths(t.slice(idx, idx + 200)); if (n !== null) sig.withinMonths = n; }
      out.set(r.kind, sig);
      break;
    }
  }
  return [...out.values()];
}

export const SIGNAL_LABEL: Record<SignalKind, string> = {
  expansion: "expansion", consolidation: "consolidation", rto: "return-to-office", gcc_plan: "GCC plan",
  hiring: "hiring", leadership_change: "leadership change", funding: "funding", lease_expiry: "lease expiry",
};

/** Text of the hypothesis claim. Hiring always carries the "not an office-size commitment" caveat. */
export function hypothesisSummary(s: DetectedSignal): string {
  const base = `Possible ${SIGNAL_LABEL[s.kind]}${s.kind === "hiring" && s.surge ? " surge" : ""} — rule-detected hypothesis from stored evidence (“${s.context.slice(0, 220)}”). Verify before relying on it.`;
  return s.kind === "hiring" ? `${base} ${HIRING_NOTE}` : base;
}
