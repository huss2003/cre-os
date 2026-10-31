/**
 * Prospect researcher — pure dossier construction (spec Part I §8 "Company dossier" contract).
 * Every claim carries observed/publication dates, an expiry and an evidence tier. Unknown fields stay unknown.
 * Hiring roles are NOT an office-size commitment. No seat/area numbers are derived from hiring here.
 */
import {
  type EvidenceTier, type FactStatus, type ResearchTier, EVIDENCE_TIER_RANK, TIER_POLICY,
  expiryFor, isExpired, isoDate, addDays,
} from "../common";

export interface ClaimSource { kind: "signal_claim" | "organisation" | "organisation_relation" | "employment" | "lease" | "lease_event" | "market_transaction" | "interaction" | "stakeholder" | "relationship_edge" | "rule"; id?: string | null; url?: string | null; locator?: string | null }

export interface DossierClaim {
  text: string;
  value?: unknown;
  status: FactStatus;
  evidence_tier: EvidenceTier;
  source: ClaimSource;
  observed_on: string | null;
  published_on: string | null;
  expires_on: string | null;
  expired: boolean;
}

export type SectionKey =
  | "identity" | "footprint" | "sites_leases" | "decision_committee" | "contacts_current" | "contacts_former" | "intro_paths"
  | "headcount" | "hiring" | "funding" | "rto_gcc" | "prior_transactions" | "last_interaction" | "open_objections"
  | "timing_hypothesis" | "next_best_question" | "sources";

export interface DossierSection { key: SectionKey; title: string; status: "known" | "partial" | "unknown"; claims: DossierClaim[]; note?: string }

export const SECTION_TITLES: Record<SectionKey, string> = {
  identity: "Legal / group identity",
  footprint: "Pune / India footprint",
  sites_leases: "Sites and lease events",
  decision_committee: "Likely decision committee",
  contacts_current: "Current relevant contacts",
  contacts_former: "Former relevant contacts",
  intro_paths: "Introduction paths",
  headcount: "Headcount ranges",
  hiring: "Hiring by function / location",
  funding: "Financial / funding signals",
  rto_gcc: "RTO / consolidation / GCC signals",
  prior_transactions: "Prior transactions",
  last_interaction: "Last interaction",
  open_objections: "Open objections",
  timing_hypothesis: "Timing hypothesis",
  next_best_question: "Next best question",
  sources: "Sources",
};

export const HIRING_NOTE = "Hiring roles are a demand signal, not an office-size commitment. No seat or area estimate is derived from job postings.";

// ------------------------------------------------------------------ inputs
export interface OrgRow {
  id: string; display_name: string; legal_name: string | null; cin: string | null; gstin: string | null; domain: string | null;
  sector: string | null; hq_country: string | null; headcount_min: number | null; headcount_max: number | null; is_gcc: boolean | null;
  updated_at: string; row_version: number;
}
export interface ClaimRow {
  id: string; claim_type: string; predicate: string | null; value_json: Record<string, unknown> | null; status: FactStatus;
  evidence_tier: EvidenceTier | null; evidence_excerpt: string | null; source_url: string | null; source_locator: string | null;
  published_on: string | null; observed_on: string | null; effective_on: string | null; expires_on: string | null;
  created_at: string; row_version: number;
}
export interface RelationRow { id: string; relation_type: string; other_name: string; direction: "from" | "to"; valid_from: string | null; valid_to: string | null; updated_at: string; row_version: number }
export interface EmploymentRow {
  id: string; person_id: string; person_name: string; title: string | null; function: string | null; seniority: string | null;
  start_date: string | null; end_date: string | null; is_current: boolean; fact_status: FactStatus; updated_at: string; row_version: number;
}
export interface LeaseRow {
  id: string; asset_name: string | null; locality: string | null; area_sf: number | null; area_basis: string | null;
  contractual_expiry: string | null; status: string; fact_status: FactStatus; landlord: string | null; updated_at: string; row_version: number;
  events: { id: string; event_type: string; event_date: string | null; date_basis: string; confirmed: boolean; row_version: number }[];
}
export interface TransactionRow {
  id: string; asset_name: string | null; deal_type: string | null; period_start: string | null; period_precision: string;
  area_sf: number | null; rent_min: number | null; rent_max: number | null; rent_basis: string | null; source_object_id: string | null;
  updated_at: string; row_version: number;
}
export interface InteractionRow {
  id: string; occurred_at: string; channel: string; direction: string | null; subject: string | null;
  objections: unknown; is_meaningful: boolean; row_version: number;
}
export interface StakeholderRow { id: string; person_name: string; role: string; requirement_title: string; row_version: number }
export interface IntroPathSummary { target_person_id: string; target_name: string; hops: string[]; warmth: string | null; needs_permission: boolean; last_contact: string | null }

