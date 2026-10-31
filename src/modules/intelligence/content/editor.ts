/**
 * Content editor — pure helpers (spec Part I §8 "Content editor", P1).
 * Weekly plan, LinkedIn / market-note drafts in the user's voice, brand/confidentiality checklist, manual publish only.
 */

export type Audience = "occupier_leadership" | "hr_admin" | "finance_procurement" | "landlords" | "general";
export const AUDIENCES: Audience[] = ["occupier_leadership", "hr_admin", "finance_procurement", "landlords", "general"];
export const AUDIENCE_LABEL: Record<Audience, string> = {
  occupier_leadership: "Occupier leadership", hr_admin: "HR / admin", finance_procurement: "Finance / procurement", landlords: "Landlords", general: "General",
};

const ANGLES: Record<Audience, string[]> = {
  occupier_leadership: ["Why the notice window, not the expiry date, drives your office decision", "Consolidate, renew or relocate: the questions to ask first"],
  hr_admin: ["Commute catchments and attendance: what to check before shortlisting", "Fit-out timelines and the employee-experience trade-offs"],
  finance_procurement: ["Comparing offers on effective rent and total occupancy cost, not headline rent", "Deposits, escalations and rent-free: reading the full cash flow"],
  landlords: ["What occupiers are asking for in Pune this quarter", "Reinstatement and CAM clauses that slow deals down"],
  general: ["What the latest Pune office market release does and does not say", "Three lease dates every occupier should track"],
};

export interface PlanIdea { audience: Audience; channel: "linkedin" | "market_note"; topic: string; evidence_hint: string; /** Days after the week start (Monday) the post is planned for. */ day_offset: number }

/** Deterministic weekly plan: 2 LinkedIn posts + 1 market note, rotating audiences by ISO week. */
export function weeklyPlan(weekStart: string, opts: { hasMarketData: boolean } = { hasMarketData: false }): PlanIdea[] {
  const wk = isoWeek(weekStart);
  const a1 = AUDIENCES[wk % 4];
  const a2 = AUDIENCES[(wk + 2) % 4];
  const out: PlanIdea[] = [
    { audience: a1, channel: "linkedin", topic: ANGLES[a1][wk % 2], evidence_hint: "Use one approved public fact or your own experience; no client names.", day_offset: 1 },
    { audience: a2, channel: "linkedin", topic: ANGLES[a2][(wk + 1) % 2], evidence_hint: "Use one approved public fact or your own experience; no client names.", day_offset: 3 },
  ];
  out.push({ audience: "general", channel: "market_note", topic: opts.hasMarketData ? "Market note from the latest validated release" : "Market note — add a validated market release first", evidence_hint: opts.hasMarketData ? "Facts are computed from gated market observations." : "No gated market observations yet.", day_offset: 2 });
  return out;
}

