import { createHash } from "node:crypto";
import type { Candidate, CandidateLists, Extraction, Mention } from "../extract";
import { classifyDates, extractCommercialTerms, TERM_LABEL, type CommercialTerm, type DateClass } from "./commercial";
import { questionable, tieBreakOrg, type BuildingSuggestion, type OrgTieContext } from "./matching";

/**
 * Input Engine analysis (spec §4.4, §5.4, §7, §8, §9, §15). Pure: no database, no AI.
 * Turns an extraction (rule/model output after code rules) + the source text into typed observations with
 * fact class, verification, confidence, source reference and review category; picks only the clarification
 * questions that matter; and writes the plain-language receipt.
 */

// ------------------------------------------------------------------------------------------------ §4.4 intents
export const INTENTS = [
  "new_company_information", "new_contact_information", "contact_update", "property_information", "new_property_requirement",
  "lease_information", "commercial_quotation", "meeting_note", "business_signal", "client_objection", "commercial_commitment",
  "follow_up_task", "personal_working_preference", "hypothesis_or_research", "general_reference",
] as const;
export type Intent = (typeof INTENTS)[number];
export const INTENT_LABEL: Record<Intent, string> = {
  new_company_information: "New company information", new_contact_information: "New contact information", contact_update: "Contact update",
  property_information: "Property information", new_property_requirement: "New property requirement", lease_information: "Lease information",
  commercial_quotation: "Commercial quotation", meeting_note: "Meeting note", business_signal: "Business signal", client_objection: "Client objection",
  commercial_commitment: "Commercial commitment", follow_up_task: "Follow-up task", personal_working_preference: "Personal working preference",
  hypothesis_or_research: "Hypothesis or research observation", general_reference: "General reference information",
};

export type SourceType = "typed_note" | "voice_note" | "image" | "business_card" | "document" | "recording" | "spreadsheet";
export type DocKind = "quotation" | "lease" | "loi" | "meeting_notes" | "business_card" | "property_photo" | "layout" | "spreadsheet" | "audio" | "unknown" | null;

const RE = {
  requirement: /\b(need|needs|needed|require[sd]?|requirement|looking for|searching for|want(?:s)? (?:an? )?(?:office|space)|chahiye|dhoondh)\b/i,
  quotation: /\b(quot(?:e|ed|ation)|offer(?:ed)?|proposal|asking rent|landlord|rate card|counter[- ]?offer)\b/i,
  lease: /\b(lease (?:expir\w*|renew\w*|deed|term)|lock[- ]?in|notice period|escalation|leave and licen[cs]e|expir(?:y|es) (?:in|on))\b/i,
  property: /\b(building|tower|business park|tech park|it park|floor plate|floors?|occupancy certificate|\bOC\b|availability|available|vacant|warm shell|bare shell|fitted)\b/i,
  signal: /\b(expan\w*|hiring|headcount|funding|raised|consolidat\w*|relocat\w*|downsiz\w*|new office|restructur\w*|merger|acqui\w*|layoffs?|growing|grow to)\b/i,
  preference: /\b(prefers?|preferred|likes? to|always wants?|never (?:call|email)|best (?:time|way) to (?:reach|call)|only on whatsapp|no calls)\b/i,
  hypothesis: /\b(might|may be|maybe they|could be|probably|possibly|i think|seems|my guess|hypothesis|perhaps|shayad)\b/i,
  contactUpdate: /\b(moved to|joined|has joined|new role|promoted|now at|left (?:the company|[A-Z])|new number|new email|changed (?:his|her) (?:number|email))\b/i,
  contactInfo: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}|(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/,
  commitment: /\b(agreed|committed|confirmed (?:they|he|she) will|promised|will (?:send|share|revert|confirm|sign))\b/i,
  reply: /\b(replied|got back|responded|reply from|wrote back|revert(?:ed)? (?:back)?)\b/i,
};

