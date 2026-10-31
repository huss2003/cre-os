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

export interface PlanIdea { audience: Audience; channel: "linkedin" | "market_note"; topic: string; evidence_hint: string }

/** Deterministic weekly plan: 2 LinkedIn posts + 1 market note, rotating audiences by ISO week. */
export function weeklyPlan(weekStart: string, opts: { hasMarketData: boolean } = { hasMarketData: false }): PlanIdea[] {
  const wk = isoWeek(weekStart);
  const a1 = AUDIENCES[wk % 4];
  const a2 = AUDIENCES[(wk + 2) % 4];
  const out: PlanIdea[] = [
    { audience: a1, channel: "linkedin", topic: ANGLES[a1][wk % 2], evidence_hint: "Use one approved public fact or your own experience; no client names." },
    { audience: a2, channel: "linkedin", topic: ANGLES[a2][(wk + 1) % 2], evidence_hint: "Use one approved public fact or your own experience; no client names." },
  ];
  out.push({ audience: "general", channel: "market_note", topic: opts.hasMarketData ? "Market note from the latest validated release" : "Market note — add a validated market release first", evidence_hint: opts.hasMarketData ? "Facts are computed from gated market observations." : "No gated market observations yet." });
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

/** Brand / confidentiality checklist. Deterministic; the adviser approves and publishes manually. */
export function reviewChecklist(body: string, ctx: { clientNames: string[]; confidentialTerms?: string[]; hasEvidence: boolean; channel: string; brandRules?: string[] }): CheckItem[] {
  const lower = body.toLowerCase();
  const hasFigures = /\d/.test(body.replace(/^\s*\d{1,2}[.)]\s/gm, ""));
  const named = ctx.clientNames.filter((n) => n.trim().length >= 3 && new RegExp(`\\b${escapeRe(n.toLowerCase())}\\b`).test(lower));
  const conf = (ctx.confidentialTerms ?? []).filter((t) => t && lower.includes(t.toLowerCase()));
  const items: CheckItem[] = [
    { key: "no_client_names", label: "No client or prospect names", ok: named.length === 0, detail: named.length ? `Mentions: ${named.slice(0, 5).join(", ")}` : "None found." },
    { key: "no_personal_data", label: "No personal contact details", ok: !EMAIL.test(body) && !PHONE.test(body), detail: EMAIL.test(body) || PHONE.test(body) ? "Email or phone number present." : "None found." },
    { key: "no_deal_prices", label: "No deal-specific prices or quotes", ok: !MONEY.test(body) || ctx.hasEvidence, detail: MONEY.test(body) ? (ctx.hasEvidence ? "Prices present — confirm they come from the cited public source." : "Prices present without a cited public source.") : "None found." },
    { key: "no_forecast_claims", label: "No forecasts or guarantees", ok: !FORECAST.test(body), detail: FORECAST.test(body) ? "Contains forecast/guarantee language." : "None found." },
    { key: "no_confidential_terms", label: "No confidential terms", ok: conf.length === 0, detail: conf.length ? `Contains: ${conf.join(", ")}` : "None found." },
    { key: "cites_evidence", label: "Facts cite an approved source", ok: ctx.hasEvidence || !hasFigures, detail: ctx.hasEvidence ? "Evidence linked." : hasFigures ? "Numbers present without linked evidence." : "No figures used." },
    { key: "length", label: ctx.channel === "linkedin" ? "Within LinkedIn length (≤ 3,000 chars)" : "Reasonable length", ok: ctx.channel !== "linkedin" || body.length <= 3000, detail: `${body.length} characters.` },
  ];
  for (const rule of ctx.brandRules ?? []) items.push({ key: `brand:${rule.slice(0, 30)}`, label: `Brand rule: ${rule}`, ok: false, detail: "Check manually." });
  return items;
}

export function checklistPasses(items: CheckItem[]): boolean {
  return items.filter((i) => !i.key.startsWith("brand:")).every((i) => i.ok);
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