export interface DossierInputs {
  org: OrgRow;
  relations: RelationRow[];
  claims: ClaimRow[];
  employments: EmploymentRow[];
  leases: LeaseRow[];
  transactions: TransactionRow[];
  interactions: InteractionRow[];      // MUST already be confidentiality-filtered (see selectDossierInteractions)
  stakeholders: StakeholderRow[];
  introPaths: IntroPathSummary[];
}

// ------------------------------------------------------------------ confidentiality filter
export interface InteractionWithLinks { id: string; occurred_at: string; links: { entity_type: string; entity_id: string }[] }

/**
 * Person-move confidentiality (spec: "Do not copy old-company confidential deal notes into a new-company dossier").
 * Include an interaction only when it is explicitly linked to this organisation or one of its opportunities, or when it is
 * linked only to people AND occurred while that person was employed here (known start date). Anything tied to another
 * organisation/opportunity, or predating the person's employment here, is excluded.
 */
export function selectDossierInteractions(
  interactions: InteractionWithLinks[],
  orgId: string,
  orgOpportunityIds: Set<string>,
  employmentHere: Map<string, { start_date: string | null; end_date: string | null }>,
): Set<string> {
  const keep = new Set<string>();
  for (const it of interactions) {
    const linkedHere = it.links.some((l) => (l.entity_type === "organisation" && l.entity_id === orgId) || (l.entity_type === "opportunity" && orgOpportunityIds.has(l.entity_id)));
    if (linkedHere) { keep.add(it.id); continue; }
    const linkedElsewhere = it.links.some((l) => (l.entity_type === "organisation" && l.entity_id !== orgId) || (l.entity_type === "opportunity" && !orgOpportunityIds.has(l.entity_id)) || l.entity_type === "requirement");
    if (linkedElsewhere) continue;
    const day = it.occurred_at.slice(0, 10);
    const people = it.links.filter((l) => l.entity_type === "person");
    if (people.length === 0) continue;
    const allDuringEmployment = people.every((p) => {
      const e = employmentHere.get(p.entity_id);
      if (!e || !e.start_date) return false;     // unknown start => conservative exclude
      return day >= e.start_date && (!e.end_date || day <= e.end_date);
    });
    if (allDuringEmployment) keep.add(it.id);
  }
  return keep;
}

// ------------------------------------------------------------------ fingerprint & refresh policy
export function evidenceKeys(i: DossierInputs, tier: ResearchTier): string[] {
  const keys = [`org:${i.org.id}:${i.org.row_version}`, `tier:${tier}`];
  for (const r of i.relations) keys.push(`rel:${r.id}:${r.row_version}`);
  for (const c of i.claims) keys.push(`claim:${c.id}:${c.row_version}`);
  for (const e of i.employments) keys.push(`emp:${e.id}:${e.row_version}`);
  for (const l of i.leases) { keys.push(`lease:${l.id}:${l.row_version}`); for (const ev of l.events) keys.push(`le:${ev.id}:${ev.row_version}`); }
  for (const t of i.transactions) keys.push(`tx:${t.id}:${t.row_version}`);
  for (const it of i.interactions) keys.push(`int:${it.id}:${it.row_version}`);
  for (const s of i.stakeholders) keys.push(`sh:${s.id}:${s.row_version}`);
  for (const p of i.introPaths) keys.push(`path:${p.target_person_id}:${p.hops.join(">")}:${p.warmth ?? ""}:${p.needs_permission}`);
  return keys.sort();
}

export type RefreshDecision = { run: boolean; reason: "first_run" | "evidence_changed" | "interval_elapsed" | "forced" | "unchanged" };