export function classifyIntents(text: string, ex: Pick<Extraction, "interaction" | "facts" | "tasks" | "promises" | "objections" | "mentions">, terms: CommercialTerm[], opts: { docKind?: DocKind; sourceType?: SourceType; unresolvedOrgs?: number } = {}): Intent[] {
  const s = new Set<Intent>();
  const dk = opts.docKind ?? null;
  if ((ex.interaction && ex.interaction.channel !== "note") || dk === "meeting_notes" || opts.sourceType === "recording") s.add("meeting_note");
  if (ex.facts.length || RE.requirement.test(text)) s.add("new_property_requirement");
  if (dk === "quotation" || (RE.quotation.test(text) && terms.some((t) => ["rent_psf", "monthly_rent", "cam", "security_deposit"].includes(t.key)))) s.add("commercial_quotation");
  if (dk === "lease" || dk === "loi" || RE.lease.test(text) || terms.some((t) => ["lock_in", "lease_duration", "notice_period", "escalation"].includes(t.key))) s.add("lease_information");
  if (dk === "property_photo" || dk === "layout" || RE.property.test(text) || terms.some((t) => ["carpet_area", "chargeable_area", "super_built_up_area"].includes(t.key))) s.add("property_information");
  if (ex.objections.length) s.add("client_objection");
  if (ex.promises.some((p) => p.who !== "me") || RE.commitment.test(text)) s.add("commercial_commitment");
  if (ex.tasks.length) s.add("follow_up_task");
  if (dk === "business_card" || opts.sourceType === "business_card" || RE.contactInfo.test(text)) s.add("new_contact_information");
  if (RE.contactUpdate.test(text)) s.add("contact_update");
  if ((opts.unresolvedOrgs ?? 0) > 0) s.add("new_company_information");
  if (RE.signal.test(text)) s.add("business_signal");
  if (RE.preference.test(text)) s.add("personal_working_preference");
  if (RE.hypothesis.test(text)) s.add("hypothesis_or_research");
  if (!s.size) s.add("general_reference");
  return INTENTS.filter((i) => s.has(i));
}
export const isReply = (text: string) => RE.reply.test(text);

// ------------------------------------------------------------------------------------------------ §5.4 match confidence
export type MatchTier = "high" | "medium" | "low" | "none";
export interface MatchResult { mention_index: number; kind: Mention["kind"]; text: string; tier: MatchTier; id: string | null; label: string | null; reason: string; candidates: { id: string; label: string; score: number }[] }

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\b(pvt|private|ltd|limited|llp|inc|india|technologies|tech)\b/g, " ").replace(/\s+/g, " ").trim();

/**
 * high   — chosen/confirmed by the user, an exact email/phone hit, or a unique exact full-name (≥2 words) match;
 * medium — one plausible record (single-word name like "Anil", a prefix match, or a strong unique score);
 * low    — several plausible records; none — nothing found. Only "high" may be associated automatically, and only when
 * the workspace allows it (§5.4). Records are never merged here.
 */
export function matchTier(m: Pick<Mention, "kind" | "text">, cands: Candidate[], opts: { confirmedId?: string | null; exactContactHit?: string | null; tie?: OrgTieContext | null } = {}): Omit<MatchResult, "mention_index"> {
  const base = { kind: m.kind, text: m.text, candidates: cands.slice(0, 5).map((c) => ({ id: c.id, label: c.label, score: c.score })) };
  if (opts.confirmedId) { const c = cands.find((x) => x.id === opts.confirmedId); return { ...base, tier: "high", id: opts.confirmedId, label: c?.label ?? null, reason: "confirmed by you" }; }
  if (opts.exactContactHit) { const c = cands.find((x) => x.id === opts.exactContactHit); return { ...base, tier: "high", id: opts.exactContactHit, label: c?.label ?? null, reason: "same email or phone" }; }
  if (!cands.length) return { ...base, tier: "none", id: null, label: null, reason: "no record found" };
  const q = norm(m.text);
  const exact = cands.filter((c) => norm(c.label) === q);
  if (exact.length === 1) {
    const words = q.split(" ").length;
    return words >= 2 || m.kind === "organisation" || m.kind === "geography"
      ? { ...base, tier: "high", id: exact[0].id, label: exact[0].label, reason: "exact name match" }
      : { ...base, tier: "medium", id: exact[0].id, label: exact[0].label, reason: "first name only — confirm" };
  }
  // several same-name companies: parent/subsidiary of a linked company, or HQ city named in the note, breaks the tie (medium — confirm)
  const tie = (pool: Candidate[]) => (m.kind === "organisation" && opts.tie ? tieBreakOrg(pool, opts.tie) : null);
  if (exact.length > 1) {
    const t = tie(exact);
    return t ? { ...base, tier: "medium", id: t.id, label: t.label, reason: `${exact.length} records with this name; likely ${t.label}: ${t.reason}` }
      : { ...base, tier: "low", id: null, label: null, reason: `${exact.length} records with this name` };
  }
  const prefix = cands.filter((c) => norm(c.label).startsWith(`${q} `) || norm(c.label).split(" ").includes(q));
  if (prefix.length === 1) return { ...base, tier: "medium", id: prefix[0].id, label: prefix[0].label, reason: `likely ${prefix[0].label} — confirm` };
  if (prefix.length > 1) {
    const t = tie(prefix);
    return t ? { ...base, tier: "medium", id: t.id, label: t.label, reason: `${prefix.length} possible records; likely ${t.label}: ${t.reason}` }
      : { ...base, tier: "low", id: null, label: null, reason: `${prefix.length} possible records` };
  }
  const sorted = [...cands].sort((a, b) => b.score - a.score);
  if (sorted[0].score >= 0.8 && (sorted.length === 1 || sorted[0].score - sorted[1].score >= 0.2)) return { ...base, tier: "medium", id: sorted[0].id, label: sorted[0].label, reason: "similar spelling — confirm" };
  return { ...base, tier: "low", id: null, label: null, reason: "only weak matches" };
}

