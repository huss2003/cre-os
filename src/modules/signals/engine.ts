/**
 * Signal Engine — pure, deterministic rules (no DB, no AI). Category mapping, lease-event distinctions, counter-evidence,
 * confidence, priority (configurable weights, reasons always shown) and next-action generation.
 * Rule S5/S6: no arithmetic by a model, unknown stays unknown, no invented area / budget / move-in date.
 */
export const RULE_VERSION = "signals-2";

export type Category = "expansion" | "restructuring" | "lease" | "commercial" | "leadership" | "infrastructure" | "macro";
export type Confidence = "high" | "medium" | "low" | "insufficient";
export type Verification = "fact" | "inference" | "hypothesis" | "unknown";
export type Band = "high" | "medium" | "low";

export const CATEGORY_LABEL: Record<Category, string> = {
  expansion: "Expansion", restructuring: "Restructuring", lease: "Lease event", commercial: "Commercial opportunity",
  leadership: "Leadership change", infrastructure: "Infrastructure", macro: "Macro / industry",
};

/** signal_claim.claim_type -> signal category. Unknown claim types are ignored (not forced into a category). */
const CLAIM_CATEGORY: Record<string, Category> = {
  expansion: "expansion", gcc_plan: "expansion", hiring: "expansion", funding: "expansion", new_office: "expansion", investment: "expansion",
  consolidation: "restructuring", rto: "restructuring", layoff: "restructuring", workforce_reduction: "restructuring",
  relocation: "restructuring", merger: "restructuring", acquisition: "restructuring", restructuring: "restructuring",
  leadership_change: "leadership", job_move: "leadership", appointment: "leadership",
  infrastructure: "infrastructure", metro: "infrastructure", office_supply: "infrastructure",
  macro: "macro", industry_trend: "macro", interest_rate: "macro",
  rent_benchmark: "commercial", better_value_option: "commercial",
  lease_expiry: "lease", lease_renewal: "lease",
};
export function categoryOf(claimType: string): Category | null {
  return CLAIM_CATEGORY[claimType] ?? null;
}

// ------------------------------------------------------------------ lease events (never interchangeable)

export type LeaseEventType = "expiry" | "lockin_end" | "notice_deadline" | "break" | "escalation" | "option";
const LEASE_LABEL: Record<LeaseEventType, string> = {
  expiry: "Lease expiry", lockin_end: "Lock-in ends", notice_deadline: "Notice deadline", break: "Break option",
  escalation: "Rent escalation", option: "Renewal option",
};
/** How far ahead each event type becomes a signal (days). Notice deadlines matter sooner than they look. */
export const LEASE_WINDOW_DAYS: Record<LeaseEventType, number> = {
  expiry: 540, lockin_end: 365, notice_deadline: 240, break: 365, escalation: 120, option: 365,
};

export interface LeaseEventIn { id: string; event_type: LeaseEventType; event_date: string | null; date_basis: string; confirmed: boolean; notice_days: number | null }
export interface LeaseSignalSpec { kind: string; title: string; daysAway: number | null; past: boolean; verification: Verification; recommended: string; actionKind: string }

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/** Returns null when the event is outside its window, has no date, or is a past non-expiry event (nothing to do). */
export function leaseSignal(e: LeaseEventIn, today: string): LeaseSignalSpec | null {
  if (!e.event_date) return null;
  const d = daysBetween(today, e.event_date);
  const label = LEASE_LABEL[e.event_type] ?? e.event_type;
  const verification: Verification = e.confirmed || e.date_basis === "contractual" ? "fact" : e.date_basis === "estimated" ? "hypothesis" : "inference";
  if (d < 0) {
    // A past expiry is NOT a claim that the company needs space now — only a prompt to verify what happened.
    if (e.event_type !== "expiry" || d < -365) return null;
    return { kind: "lease_expiry_past", title: `${label} date has passed (${e.event_date})`, daysAway: d, past: true, verification: "unknown",
      recommended: "Verify current occupancy: renewed, extended, relocated or vacated? Do not assume a space need.", actionKind: "lease_event_verification" };
  }
  if (d > (LEASE_WINDOW_DAYS[e.event_type] ?? 365)) return null;
  const rec: Record<LeaseEventType, string> = {
    expiry: "Confirm renewal or relocation plans with the occupier.",
    lockin_end: "Confirm whether the occupier is reviewing its options after lock-in.",
    notice_deadline: "Verify the notice clause and confirm the occupier's intent before the deadline.",
    break: "Confirm whether the break option is under consideration.",
    escalation: "Check the escalation terms and prepare a cost comparison only on a like-for-like rent basis.",
    option: "Confirm whether the renewal option will be exercised.",
  };
  return { kind: `lease_${e.event_type}`, title: `${label} in ${d} days (${e.event_date})`, daysAway: d, past: false, verification,
    recommended: rec[e.event_type], actionKind: "lease_event_verification" };
}