export function isoWeek(dateIso: string): number {
  const d = new Date(`${dateIso.slice(0, 10)}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}

export function weekStartOf(dateIso: string): string {
  const d = new Date(`${dateIso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export interface CheckItem { key: string; label: string; ok: boolean; detail: string }

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/;
const MONEY = /₹\s?\d|rs\.?\s?\d|inr\s?\d|\d+\s?(?:\/|per)\s?(?:sq\.?\s?ft|sf|sft)/i;
const FORECAST = /\b(will (?:rise|fall|increase|decrease|grow)|guarantee[ds]?|certainly|definitely|predict(?:s|ed)?)\b/i;

export interface ChecklistContext {
  clientNames: string[];
  confidentialTerms?: string[];
  hasEvidence: boolean;
  channel: string;
  brandRules?: string[];
  /** True when the user confirmed the manual brand rules for exactly this body (hash-bound). */
  brandConfirmed?: boolean;
  /** Result of factCheck(); when present, unmatched claims block approval. */
  factCheck?: FactCheck;
  /** Licensed sources behind the linked facts. */
  licensed?: { name: string; permitsPublication: boolean }[];
  /** Linked market notes that are not (or no longer) approved. */
  unapprovedEvidence?: string[];
}

/** Brand / confidentiality / fact checklist. Deterministic; every item must pass before approval (checklistPasses). */
export function reviewChecklist(body: string, ctx: ChecklistContext): CheckItem[] {
  const lower = body.toLowerCase();
  const hasFigures = /\d/.test(body.replace(/^\s*\d{1,2}[.)]\s/gm, ""));
  const named = ctx.clientNames.filter((n) => n.trim().length >= 3 && new RegExp(`\\b${escapeRe(n.toLowerCase())}\\b`).test(lower));
  const conf = (ctx.confidentialTerms ?? []).filter((t) => t && t.trim().length >= 2 && lower.includes(t.trim().toLowerCase()));
  const items: CheckItem[] = [
    { key: "no_client_names", label: "No client or prospect names", ok: named.length === 0, detail: named.length ? `Mentions: ${named.slice(0, 5).join(", ")}` : "None found." },
    { key: "no_personal_data", label: "No personal contact details", ok: !EMAIL.test(body) && !PHONE.test(body), detail: EMAIL.test(body) || PHONE.test(body) ? "Email or phone number present." : "None found." },
    { key: "no_deal_prices", label: "No deal-specific prices or quotes", ok: !MONEY.test(body) || ctx.hasEvidence, detail: MONEY.test(body) ? (ctx.hasEvidence ? "Prices present — confirm they come from the cited public source." : "Prices present without a cited public source.") : "None found." },
    { key: "no_forecast_claims", label: "No forecasts or guarantees", ok: !FORECAST.test(body), detail: FORECAST.test(body) ? "Contains forecast/guarantee language." : "None found." },
    { key: "no_confidential_terms", label: "No confidential terms", ok: conf.length === 0, detail: conf.length ? `Contains: ${conf.join(", ")}` : `None found${ctx.confidentialTerms?.length ? ` (${ctx.confidentialTerms.length} term(s) checked)` : " (no confidential terms configured)"}.` },
    { key: "cites_evidence", label: "Facts cite an approved source", ok: ctx.hasEvidence || !hasFigures, detail: ctx.hasEvidence ? "Evidence linked." : hasFigures ? "Numbers present without linked evidence." : "No figures used." },
    { key: "length", label: ctx.channel === "linkedin" ? "Within LinkedIn length (≤ 3,000 chars)" : "Reasonable length", ok: ctx.channel !== "linkedin" || body.length <= 3000, detail: `${body.length} characters.` },
  ];
  if (ctx.factCheck) {
    const u = ctx.factCheck.unmatched;
    items.push({ key: "fact_check", label: "Every number, date, company and claim matches approved evidence", ok: u.length === 0, detail: u.length ? `${u.length} unmatched: ${u.slice(0, 6).map((c) => `${c.kind} “${c.text}”`).join("; ")}` : `${ctx.factCheck.claims.length} claim(s) checked against ${ctx.factCheck.evidenceCount} approved fact(s).` });
  }
  if (ctx.unapprovedEvidence?.length) items.push({ key: "evidence_approved", label: "Only approved market notes feed this draft", ok: false, detail: `Not approved: ${ctx.unapprovedEvidence.join(", ")}` });
  if (ctx.licensed?.length) {
    const blocked = ctx.licensed.filter((l) => !l.permitsPublication);
    items.push({ key: "licensed_content", label: "Licensed content cleared for publication", ok: blocked.length === 0, detail: blocked.length ? `Licence does not allow publication: ${[...new Set(blocked.map((b) => b.name))].join(", ")} — use the private-shareable version or remove those facts.` : `Licensed source(s) permit publication: ${[...new Set(ctx.licensed.map((l) => l.name))].join(", ")}.` });
  }
  ctx.brandRules?.forEach((rule, idx) => items.push(brandItem(rule, idx, body, !!ctx.brandConfirmed)));
  return items;
}

/** All items — including brand rules, fact check and licensed-content items — must pass. */
export function checklistPasses(items: CheckItem[]): boolean {
  return items.length > 0 && items.every((i) => i.ok);
}

// ------------------------------------------------------------------ brand rules
export type BrandRule =
  | { kind: "banned"; phrases: string[] } | { kind: "required"; phrase: string } | { kind: "max_hashtags"; n: number }
  | { kind: "max_chars"; n: number } | { kind: "max_words"; n: number } | { kind: "no_emoji" } | { kind: "no_exclamation" } | { kind: "manual"; text: string };

/** Parse a brand rule into a deterministic check where possible; anything else needs a (hash-bound) manual confirmation. */
export function parseBrandRule(rule: string): BrandRule {
  const r = rule.trim();
  if (/^no\s+emojis?\b/i.test(r)) return { kind: "no_emoji" };
  if (/^no\s+exclamation/i.test(r)) return { kind: "no_exclamation" };
  if (/^no\s+hashtags?\b/i.test(r)) return { kind: "max_hashtags", n: 0 };
  let m = r.match(/(?:max(?:imum)?|at most|up to|no more than)\s*(\d+)\s*hashtags?/i) ?? r.match(/hashtags?\s*(?:max(?:imum)?|≤|<=|:)\s*(\d+)/i);
  if (m) return { kind: "max_hashtags", n: Number(m[1]) };
  m = r.match(/(?:max(?:imum)?|at most|up to|no more than)\s*(?:length\s*(?:of\s*)?)?(\d[\d,]*)\s*(?:chars?|characters)/i);
  if (m) return { kind: "max_chars", n: Number(m[1].replace(/,/g, "")) };
  m = r.match(/(?:max(?:imum)?|at most|up to|no more than)\s*(\d[\d,]*)\s*words/i);
  if (m) return { kind: "max_words", n: Number(m[1].replace(/,/g, "")) };
  m = r.match(/^(?:must|always)\s+(?:include|mention|use|contain)\s*:?\s*["“]?(.+?)["”]?\s*$/i);
  if (m) return { kind: "required", phrase: m[1] };
  m = r.match(/^(?:avoid|never\s+(?:use|say|write)|don'?t\s+(?:use|say|write)|do not\s+(?:use|say|write)|banned(?:\s+words?)?|no)\s*:?\s*(.+)$/i);
  if (m) return { kind: "banned", phrases: m[1].split(/[,;]|\bor\b/).map((x) => x.trim().replace(/^["“']|["”']$/g, "")).filter((x) => x.length > 0) };
  return { kind: "manual", text: r };
}

const EMOJI = /\p{Extended_Pictographic}/u;

function brandItem(rule: string, idx: number, body: string, confirmed: boolean): CheckItem {
  const p = parseBrandRule(rule);
  const key = `brand:${idx}`;
  const label = `Brand rule: ${rule}`;
  const lower = body.toLowerCase();
  switch (p.kind) {
    case "banned": { const hit = p.phrases.filter((ph) => new RegExp(`(?<![\\p{L}\\d])${escapeRe(ph.toLowerCase())}(?![\\p{L}\\d])`, "u").test(lower)); return { key, label, ok: hit.length === 0, detail: hit.length ? `Uses: ${hit.join(", ")}` : "Checked automatically — none used." }; }
    case "required": return { key, label, ok: lower.includes(p.phrase.toLowerCase()), detail: lower.includes(p.phrase.toLowerCase()) ? "Present." : `Missing “${p.phrase}”.` };
    case "max_hashtags": { const n = (body.match(/(?:^|\s)#[\p{L}\d_]+/gu) ?? []).length; return { key, label, ok: n <= p.n, detail: `${n} hashtag(s); limit ${p.n}.` }; }
    case "max_chars": return { key, label, ok: body.length <= p.n, detail: `${body.length} characters; limit ${p.n}.` };
    case "max_words": { const n = body.split(/\s+/).filter(Boolean).length; return { key, label, ok: n <= p.n, detail: `${n} words; limit ${p.n}.` }; }
    case "no_emoji": return { key, label, ok: !EMOJI.test(body), detail: EMOJI.test(body) ? "Contains emoji." : "None." };
    case "no_exclamation": return { key, label, ok: !body.includes("!"), detail: body.includes("!") ? "Contains “!”." : "None." };
    default: return { key, label, ok: confirmed, detail: confirmed ? "Confirmed manually for this exact text." : "Can't be checked automatically — read the draft and confirm brand review (re-confirm after any edit)." };
  }
}

// ------------------------------------------------------------------ fact check
export interface EvidenceFact { text: string; source: string; date: string | null; kind: "market_note" | "public_fact"; ref: string; licensed?: boolean }
export interface Claim { kind: "number" | "date" | "company" | "claim"; text: string; sentence: string; matched: boolean; evidence: string | null }
export interface FactCheck { claims: Claim[]; unmatched: Claim[]; evidenceCount: number }

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_RE = new RegExp(String.raw`\b(?:\d{1,2}\s+${MONTH}\.?,?\s+\d{4}|${MONTH}\.?\s+\d{1,2},?\s+\d{4}|${MONTH}\.?\s+\d{4}|Q[1-4]\s*(?:FY\s*)?'?\d{2,4}|H[12]\s*(?:FY\s*)?\d{2,4}|FY\s*'?\d{2,4}(?:-\d{2})?|\d{4}-\d{2}-\d{2}|(?:19|20)\d{2})\b`, "gi");
const NUM_RE = /(?<![\w.])(?:₹\s?|rs\.?\s?|inr\s?)?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|per\s?cent|msf|mn|million|lakh|crore|cr|sq\.?\s?ft|sf|sft))?/gi;
const COMPANY_RE = /\b(?:[A-Z][\w&'.-]*\s+){0,4}(?:Ltd|Limited|Pvt|Private Limited|Inc|LLP|LLC|Corp|Corporation|Technologies|Group|Bank|Realty|Properties|Developers|Infotech|Solutions|Services)\b\.?/g;
const TREND_UP = /\b(rose|risen|rising|increased|increase[sd]?|grew|grown|growth|jumped|surged|doubled|climbed|higher|up by)\b/i;
const TREND_DOWN = /\b(fell|fallen|falling|decreased|decrease[sd]?|declined|decline|dropped|halved|slowed|lower|down by)\b/i;
const SUPERLATIVE = /\b(record|highest|lowest|largest|smallest|biggest|most active|first time)\b/i;
const METRIC_WORDS = ["rent", "rental", "absorption", "take-up", "leasing", "supply", "completions", "vacancy", "stock", "inventory", "transactions", "demand", "occupancy", "cam"];

const numVal = (s: string): number | null => { const m = s.replace(/,/g, "").match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
const normD = (s: string) => s.toLowerCase().replace(/[.,']/g, "").replace(/\s+/g, " ").trim();

/**
 * Deterministic fact check: every number, date, company name and market claim in the draft must be supported by the
 * linked APPROVED evidence (approved market-note facts and public-source facts). Unmatched items are listed and block approval.
 * Plain advice with no figures, dates, names or trend claims needs no evidence. Numbered list markers are ignored.
 */
export function factCheck(body: string, evidence: EvidenceFact[], knownOrgs: string[] = []): FactCheck {
  // Citations "(Source: …, released YYYY-MM-DD)" are provenance, not claims: they never support or create a claim.
  const CITE = /\(Source:[^)]*\)/gi;
  const evText = evidence.map((e) => e.text.replace(CITE, "")).join("\n");
  const evLower = evText.toLowerCase();
  const evNums = new Set<number>();
  for (const m of evText.matchAll(NUM_RE)) { const v = numVal(m[0]); if (v !== null) evNums.add(v); }
  const evNorm = normD(evText);
  const sentences = body.replace(CITE, "").replace(/^\s*\d{1,2}[.)]\s+/gm, "").split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const claims: Claim[] = [];
  const plain = evidence.map((e) => ({ ...e, text: e.text.replace(CITE, "") }));
  const support = (needle: (e: EvidenceFact) => boolean) => plain.find(needle) ?? null;
  for (const sentence of sentences) {
    const dateSpans: [number, number][] = [];
    for (const m of sentence.matchAll(DATE_RE)) {
      dateSpans.push([m.index!, m.index! + m[0].length]);
      const d = m[0];
      const ok = /^(?:19|20)\d{2}$/.test(d) ? new RegExp(`\\b${d}\\b`).test(evText) : evNorm.includes(normD(d));
      const ev = ok ? support((e) => normD(e.text).includes(normD(d))) : null;
      claims.push({ kind: "date", text: d, sentence, matched: ok, evidence: ev ? `${ev.source}${ev.date ? ` (${ev.date})` : ""}` : null });
    }
    for (const m of sentence.matchAll(NUM_RE)) {
      if (dateSpans.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
      const v = numVal(m[0]);
      if (v === null) continue;
      const ok = evNums.has(v);
      const ev = ok ? support((e) => [...e.text.matchAll(NUM_RE)].some((x) => numVal(x[0]) === v)) : null;
      claims.push({ kind: "number", text: m[0].trim(), sentence, matched: ok, evidence: ev ? `${ev.source}${ev.date ? ` (${ev.date})` : ""}` : null });
    }
    const companies = new Set<string>();
    for (const m of sentence.matchAll(COMPANY_RE)) companies.add(m[0].trim().replace(/\.$/, ""));
    for (const o of knownOrgs) if (o.trim().length >= 3 && new RegExp(`\\b${escapeRe(o.trim())}\\b`, "i").test(sentence)) companies.add(o.trim());
    for (const c of companies) {
      const ok = evLower.includes(c.toLowerCase());
      const ev = ok ? support((e) => e.text.toLowerCase().includes(c.toLowerCase())) : null;
      claims.push({ kind: "company", text: c, sentence, matched: ok, evidence: ev ? ev.source : null });
    }
    const up = TREND_UP.test(sentence), down = TREND_DOWN.test(sentence), sup = SUPERLATIVE.test(sentence);
    if (up || down || sup) {
      const metrics = METRIC_WORDS.filter((w) => new RegExp(`\\b${escapeRe(w)}`, "i").test(sentence));
      const facts = plain.filter((e) => metrics.length > 0 && metrics.some((w) => new RegExp(`\\b${escapeRe(w)}`, "i").test(e.text)));
      const changes = facts.flatMap((e) => [...e.text.matchAll(/change vs previous comparable period:\s*([+-]?\d+(?:\.\d+)?)/gi)].map((x) => Number(x[1])));
      let ok = facts.length > 0;
      let why = metrics.length === 0 ? "no metric named — cannot be tied to evidence" : facts.length ? "" : `no approved fact about ${metrics.join("/")}`;
      if (ok && (up || down) && !sup) {
        ok = up ? changes.some((c) => c > 0) : changes.some((c) => c < 0);
        if (!ok) why = `evidence does not show a ${up ? "rise" : "fall"}`;
      }
      if (ok && sup) { ok = facts.some((e) => SUPERLATIVE.test(e.text)); if (!ok) why = "superlative not stated by the source"; }
      claims.push({ kind: "claim", text: sentence.length > 140 ? `${sentence.slice(0, 137)}…` : sentence, sentence, matched: ok, evidence: ok ? facts[0].source : why });
    }
  }
  return { claims, unmatched: claims.filter((c) => !c.matched), evidenceCount: evidence.length };
}

// ------------------------------------------------------------------ private-shareable version
/** Redact client names and confidential terms (and licensed facts) for a 1:1 private-shareable version. */
export function privateShareable(body: string, ctx: { clientNames: string[]; confidentialTerms: string[]; licensedFacts?: string[] }): { text: string; redactions: number } {
  let text = body;
  let redactions = 0;
  const swap = (needle: string, repl: string, word: boolean) => {
    if (!needle || needle.trim().length < 2) return;
    const re = new RegExp(word ? `\\b${escapeRe(needle.trim())}\\b` : escapeRe(needle.trim()), "gi");
    text = text.replace(re, () => { redactions++; return repl; });
  };
  for (const n of [...ctx.clientNames].sort((a, b) => b.length - a.length)) swap(n, "[a client]", true);
  for (const t of [...ctx.confidentialTerms].sort((a, b) => b.length - a.length)) swap(t, "[confidential]", false);
  for (const f of ctx.licensedFacts ?? []) if (text.includes(f)) { text = text.split(f).join("[licensed figure — share only under the licence terms]"); redactions++; }
  return { text, redactions };
}

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Deterministic draft (mock + fallback). Mirrors the user's voice crudely: greeting/sign-off style from samples. */
export function templateDraft(idea: { topic: string; audience: Audience; channel: string }, voiceSamples: string[], facts: string[]): string {
  const sample = voiceSamples.find((s) => s.trim().length > 0) ?? "";
  const firstPerson = /\bI\b/.test(sample) || sample.length === 0;
  const opener = firstPerson ? `I keep hearing the same question from ${AUDIENCE_LABEL[idea.audience].toLowerCase()} teams in Pune:` : `A question that keeps coming up with ${AUDIENCE_LABEL[idea.audience].toLowerCase()} teams in Pune:`;
  const factLines = facts.slice(0, 3).map((f) => `• ${f}`);
  const body = [
    `${idea.topic}`,
    "",
    opener,
    "what should we look at before committing to an office move or renewal?",
    "",
    ...(factLines.length ? ["What the data says (sourced):", ...factLines, ""] : []),
    "Three things worth checking early:",
    "1. The notice and lock-in dates, not just the expiry.",
    "2. Total occupancy cost over the same horizon for every option.",
    "3. Who needs to sign off, and how long procurement and legal take.",
    "",
    "Happy to compare notes if this is on your agenda.",
  ];
  return body.join("\n");
}