export function matchAll(ex: Pick<Extraction, "mentions">, lists: CandidateLists, resolutions: Record<string, string> = {}, contactHits: Record<number, string> = {}, tie: OrgTieContext | null = null): MatchResult[] {
  return ex.mentions.map((m, i) => {
    const cands = lists.find((l) => l.kind === m.kind && l.text.toLowerCase() === m.text.toLowerCase())?.candidates ?? [];
    return { mention_index: i, ...matchTier(m, cands, { confirmedId: resolutions[String(i)] ?? null, exactContactHit: contactHits[i] ?? null, tie }) };
  });
}

// ------------------------------------------------------------------------------------------------ §8 fact classes
export type FactClass = "confirmed" | "estimate" | "assumption" | "hypothesis" | "commitment" | "task" | "preference";
export type Verification = "unverified" | "user_stated" | "page_verified" | "user_confirmed" | "needs_clarification" | "rejected";

/** Code decides the class; an AI reading is never a direct client statement (rule 9) and an estimate never a fact (rule 8). */
export function factClass(i: { kind: "value" | "task" | "commitment" | "preference" | "hypothesis" | "signal" | "objection"; approximate?: boolean; inferred?: boolean; userConfirmed?: boolean; pageVerified?: boolean; sourceType: SourceType; missingCritical?: boolean; aiOnly?: boolean }): FactClass {
  if (i.kind === "task") return "task";
  if (i.kind === "commitment") return "commitment";
  if (i.kind === "preference") return "preference";
  if (i.kind === "hypothesis" || i.kind === "signal") return "hypothesis";
  if (i.userConfirmed) return "confirmed";
  if (i.inferred || i.aiOnly) return "assumption";
  if (i.approximate || i.missingCritical) return "estimate";
  if (i.pageVerified) return "confirmed";
  // a typed note is the user's own statement; transcripts/OCR are machine readings until confirmed
  if (i.sourceType === "typed_note" && i.kind !== "objection") return "confirmed";
  return i.kind === "objection" ? "confirmed" : "estimate";
}
export function verificationFor(sourceType: SourceType, missingCritical: boolean, pageVerified = false): Verification {
  if (missingCritical) return "needs_clarification";
  if (pageVerified) return "page_verified";
  return sourceType === "typed_note" ? "user_stated" : "unverified";
}

// ------------------------------------------------------------------------------------------------ hashes (§6)
export const normaliseSource = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\[\d{2}:\d{2}\]/g, " ").replace(/(?<!\d)\.|\.(?!\d)/g, " ").replace(/[^\p{L}\p{N}₹%.]+/gu, " ").replace(/\s+/g, " ").trim();
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const sourceHash = (text: string) => sha(normaliseSource(text));
export function contentHash(field: string, value: unknown, subject?: string | null) {
  const v = typeof value === "string" ? normaliseSource(value) : JSON.stringify(value ?? null);
  return sha(`${field}|${v}|${subject ?? ""}`);
}