// ------------------------------------------------------------------ counter-evidence & false positives

export interface CounterInput {
  category: Category; kind: string; texts: string[]; focusCities: string[]; sourceCount: number;
  latestEvidenceOn: string | null; today: string; hasOccupancyInFocus: boolean; personFunction?: string | null;
  /** Independent evidence groups among the sources (repeats of one announcement count once). */
  independentCount?: number;
  /** Lease-derived signal whose lease event is past or superseded. */
  leaseOutdated?: boolean;
  /** Commercial signal whose compared availability is no longer available. */
  propertyUnavailable?: boolean;
  /** Infrastructure signal with no recorded property / occupier in the affected micro-market. */
  infraNoTarget?: boolean;
}
const REMOTE = /\b(remote(?:ly)?|remote[- ]first|work(?:ing)? from home|wfh|hybrid[- ]remote|distributed team)\b/i;
const EXISTING = /\b(existing (?:office|campus|facility|premises|centre|center)|current (?:office|campus|premises))\b/i;
const CITY = /\b(Bengaluru|Bangalore|Hyderabad|Chennai|Mumbai|Navi Mumbai|Delhi|Gurugram|Gurgaon|Noida|Kolkata|Ahmedabad|Kochi|Coimbatore|Jaipur|Pune|Indore|Chandigarh|Thiruvananthapuram|Nagpur)\b/gi;
const CRE_ROLE = /\b(real estate|facilit|admin|workplace|procure|finance|cfo|hr|people|site (?:head|lead)|country head|managing director|ceo|coo|gcc)\b/i;

export function citiesIn(texts: string[]): string[] {
  const s = new Set<string>();
  for (const t of texts) for (const m of (t ?? "").matchAll(CITY)) s.add(normCity(m[0]));
  return [...s];
}
function normCity(c: string) {
  const l = c.toLowerCase();
  return l === "bangalore" ? "Bengaluru" : l === "gurgaon" ? "Gurugram" : c[0].toUpperCase() + c.slice(1).toLowerCase();
}