/** Re-run only when evidence changed or the tier interval elapsed (spec §9 research tiers). */
export function shouldRegenerate(prev: { evidence_fingerprint: string; next_refresh_at: string } | null, fingerprint: string, now: Date, force = false): RefreshDecision {
  if (force) return { run: true, reason: "forced" };
  if (!prev) return { run: true, reason: "first_run" };
  if (prev.evidence_fingerprint !== fingerprint) return { run: true, reason: "evidence_changed" };
  if (now.getTime() >= new Date(prev.next_refresh_at).getTime()) return { run: true, reason: "interval_elapsed" };
  return { run: false, reason: "unchanged" };
}

export function nextRefreshAt(tier: ResearchTier, now: Date, cadenceDays?: number): Date {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + (cadenceDays ?? TIER_POLICY[tier].cadenceDays));
  return d;
}

// ------------------------------------------------------------------ section builder
function mk(today: string, text: string, opts: Partial<DossierClaim> & { source: ClaimSource; claimType?: string; observed?: string | null }): DossierClaim {
  const observed = opts.observed_on ?? opts.observed ?? null;
  const expires = opts.expires_on ?? expiryFor(opts.claimType ?? "default", observed);
  return {
    text,
    value: opts.value,
    status: opts.status ?? "reported",
    evidence_tier: opts.evidence_tier ?? "single_unverified",
    source: opts.source,
    observed_on: observed,
    published_on: opts.published_on ?? null,
    expires_on: expires,
    expired: isExpired(expires, today),
  };
}

function claimFromSignal(c: ClaimRow, today: string, text?: string): DossierClaim {
  const observed = c.observed_on ?? isoDate(c.created_at);
  return mk(today, text ?? describeSignal(c), {
    value: c.value_json ?? undefined,
    status: c.status,
    evidence_tier: c.evidence_tier ?? "single_unverified",
    source: { kind: "signal_claim", id: c.id, url: c.source_url, locator: c.source_locator },
    observed_on: observed,
    published_on: c.published_on,
    expires_on: expiryFor(c.claim_type, observed, c.expires_on),
  });
}

export function describeSignal(c: ClaimRow): string {
  const v = c.value_json ?? {};
  const parts: string[] = [];
  if (c.predicate) parts.push(c.predicate);
  const summary = typeof v.summary === "string" ? v.summary : null;
  if (summary) parts.push(summary);
  for (const k of ["function", "location", "open_roles", "amount", "currency", "round", "plan", "headcount_min", "headcount_max"]) {
    if (v[k] !== undefined && v[k] !== null && v[k] !== "") parts.push(`${k.replace(/_/g, " ")}: ${String(v[k])}`);
  }
  if (parts.length === 0 && c.evidence_excerpt) parts.push(`“${c.evidence_excerpt.slice(0, 200)}”`);
  return `${c.claim_type.replace(/_/g, " ")} — ${parts.join("; ") || "details not recorded"}`;
}

function section(key: SectionKey, claims: DossierClaim[], note?: string): DossierSection {
  const live = claims.filter((c) => !c.expired);
  const status: DossierSection["status"] = claims.length === 0 ? "unknown" : live.length === claims.length ? "known" : "partial";
  return { key, title: SECTION_TITLES[key], status, claims, note: note ?? (claims.length === 0 ? "Unknown — no evidence on file." : undefined) };
}

const DECISION_FUNCTIONS = /real estate|workplace|facilit|admin|finance|cfo|procure|legal|hr|people|operations|coo|ceo|country head|site lead|managing director/i;
const SENIOR = /cxo|c-level|chief|vp|vice president|director|head|lead|managing|partner|gm|general manager/i;

const CLAIM_GROUPS: Record<string, SectionKey> = {
  identity: "identity", group: "identity", parent: "identity",
  footprint: "footprint", office_location: "footprint", site: "footprint",
  headcount: "headcount",
  hiring: "hiring",
  funding: "funding", financial: "funding", results: "funding",
  rto: "rto_gcc", consolidation: "rto_gcc", gcc_plan: "rto_gcc", expansion: "rto_gcc", relocation: "rto_gcc",
};

export interface BuiltDossier { sections: DossierSection[]; expiredCount: number; evidenceCount: number }