// ------------------------------------------------------------------------------------------------ observations
export type ReviewCategory = "uncertain_company_match" | "uncertain_contact_match" | "potential_duplicate" | "conflicting_commercial_value"
  | "missing_units_or_dates" | "unverified_lease_details" | "material_change_approval";
export const REVIEW_LABEL: Record<ReviewCategory, string> = {
  uncertain_company_match: "Uncertain company matches", uncertain_contact_match: "Uncertain contact matches", potential_duplicate: "Potential duplicate records",
  conflicting_commercial_value: "Conflicting commercial values", missing_units_or_dates: "Missing units or dates", unverified_lease_details: "Unverified lease details",
  material_change_approval: "Material database changes requiring approval",
};

export interface DraftObservation {
  obs_key: string; intent: Intent; fact_class: FactClass; field: string; raw_text: string; value_json: unknown; unit: string | null;
  pricing_basis: string | null; area_basis: string | null; cam_treatment: string | null; date_class: DateClass | null; missing: string[];
  subject_type: string | null; subject_id: string | null; links: { type: string; id: string | null; label: string; confidence: MatchTier }[];
  match_confidence: MatchTier | null; confidence: number | null; source_type: SourceType; source_ref: Record<string, unknown>;
  verification: Verification; review_category: ReviewCategory | null; status: "auto_saved" | "pending_review"; content_hash: string;
  /** material = changes a commercial/requirement value on a record => always via proposeChange + approval */
  material: boolean;
}

const MATERIAL_TERMS = new Set(["rent_psf", "monthly_rent", "annual_rent", "budget", "cam", "security_deposit", "lock_in", "lease_duration", "escalation", "notice_period", "carpet_area", "chargeable_area", "super_built_up_area", "area", "fitout_cost", "rent_free", "brokerage", "parking"]);
const LEASE_TERMS = new Set(["lock_in", "lease_duration", "escalation", "notice_period", "security_deposit", "rent_free"]);

export interface AnalyseInput {
  prefix: string;                         // cap:<id> | doc:<id>
  text: string;
  extraction: Pick<Extraction, "interaction" | "mentions" | "facts" | "tasks" | "promises" | "objections"> | null;
  candidates?: CandidateLists;
  resolutions?: Record<string, string>;
  contactHits?: Record<number, string>;
  sourceType: SourceType;
  docKind?: DocKind;
  locator?: (start: number, end: number) => Record<string, unknown>;
  /** the record the capture is about (resolved requirement/org); observations attach to it */
  subject?: { type: string; id: string } | null;
  pageVerified?: boolean;
  /** company tie-breakers (relations to linked companies, HQ cities) */
  orgTie?: OrgTieContext | null;
}

export interface Clarification { key: string; obs_key: string; question: string; options: { label: string; value: string }[]; material: true }

export interface Analysis {
  intents: Intent[]; terms: CommercialTerm[]; matches: MatchResult[]; observations: DraftObservation[]; clarifications: Clarification[];
}

const fmt = (n: number) => n.toLocaleString("en-IN");

/** Budget/rent with no stated unit/basis => ONE question that covers unit, pricing basis and CAM together. */
export function budgetQuestion(t: CommercialTerm): { question: string; options: { label: string; value: string }[] } {
  const v = t.value != null ? fmt(t.value) : "this";
  const what = t.key === "budget" ? `Budget "${t.raw_text.replace(/^budget\s*(is|:|of)?\s*/i, "")}"` : `"${t.raw_text}"`;
  return {
    question: `${what} — does that mean ₹${v} per sq ft per month? Is CAM extra?`,
    options: [
      { label: `Yes — ₹${v}/sq ft/month, CAM extra`, value: "per_sf_month|cam_extra" },
      { label: `₹${v}/sq ft/month including CAM`, value: "per_sf_month|cam_included" },
      { label: `₹${v}/sq ft/month, CAM not discussed`, value: "per_sf_month|cam_unknown" },
      { label: `₹${v} per seat per month`, value: "per_seat_month|cam_unknown" },
      { label: "Not sure — keep it unknown", value: "unknown" },
    ],
  };
}