export function counterEvidence(i: CounterInput): string[] {
  const out: string[] = [];
  const all = i.texts.join(" \n ");
  const focus = i.focusCities.map((c) => c.toLowerCase());
  const cities = citiesIn(i.texts);
  if (cities.length && focus.length && !cities.some((c) => focus.includes(c.toLowerCase())))
    out.push(`Evidence mentions ${cities.join(", ")} — not ${i.focusCities.join("/")}.`);
  if (REMOTE.test(all)) out.push("Evidence mentions remote work; hiring may not need office space.");
  const outside = i.focusCities.filter((c) => new RegExp(`\\boutside (?:of )?(?:the )?${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(all));
  if (outside.length) out.push(`Evidence says people will be based outside ${outside.join("/")} — not demand in the focus market.`);
  if (EXISTING.test(all)) out.push("Announcement may refer to an existing office, which could already accommodate the growth.");
  if (i.category === "expansion" && i.kind === "hiring") out.push("Hiring is a demand signal, not an office-size commitment.");
  if (i.category === "restructuring" && /layoff|workforce|reduction/.test(i.kind + all.toLowerCase()))
    out.push("Workforce reductions do not automatically mean office-space reduction.");
  if (i.category === "expansion" && i.hasOccupancyInFocus) out.push("Company already occupies space in the focus market; spare capacity is unverified.");
  if (i.sourceCount > 1 && (i.independentCount ?? i.sourceCount) < i.sourceCount)
    out.push(`${i.sourceCount} sources refer to ${i.independentCount ?? 1} underlying announcement${(i.independentCount ?? 1) === 1 ? "" : "s"} — repeats are not independent confirmation.`);
  else if (i.sourceCount > 1 && i.independentCount == null) out.push(`${i.sourceCount} sources may all refer to one announcement — counted once.`);
  if (i.leaseOutdated) out.push("The lease event is outdated (date passed) — the lease may already have been renewed, extended or vacated.");
  if (i.propertyUnavailable) out.push("The compared property is no longer listed as available.");
  if (i.infraNoTarget) out.push("No recorded property or occupier in the affected micro-market — the development may have no material effect on your targets.");
  if (i.latestEvidenceOn && daysBetween(i.latestEvidenceOn, i.today) > 180) out.push(`Latest evidence is from ${i.latestEvidenceOn} (over 6 months old).`);
  if (i.category === "leadership" && i.personFunction != null && !CRE_ROLE.test(i.personFunction))
    out.push("The role may not influence real-estate decisions.");
  return out;
}

// ------------------------------------------------------------------ confidence (evidence strength, not model certainty)

export interface EvidenceIn { tier: string | null; status: string | null; source: string | null; published_on: string | null }
export function assessConfidence(ev: EvidenceIn[], counters: string[]): { confidence: Confidence; reasons: string[] } {
  if (!ev.length) return { confidence: "insufficient", reasons: ["No supporting evidence recorded."] };
  const reasons: string[] = [];
  const sources = new Set(ev.map((e) => (e.source ?? "").toLowerCase()).filter(Boolean));
  const documentary = ev.some((e) => e.tier === "documentary_current" || e.status === "currently_confirmed");
  const credible = ev.some((e) => e.tier === "credible_reported" || e.tier === "corroborated_public");
  const inferenceOnly = ev.every((e) => e.tier === "inference" || e.status === "ai_inference");
  let c: Confidence;
  if (documentary) { c = "high"; reasons.push("Documentary or confirmed evidence."); }
  else if (credible && sources.size >= 2) { c = "high"; reasons.push(`Credible evidence from ${sources.size} independent sources.`); }
  else if (credible) { c = "medium"; reasons.push("One credible reported source."); }
  else if (inferenceOnly) { c = "low"; reasons.push("Rule or model inference only — not yet verified."); }
  else { c = "low"; reasons.push("Single unverified source."); }
  const serious = counters.filter((x) => /not |remote|existing office|over 6 months|outside /.test(x)).length;
  // Remote / outside-focus-market evidence directly contradicts local office demand: always lowers one step.
  const direct = counters.some((x) => /remote work|outside /.test(x));
  if ((serious >= 2 && c !== "low") || direct) {
    const from = c;
    c = c === "high" ? "medium" : c === "medium" ? "low" : "insufficient";
    reasons.push(`Lowered from ${from} to ${c}: counter-evidence present${direct ? " (remote work / roles outside the focus market)" : ""}.`);
  }
  return { confidence: c, reasons };
}

// ------------------------------------------------------------------ priority (separate from lead score / win probability)

export interface PriorityWeights { timing: number; relevance: number; evidence: number; geography: number; access: number; commercial: number; freshness: number; verificationPenalty: number; highAt: number; mediumAt: number }
export const DEFAULT_WEIGHTS: PriorityWeights = { timing: 25, relevance: 15, evidence: 15, geography: 15, access: 15, commercial: 10, freshness: 5, verificationPenalty: 10, highAt: 60, mediumAt: 35 };
const RELEVANCE: Record<Category, number> = { lease: 1, expansion: 0.9, restructuring: 0.8, leadership: 0.6, commercial: 0.7, infrastructure: 0.4, macro: 0.2 };

export interface PriorityInput {
  category: Category; daysAway: number | null; confidence: Confidence; inFocusGeo: boolean; hasContact: boolean;
  hasOpenOpportunity: boolean; hasRequirement: boolean; leaseWithin18m: boolean; freshnessDays: number | null; needsVerification: boolean;
  /** Counter-evidence items recorded against the signal (pasted or added by a user) — each lowers priority. */
  counterItems?: number;
}
export function priorityOf(p: PriorityInput, w: PriorityWeights = DEFAULT_WEIGHTS): { score: number; band: Band; reasons: string[] } {
  const r: string[] = [];
  let s = 0;
  if (p.daysAway != null && p.daysAway >= 0) {
    const t = p.daysAway <= 90 ? 1 : p.daysAway <= 180 ? 0.7 : p.daysAway <= 365 ? 0.4 : 0.2;
    s += w.timing * t; r.push(`Event in ${p.daysAway} days (+${Math.round(w.timing * t)}).`);
  }
  s += w.relevance * RELEVANCE[p.category]; r.push(`${CATEGORY_LABEL[p.category]} relevance (+${Math.round(w.relevance * RELEVANCE[p.category])}).`);
  const ev = p.confidence === "high" ? 1 : p.confidence === "medium" ? 0.6 : p.confidence === "low" ? 0.25 : 0;
  s += w.evidence * ev; r.push(`Evidence ${p.confidence} (+${Math.round(w.evidence * ev)}).`);
  if (p.inFocusGeo) { s += w.geography; r.push(`In focus market (+${w.geography}).`); }
  if (p.hasContact) { s += w.access; r.push(`Known contact on record (+${w.access}).`); }
  const com = (p.leaseWithin18m ? 0.5 : 0) + (p.hasRequirement ? 0.3 : 0) + (p.hasOpenOpportunity ? 0.2 : 0);
  if (com > 0) { s += w.commercial * com; r.push(`Commercial context: ${[p.leaseWithin18m && "lease event ≤18 months", p.hasRequirement && "requirement", p.hasOpenOpportunity && "open deal"].filter(Boolean).join(", ")} (+${Math.round(w.commercial * com)}).`); }
  if (p.freshnessDays != null && p.freshnessDays <= 30) { s += w.freshness; r.push(`Fresh evidence (+${w.freshness}).`); }
  if (p.needsVerification) { s -= w.verificationPenalty; r.push(`Needs verification (−${w.verificationPenalty}).`); }
  if (p.counterItems && p.counterItems > 0) { const pen = Math.min(30, 12 * p.counterItems); s -= pen; r.push(`Counter-evidence recorded (−${pen}).`); }
  const score = Math.max(0, Math.min(100, Math.round(s)));
  let band: Band = score >= w.highAt ? "high" : score >= w.mediumAt ? "medium" : "low";
  // Evidence strength alone never makes a signal high priority: needs timing, access or commercial context too.
  if (band === "high" && !(p.daysAway != null && p.daysAway <= 365) && !p.hasContact && com === 0) { band = "medium"; r.push("Capped at medium: strong evidence but no timing, contact or commercial context."); }
  return { score, band, reasons: r };
}

// ------------------------------------------------------------------ next action & missing information

export interface ContextFacts { hasLease: boolean; hasContact: boolean; hasRequirement: boolean; occupancyVerified: boolean; locations: string[] }
export function nextAction(category: Category, kind: string, c: ContextFacts): { text: string; actionKind: string } {
  if (category === "expansion" && kind === "gcc_plan") return { text: "Verify office strategy and expected team size for the GCC.", actionKind: "research" };
  if (category === "expansion" && kind === "hiring") return { text: "Confirm hiring location and office-attendance policy.", actionKind: "contact_verification" };
  if (category === "expansion") return c.hasContact
    ? { text: "Contact the known decision-maker to confirm whether the expansion needs additional space.", actionKind: "relationship_follow_up" }
    : { text: "Research the expansion and identify a real-estate or facilities decision-maker.", actionKind: "research" };
  if (category === "lease") return { text: "Confirm renewal or relocation plans with the occupier before the notice window.", actionKind: "lease_event_verification" };
  if (category === "restructuring") return { text: "Verify whether a space reduction, relocation or consolidation is planned.", actionKind: "contact_verification" };
  if (category === "leadership") return { text: "Research the person's responsibilities and the relationship path; review both employers' records.", actionKind: "relationship_follow_up" };
  if (category === "commercial") return { text: "Validate availability and compare total occupancy cost on a like-for-like basis.", actionKind: "property_research" };
  if (category === "infrastructure") return { text: "Assess the effect on the relevant micro-markets and properties.", actionKind: "property_research" };
  if (category === "macro") return { text: "Note for account reviews; check which watched companies are exposed.", actionKind: "research" };
  return { text: "Review and verify.", actionKind: "research" };
}

export function missingInfo(category: Category, c: ContextFacts): string[] {
  const m: string[] = [];
  if (category === "expansion" || category === "restructuring") {
    if (!c.locations.length) m.push("Current office locations not recorded.");
    if (!c.occupancyVerified) m.push("Current occupancy / spare capacity unverified.");
    m.push("Required area, budget and move-in date unknown (not inferred).");
  }
  if (!c.hasLease && category !== "macro" && category !== "infrastructure") m.push("No lease on record.");
  if (!c.hasContact && category !== "macro" && category !== "infrastructure") m.push("No real-estate / facilities contact on record.");
  if (category === "commercial") m.push("Comparable rent basis (carpet vs chargeable, warm-shell vs fitted) to be confirmed.",
    "CAM, deposit, escalation, rent-free and fit-out on both sides (total occupancy cost).", "Required area, configuration and amenities.", "Relocation / exit costs and lease constraints (lock-in, notice).");
  if (category === "infrastructure") m.push("Confirmed status vs forecast (completion date, approvals) to be verified.", "Which recorded properties / occupiers are affected.");
  if (category === "leadership") m.push("Employment change unverified until confirmed — record stays an observation.", "The person's actual responsibility for real-estate decisions.");
  return m;
}

/** Stable grouping key: same company + same kind + same month = one event, however many articles report it. */
export function dedupeKey(category: Category, kind: string, entity: string, dateIso: string | null): string {
  return `${category}:${kind}:${entity.toLowerCase().replace(/\s+/g, " ").trim()}:${(dateIso ?? "nodate").slice(0, 7)}`;
}

export const normName = (s: string) => s.toLowerCase().replace(/\b(pvt|private|ltd|limited|llp|inc|corp|corporation|india)\b\.?/g, "").replace(/[^a-z0-9]+/g, " ").trim();