export function buildDossierSections(i: DossierInputs, today: string): BuiltDossier {
  const byKey = new Map<SectionKey, DossierClaim[]>();
  const push = (k: SectionKey, c: DossierClaim) => byKey.set(k, [...(byKey.get(k) ?? []), c]);
  const orgObserved = isoDate(i.org.updated_at);

  // identity
  const idParts: [string, string | null][] = [["Legal name", i.org.legal_name], ["CIN", i.org.cin], ["GSTIN", i.org.gstin], ["Domain", i.org.domain], ["Sector", i.org.sector], ["HQ country", i.org.hq_country]];
  for (const [label, v] of idParts) {
    if (v) push("identity", mk(today, `${label}: ${v}`, { source: { kind: "organisation", id: i.org.id, locator: label }, observed: orgObserved, claimType: "identity", evidence_tier: "credible_reported", status: "reported" }));
  }
  for (const r of i.relations) {
    const txt = r.direction === "from" ? `${i.org.display_name} ${r.relation_type.replace(/_/g, " ")} ${r.other_name}` : `${r.other_name} ${r.relation_type.replace(/_/g, " ")} ${i.org.display_name}`;
    push("identity", mk(today, txt, { source: { kind: "organisation_relation", id: r.id }, observed: isoDate(r.updated_at), claimType: "identity", evidence_tier: "credible_reported" }));
  }
  if (i.org.is_gcc === true) push("rto_gcc", mk(today, "Recorded as a Global Capability Centre (GCC)", { source: { kind: "organisation", id: i.org.id, locator: "is_gcc" }, observed: orgObserved, claimType: "gcc_plan" }));

  // headcount (ranges only, never a point estimate)
  if (i.org.headcount_min !== null || i.org.headcount_max !== null) {
    const range = `${i.org.headcount_min ?? "?"}–${i.org.headcount_max ?? "?"}`;
    push("headcount", mk(today, `Headcount range ${range} (as recorded)`, { value: { min: i.org.headcount_min, max: i.org.headcount_max }, source: { kind: "organisation", id: i.org.id, locator: "headcount" }, observed: orgObserved, claimType: "headcount" }));
  }

  // signals
  for (const c of i.claims) {
    const key = CLAIM_GROUPS[c.claim_type];
    if (key) push(key, claimFromSignal(c, today));
  }

  // sites & leases (footprint too)
  for (const l of i.leases) {
    const where = [l.asset_name, l.locality].filter(Boolean).join(", ") || "Unnamed premises";
    const area = l.area_sf !== null ? `${l.area_sf} sf${l.area_basis ? ` (${l.area_basis})` : ""}` : "area unknown";
    const obs = isoDate(l.updated_at);
    push("footprint", mk(today, `${where} — ${area}`, { source: { kind: "lease", id: l.id }, observed: obs, claimType: "footprint", status: l.fact_status, evidence_tier: "documentary_current" }));
    const evText = l.events.filter((e) => e.event_date).map((e) => `${e.event_type.replace(/_/g, " ")} ${e.event_date} (${e.date_basis}${e.confirmed ? ", confirmed" : ", unconfirmed"})`);
    push("sites_leases", mk(today, `${where}: ${evText.length ? evText.join("; ") : "no dated events on file"}${l.landlord ? ` — landlord ${l.landlord}` : ""}`, {
      value: { contractual_expiry: l.contractual_expiry, events: l.events }, source: { kind: "lease", id: l.id }, observed: obs, claimType: "lease", status: l.fact_status, evidence_tier: "documentary_current",
    }));
  }

  // contacts: names/titles/dates ONLY (no notes from other organisations)
  for (const e of i.employments) {
    const title = [e.title, e.function].filter(Boolean).join(", ") || "role unknown";
    const dates = `${e.start_date ?? "start unknown"} → ${e.is_current ? "present" : e.end_date ?? "end unknown"}`;
    const c = mk(today, `${e.person_name} — ${title} (${dates})`, { source: { kind: "employment", id: e.id }, observed: isoDate(e.updated_at), claimType: "employment", status: e.fact_status, evidence_tier: e.fact_status === "currently_confirmed" ? "documentary_current" : "single_unverified" });
    push(e.is_current ? "contacts_current" : "contacts_former", c);
    if (e.is_current && (DECISION_FUNCTIONS.test(title) || SENIOR.test(`${e.seniority ?? ""} ${title}`))) {
      push("decision_committee", mk(today, `${e.person_name} — possible role in decision (${title}); role hypothesis, verify`, { source: { kind: "employment", id: e.id }, observed: isoDate(e.updated_at), claimType: "employment", status: "ai_inference", evidence_tier: "inference" }));
    }
  }
  for (const s of i.stakeholders) {
    push("decision_committee", mk(today, `${s.person_name} — ${s.role} on “${s.requirement_title}”`, { source: { kind: "stakeholder", id: s.id }, observed: today, claimType: "contact", status: "reported", evidence_tier: "credible_reported" }));
  }

  for (const p of i.introPaths) {
    push("intro_paths", mk(today, `${p.hops.join(" → ")}${p.warmth ? ` (${p.warmth})` : ""}${p.needs_permission ? " — intro permission not recorded; ask first" : ""}`, {
      source: { kind: "relationship_edge", locator: p.target_person_id }, observed: p.last_contact ?? today, claimType: "contact", status: "reported", evidence_tier: p.needs_permission ? "single_unverified" : "credible_reported",
    }));
  }

  for (const t of i.transactions) {
    const rent = t.rent_min !== null || t.rent_max !== null ? `rent ${t.rent_min ?? "?"}${t.rent_max !== null && t.rent_max !== t.rent_min ? `–${t.rent_max}` : ""}${t.rent_basis ? ` (${t.rent_basis})` : ""}` : "rent unknown";
    push("prior_transactions", mk(today, `${t.period_start ? `${t.period_start.slice(0, 7)} (${t.period_precision})` : "date unknown"} — ${t.deal_type ?? "deal"} at ${t.asset_name ?? "unknown building"}, ${t.area_sf ?? "?"} sf, ${rent}`, {
      source: { kind: "market_transaction", id: t.id }, observed: t.period_start, claimType: "transaction", status: "historical_observed", evidence_tier: t.source_object_id ? "documentary_current" : "credible_reported",
    }));
  }

  const ints = [...i.interactions].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  if (ints[0]) {
    const it = ints[0];
    push("last_interaction", mk(today, `${it.occurred_at.slice(0, 10)} — ${it.channel}${it.direction ? ` (${it.direction})` : ""}${it.subject ? `: ${it.subject}` : ""}`, { source: { kind: "interaction", id: it.id }, observed: it.occurred_at.slice(0, 10), claimType: "interaction", status: "historical_observed", evidence_tier: "documentary_current" }));
  }
  for (const it of ints) {
    for (const o of objectionTexts(it.objections)) {
      push("open_objections", mk(today, o, { source: { kind: "interaction", id: it.id }, observed: it.occurred_at.slice(0, 10), claimType: "objection", status: "reported", evidence_tier: "credible_reported" }));
    }
  }

  const sections: DossierSection[] = [];
  const order: SectionKey[] = ["identity", "footprint", "sites_leases", "decision_committee", "contacts_current", "contacts_former", "intro_paths", "headcount", "hiring", "funding", "rto_gcc", "prior_transactions", "last_interaction", "open_objections"];
  for (const k of order) sections.push(section(k, byKey.get(k) ?? [], k === "hiring" ? HIRING_NOTE : undefined));
  // keep the hiring note even when unknown
  const hiring = sections.find((s) => s.key === "hiring")!;
  if (hiring.claims.length === 0) hiring.note = `Unknown — no evidence on file. ${HIRING_NOTE}`;

  const all = sections.flatMap((s) => s.claims);
  return { sections, expiredCount: all.filter((c) => c.expired).length, evidenceCount: all.length };
}