export function analyse(input: AnalyseInput): Analysis {
  const { text, prefix, sourceType } = input;
  const ex = input.extraction ?? { interaction: null, mentions: [], facts: [], tasks: [], promises: [], objections: [] };
  const terms = extractCommercialTerms(text);
  const matches = matchAll(ex, input.candidates ?? [], input.resolutions ?? {}, input.contactHits ?? {}, input.orgTie ?? null);
  const unresolvedOrgs = matches.filter((m) => m.kind === "organisation" && m.tier === "none").length;
  const intents = classifyIntents(text, ex, terms, { docKind: input.docKind ?? null, sourceType, unresolvedOrgs });
  const loc: (start: number, end: number) => Record<string, unknown> = input.locator ?? ((start, end) => ({ locator: `text:${start}-${end}`, start, end }));
  const subject = input.subject ?? null;
  const personMatch = matches.find((m) => m.kind === "person");
  const orgMatch = matches.find((m) => m.kind === "organisation");
  const links = matches.filter((m) => m.kind !== "geography").map((m) => ({ type: m.kind, id: m.tier === "high" ? m.id : null, label: m.label ?? m.text, confidence: m.tier }));
  const weakest = (["none", "low", "medium", "high"] as MatchTier[]).find((t) => matches.some((m) => m.kind !== "geography" && m.tier === t)) ?? null;
  const entityCategory = (): ReviewCategory | null => {
    if (orgMatch && orgMatch.tier !== "high") return "uncertain_company_match";
    if (personMatch && personMatch.tier !== "high") return "uncertain_contact_match";
    return null;
  };
  const dates = classifyDates(text, { contractualSource: input.docKind === "lease" || input.docKind === "loi" });
  const obs: DraftObservation[] = [];
  const clar: Clarification[] = [];
  const add = (o: Omit<DraftObservation, "content_hash" | "links" | "match_confidence" | "source_type"> & Partial<Pick<DraftObservation, "links" | "match_confidence">>) =>
    obs.push({ links, match_confidence: weakest, source_type: sourceType, ...o, content_hash: contentHash(o.field, o.value_json ?? o.raw_text, o.subject_id) });

  // ---- commercial terms (raw wording kept; nothing converted)
  terms.forEach((t, n) => {
    const missingCritical = t.missing.includes("unit") || t.missing.includes("pricing_basis");
    const key = `${prefix}:term:${n}`;
    const material = MATERIAL_TERMS.has(t.key);
    const reqLike = t.key === "area" && intents.includes("new_property_requirement") && !intents.includes("commercial_quotation");
    let review: ReviewCategory | null = null;
    if (missingCritical) review = "missing_units_or_dates";
    else if (LEASE_TERMS.has(t.key) && !input.pageVerified) review = "unverified_lease_details";
    else if (!reqLike && t.area_basis === "unknown" && intents.includes("commercial_quotation")) review = "missing_units_or_dates";
    else review = entityCategory();
    const odd = questionable(t);                     // outlier: flagged, lower confidence, never blocked
    add({
      obs_key: key, intent: t.key === "budget" || reqLike ? "new_property_requirement" : LEASE_TERMS.has(t.key) ? "lease_information" : intents.includes("commercial_quotation") ? "commercial_quotation" : t.key.endsWith("area") || t.key === "area" ? "property_information" : "commercial_quotation",
      fact_class: factClass({ kind: "value", approximate: t.approximate, missingCritical, sourceType, pageVerified: input.pageVerified }),
      field: t.key === "area" && reqLike ? "area_target" : t.key, raw_text: t.raw_text, value_json: t.value, unit: t.unit, pricing_basis: t.pricing_basis, area_basis: t.area_basis,
      cam_treatment: t.cam, date_class: null, missing: t.missing, subject_type: subject?.type ?? null, subject_id: subject?.id ?? null,
      confidence: odd ? 0.3 : t.approximate ? 0.6 : missingCritical ? 0.4 : 0.85, source_ref: (() => { const l = loc(t.start, t.end); return { ...l, page: t.page ?? (l.page as number | null | undefined) ?? null, ...(odd ? { questionable: odd } : {}) }; })(), verification: verificationFor(sourceType, missingCritical, input.pageVerified),
      review_category: review, status: review ? "pending_review" : "auto_saved", material,
    });
    if (missingCritical && (t.key === "budget" || t.key === "monthly_rent")) {
      const q = budgetQuestion(t);
      clar.push({ key: `${key}:basis`, obs_key: key, question: q.question, options: q.options, material: true });
    }
  });

  // ---- requirement location / target dates from the extraction facts (dates: informal / estimated / confirmed)
  ex.facts.forEach((f, n) => {
    if (f.field === "preferred_geography") {
      add({ obs_key: `${prefix}:fact:${n}`, intent: "new_property_requirement", fact_class: factClass({ kind: "value", approximate: f.status === "tentative", sourceType }),
        field: "preferred_location", raw_text: f.raw_text, value_json: f.proposed_value, unit: null, pricing_basis: null, area_basis: null, cam_treatment: null, date_class: null, missing: [],
        subject_type: subject?.type ?? null, subject_id: subject?.id ?? null, confidence: f.status === "tentative" ? 0.6 : 0.8, source_ref: loc(f.start, f.end),
        verification: verificationFor(sourceType, false), review_category: entityCategory(), status: entityCategory() ? "pending_review" : "auto_saved", material: true });
    } else if (f.field === "occupation_date" || f.field === "decision_date") {
      const d = dates.find((x) => x.start < f.end && f.start < x.end);
      const cls: DateClass = d?.date_class ?? (f.proposed_value ? "estimated" : "informal");
      const month = /([A-Za-z]+)/.exec(f.raw_text.replace(/^(by|before|from|in|decision (by|in))\s+/i, ""))?.[1] ?? null;
      add({ obs_key: `${prefix}:fact:${n}`, intent: "new_property_requirement", fact_class: cls === "confirmed" ? "confirmed" : "estimate",
        field: f.field === "occupation_date" ? "occupation_target" : "decision_target", raw_text: f.raw_text,
        value_json: f.proposed_value ?? (month ? { month, year: null } : null), unit: "date", pricing_basis: null, area_basis: null, cam_treatment: null, date_class: cls,
        missing: f.proposed_value ? [] : ["year"], subject_type: subject?.type ?? null, subject_id: subject?.id ?? null, confidence: cls === "informal" ? 0.5 : 0.7,
        source_ref: loc(f.start, f.end), verification: verificationFor(sourceType, false), review_category: entityCategory(), status: entityCategory() ? "pending_review" : "auto_saved", material: false });
    } else if (!terms.some((t) => t.start < f.end && f.start < t.end) && f.proposed_value != null) {
      // a requirement number the commercial reader did not see (e.g. "20k seats")
      add({ obs_key: `${prefix}:fact:${n}`, intent: "new_property_requirement", fact_class: factClass({ kind: "value", approximate: f.status === "tentative", sourceType }),
        field: f.field, raw_text: f.raw_text, value_json: f.proposed_value, unit: f.unit, pricing_basis: null, area_basis: f.field === "area_target_sf" ? "unknown" : null, cam_treatment: null,
        date_class: null, missing: f.unit ? [] : ["unit"], subject_type: subject?.type ?? null, subject_id: subject?.id ?? null, confidence: 0.6, source_ref: loc(f.start, f.end),
        verification: verificationFor(sourceType, !f.unit), review_category: f.unit ? entityCategory() : "missing_units_or_dates", status: "pending_review", material: true });
    }
  });

  // ---- tasks (informal weekday => next occurrence, editable), commitments, objections, preferences, hypotheses, signals
  ex.tasks.forEach((t, n) => add({ obs_key: `${prefix}:task:${n}`, intent: "follow_up_task", fact_class: "task", field: "task", raw_text: text.slice(t.start, t.end) || t.description,
    value_json: { description: t.description, due: t.due_date }, unit: null, pricing_basis: null, area_basis: null, cam_treatment: null,
    date_class: t.due_date ? "informal" : null, missing: t.due_date ? [] : ["due_date"], subject_type: null, subject_id: null, confidence: 0.8, source_ref: loc(t.start, t.end),
    verification: verificationFor(sourceType, false), review_category: null, status: "auto_saved", material: false }));
  ex.promises.forEach((p, n) => { if (p.who === "me") return; add({ obs_key: `${prefix}:commitment:${n}`, intent: "commercial_commitment", fact_class: "commitment", field: "commitment",
    raw_text: text.slice(p.start, p.end) || p.what, value_json: { who: p.who, what: p.what, due: p.due }, unit: null, pricing_basis: null, area_basis: null, cam_treatment: null,
    date_class: p.due ? "informal" : null, missing: p.due ? [] : ["due_date"], subject_type: null, subject_id: null, confidence: 0.7, source_ref: loc(p.start, p.end),
    verification: verificationFor(sourceType, false), review_category: null, status: "auto_saved", material: false }); });
  ex.objections.forEach((o, n) => add({ obs_key: `${prefix}:objection:${n}`, intent: "client_objection", fact_class: factClass({ kind: "objection", sourceType }), field: "objection", raw_text: o.text,
    value_json: o.text, unit: null, pricing_basis: null, area_basis: null, cam_treatment: null, date_class: null, missing: [], subject_type: null, subject_id: null, confidence: 0.7,
    source_ref: loc(o.start, o.end), verification: verificationFor(sourceType, false), review_category: null, status: "auto_saved", material: false }));
  const sentences = [...text.matchAll(/[^.!?\n]+[.!?]?/g)].map((m) => ({ s: m[0].trim(), start: m.index! + (m[0].length - m[0].trimStart().length) }));
  sentences.forEach(({ s, start }, n) => {
    const end = start + s.length;
    if (RE.preference.test(s)) add({ obs_key: `${prefix}:preference:${n}`, intent: "personal_working_preference", fact_class: "preference", field: "preference", raw_text: s, value_json: s,
      unit: null, pricing_basis: null, area_basis: null, cam_treatment: null, date_class: null, missing: [], subject_type: null, subject_id: null, confidence: 0.6, source_ref: loc(start, end),
      verification: verificationFor(sourceType, false), review_category: null, status: "auto_saved", material: false });
    if (RE.signal.test(s)) add({ obs_key: `${prefix}:signal:${n}`, intent: "business_signal", fact_class: "hypothesis", field: "signal", raw_text: s, value_json: s,
      unit: null, pricing_basis: null, area_basis: null, cam_treatment: null, date_class: null, missing: [], subject_type: null, subject_id: null, confidence: 0.5, source_ref: loc(start, end),
      verification: "unverified", review_category: null, status: "auto_saved", material: false });
    else if (RE.hypothesis.test(s) && !RE.requirement.test(s)) add({ obs_key: `${prefix}:hypothesis:${n}`, intent: "hypothesis_or_research", fact_class: "hypothesis", field: "hypothesis",
      raw_text: s, value_json: s, unit: null, pricing_basis: null, area_basis: null, cam_treatment: null, date_class: null, missing: [], subject_type: null, subject_id: null, confidence: 0.4,
      source_ref: loc(start, end), verification: "unverified", review_category: null, status: "auto_saved", material: false });
  });
  return { intents, terms, matches, observations: obs, clarifications: clar };
}

// ------------------------------------------------------------------------------------------------ §9 / rule 14 permissions
export interface InputPermissions {
  /** save internal observations (notes, objections, preferences, hypotheses) without asking */
  auto_save_internal_observations: boolean;
  /** create follow-up tasks right away (informal weekday => next occurrence in the workspace time zone) */
  auto_create_tasks: boolean;
  /** associate a capture with a HIGH-confidence match without asking (never merges records) */
  auto_associate_high_confidence: boolean;
}
export const DEFAULT_PERMISSIONS: InputPermissions = { auto_save_internal_observations: true, auto_create_tasks: true, auto_associate_high_confidence: false };
export const PERMISSIONS_SETTING = "input_engine.permissions";
export function parsePermissions(v: unknown): InputPermissions {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const b = (k: keyof InputPermissions) => (typeof o[k] === "boolean" ? (o[k] as boolean) : DEFAULT_PERMISSIONS[k]);
  return { auto_save_internal_observations: b("auto_save_internal_observations"), auto_create_tasks: b("auto_create_tasks"), auto_associate_high_confidence: b("auto_associate_high_confidence") };
}
/** Final status: material values and uncertain matches always wait for review; internal items only auto-save when permitted. */
export function applyPermissions(o: DraftObservation, p: InputPermissions): DraftObservation {
  if (o.material || o.review_category) return { ...o, status: "pending_review" };
  if (o.fact_class === "task") return { ...o, status: p.auto_create_tasks ? "auto_saved" : "pending_review" };
  return { ...o, status: p.auto_save_internal_observations ? "auto_saved" : "pending_review" };
}