export function objectionTexts(o: unknown): string[] {
  if (!Array.isArray(o)) return [];
  return o.map((x) => (typeof x === "string" ? x : x && typeof x === "object" && "text" in x ? String((x as { text: unknown }).text) : null)).filter((x): x is string => !!x && x.trim().length > 0);
}

// ------------------------------------------------------------------ deterministic synthesis (also the mock + budget fallback)
export interface Synthesis { timing_hypothesis: string | null; timing_basis: string | null; next_best_question: string; falsification_questions: string[] }

export function ruleSynthesis(i: DossierInputs, built: BuiltDossier, today: string): Synthesis {
  const events = i.leases.flatMap((l) => l.events.filter((e) => e.event_date && e.event_date >= today).map((e) => ({ ...e, where: l.asset_name ?? "premises" })))
    .sort((a, b) => (a.event_date! < b.event_date! ? -1 : 1));
  const next = events[0];
  const signals = i.claims.filter((c) => ["expansion", "rto", "consolidation", "gcc_plan", "relocation", "hiring"].includes(c.claim_type) && !isExpired(expiryFor(c.claim_type, c.observed_on ?? isoDate(c.created_at), c.expires_on), today));
  let timing: string | null = null;
  let basis: string | null = null;
  if (next) {
    timing = `Possible decision window ahead of the ${next.event_type.replace(/_/g, " ")} on ${next.event_date} at ${next.where} (${next.date_basis}${next.confirmed ? ", confirmed" : ", unconfirmed"}). Hypothesis — not a confirmed requirement.`;
    basis = `lease_event:${next.id}`;
  } else if (signals.length > 0) {
    timing = `Unconfirmed: ${signals.length} live business signal(s) (${[...new Set(signals.map((s) => s.claim_type))].join(", ")}) but no dated lease event. Timing unknown until confirmed.`;
    basis = signals.map((s) => `signal_claim:${s.id}`).join(",");
  }
  const unknownKeys = built.sections.filter((s) => s.status === "unknown").map((s) => s.key);
  let q = "What would need to be true for an office decision in the next 12 months, and who would sign it off?";
  if (unknownKeys.includes("sites_leases")) q = "Where does the team sit in Pune today, and when does the current lease or notice window fall?";
  else if (unknownKeys.includes("decision_committee")) q = "Who besides you would be involved in an office decision — finance, procurement, legal?";
  else if (next) q = `Is the ${next.event_type.replace(/_/g, " ")} on ${next.event_date} being planned for yet — renew, relocate or consolidate?`;
  const falsify = [
    "Has headcount in Pune been flat or shrinking over the last two quarters (would weaken an expansion hypothesis)?",
    "Has the company recently renewed or signed a long lock-in at its current premises?",
    "Is hiring concentrated outside Pune or in remote roles (hiring ≠ office demand)?",
    "Is there a parent-level real-estate freeze or consolidation programme?",
  ];
  if (next && !next.confirmed) falsify.unshift(`Is the ${next.event_type.replace(/_/g, " ")} date (${next.event_date}) still valid, or was the lease amended/renewed?`);
  return { timing_hypothesis: timing, timing_basis: basis, next_best_question: q, falsification_questions: falsify.slice(0, 5) };
}