// ------------------------------------------------------------------------------------------------ §15 rule 15 receipt
export interface ReceiptInput {
  sourceLabel: string;                                   // "Note" | "Voice note" | "Business card" | file name
  duplicateOf?: string | null;                           // same file/content already captured
  matches: MatchResult[];
  requirementProposed?: { status: "proposed" | "awaiting_match" | "none"; summary: string } | null;
  questions: Clarification[];
  tasks: { title: string; due: string | null; created: boolean }[];
  conflicts: { field: string; before: string; after: string }[];
  repeats: number;
  saved: number;
  failed?: string | null;
  buildings?: BuildingSuggestion[];
  questionable?: { raw_text: string; reason: string }[];
}
export interface Receipt { lines: { kind: "saved" | "matched" | "proposed" | "questioned" | "scheduled" | "changed" | "duplicate" | "failed"; text: string }[] }

export function buildReceipt(r: ReceiptInput): Receipt {
  const lines: Receipt["lines"] = [];
  if (r.duplicateOf) lines.push({ kind: "duplicate", text: `${r.sourceLabel} was already captured — nothing new was created.` });
  lines.push({ kind: "saved", text: `${r.sourceLabel} saved${r.saved ? ` (${r.saved} item${r.saved === 1 ? "" : "s"} understood)` : ""}.` });
  if (r.failed) lines.push({ kind: "failed", text: `Processing problem: ${r.failed}. The original is kept; you can retry.` });
  for (const m of r.matches.filter((x) => x.kind !== "geography")) {
    const who = m.kind === "person" ? "Contact" : "Company";
    lines.push({ kind: "matched", text: m.tier === "high" ? `${who} ${m.text} matched to ${m.label ?? m.text}.`
      : m.tier === "none" ? `${who} ${m.text}: no existing record — awaiting your confirmation (create or pick one).`
      : `${who} ${m.text}: ${m.tier}-confidence match${m.label ? ` (${m.label})` : ""} — awaiting your confirmation.` });
  }
  for (const b of r.buildings ?? []) lines.push({ kind: "matched", text: `Building "${b.text}": possibly ${b.label} (${b.tier} confidence, ${b.reason}) — suggestion only, not linked.` });
  for (const q of r.questionable ?? []) lines.push({ kind: "questioned", text: `Questionable value "${q.raw_text}": ${q.reason}. Saved and flagged, nothing blocked.` });
  if (r.requirementProposed && r.requirementProposed.status !== "none") {
    lines.push({ kind: "proposed", text: r.requirementProposed.status === "proposed" ? `Requirement proposed: ${r.requirementProposed.summary}.` : `Requirement noted: ${r.requirementProposed.summary} — will be proposed once the company is confirmed.` });
  }
  for (const q of r.questions) lines.push({ kind: "questioned", text: `Clarification pending: ${q.question}` });
  for (const c of r.conflicts) lines.push({ kind: "changed", text: `${c.field} differs from the saved value (${c.before} → ${c.after}). Previous value kept; the change is waiting for review.` });
  if (r.repeats) lines.push({ kind: "duplicate", text: `${r.repeats} item${r.repeats === 1 ? " repeats" : "s repeat"} the same source — not counted as new evidence.` });
  for (const t of r.tasks) lines.push({ kind: "scheduled", text: t.created ? `Task "${t.title}" created${t.due ? `, due ${t.due}` : ""}.` : `Task "${t.title}" awaiting confirmation${t.due ? ` (due ${t.due})` : ""}.` });
  return { lines };
}

export const termSummary = (t: CommercialTerm) => `${TERM_LABEL[t.key]}: ${t.raw_text}${t.missing.length ? ` (${t.missing.join(", ")} unknown)` : ""}`;