export function synthesisSections(s: Synthesis, today: string, aiLabel: string): DossierSection[] {
  const timingClaims: DossierClaim[] = s.timing_hypothesis
    ? [{ text: s.timing_hypothesis, status: "ai_inference", evidence_tier: "inference", source: { kind: "rule", locator: s.timing_basis ?? aiLabel }, observed_on: today, published_on: null, expires_on: addDays(today, 30), expired: false }]
    : [];
  return [
    { key: "timing_hypothesis", title: SECTION_TITLES.timing_hypothesis, status: timingClaims.length ? "known" : "unknown", claims: timingClaims, note: timingClaims.length ? "Hypothesis only — verify with the client before any material update." : "Unknown — no dated lease event or live signal on file." },
    { key: "next_best_question", title: SECTION_TITLES.next_best_question, status: "known", claims: [{ text: s.next_best_question, status: "ai_inference", evidence_tier: "inference", source: { kind: "rule", locator: aiLabel }, observed_on: today, published_on: null, expires_on: addDays(today, 30), expired: false }] },
  ];
}

export function sourcesSection(sections: DossierSection[]): DossierSection {
  const seen = new Map<string, DossierClaim>();
  for (const s of sections) for (const c of s.claims) {
    if (c.source.kind === "rule") continue;
    const k = `${c.source.kind}:${c.source.id ?? ""}:${c.source.url ?? ""}`;
    if (!seen.has(k)) seen.set(k, { ...c, text: c.source.url ?? `${c.source.kind}${c.source.id ? ` ${c.source.id.slice(0, 8)}` : ""}${c.source.locator ? ` (${c.source.locator})` : ""}` });
  }
  const claims = [...seen.values()].sort((a, b) => EVIDENCE_TIER_RANK[b.evidence_tier] - EVIDENCE_TIER_RANK[a.evidence_tier]);
  return { key: "sources", title: SECTION_TITLES.sources, status: claims.length ? "known" : "unknown", claims, note: claims.length ? undefined : "No sources on file yet." };
}
