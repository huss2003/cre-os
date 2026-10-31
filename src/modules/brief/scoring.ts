/**
 * Explainable lead scoring, rubric "v1" (spec Part I §9). PURE — no DB, no LLM.
 *
 *   timing 25 | fit 15 | trigger 20 | relationship 15 | engagement 15 | budget/process 10  = 100
 *
 * Interpretation notes (documented in README):
 *  - "verified" date = contractual or explicitly confirmed. Calculated/reported/estimated dates are capped at 10 timing
 *    points and carry a "verify" evidence line (spec: expiry arithmetic is not documentary verification).
 *  - expired lease => 0 timing points + statusNeedsConfirmation (never hot).
 *  - missing dates => 0 timing points + enrichment reason (never a fabricated expiry).
 *  - email tracking pixels/opens are ignored for engagement.
 *  - disqualification / suppression override the total (total 0, tier "suppressed").
 *  - a verified notice/action deadline within 90 days forces tier "act_this_week" (override "deadline_within_90d").
 */
import { daysBetween } from "./dates";
import type { RadarItem } from "./lease-radar";

export const SCORE_VERSION = "v1";

export type ComponentKey = "timing" | "fit" | "trigger" | "relationship" | "engagement" | "budget";
export const COMPONENT_MAX: Record<ComponentKey, number> = { timing: 25, fit: 15, trigger: 20, relationship: 15, engagement: 15, budget: 10 };
export const COMPONENT_LABEL: Record<ComponentKey, string> = {
  timing: "Lease/notice timing", fit: "Size/location fit", trigger: "Business trigger",
  relationship: "Relationship/intro", engagement: "Recent engagement", budget: "Budget/authority/process",
};

export type EvidenceTier = "documentary_current" | "credible_reported" | "corroborated_public" | "single_unverified" | "inference";
export const EVIDENCE_ORDER: EvidenceTier[] = ["documentary_current", "credible_reported", "corroborated_public", "single_unverified", "inference"];
export const EVIDENCE_LABEL: Record<EvidenceTier | "none", string> = {
  documentary_current: "Documentary / current", credible_reported: "Credible reported", corroborated_public: "Corroborated public signal",
  single_unverified: "Single unverified report", inference: "Inference", none: "No evidence",
};

export interface Component {
  points: number;
  max: number;
  band: string;            // rubric band applied
  evidence: string[];      // human-readable evidence lines
  verified_on: string | null; // last verification/observation date of the evidence used
  evidence_tier: EvidenceTier | null;
}

export type Tier = "act_this_week" | "validate_nurture" | "enrich_or_park" | "suppressed";
export const TIER_LABEL: Record<Tier, string> = {
  act_this_week: "Act this week", validate_nurture: "Validate / nurture", enrich_or_park: "Enrich or park", suppressed: "Suppressed / disqualified",
};

export interface SignalInput {
  claimType: string;
  status: string;              // fact_status
  evidenceTier: EvidenceTier | null;
  observedOn?: string | null;
  publishedOn?: string | null;
  expiresOn?: string | null;
  excerpt?: string | null;
  sourceUrl?: string | null;
}

export interface RelationshipInput {
  personName?: string | null;
  warmth: "cold" | "warm" | "hot" | "trusted" | null;
  decisionMaker: boolean;
  introPermission: boolean;
  viaIntroducer: boolean;       // edge from another person (intro path) rather than from the user
  lastMeaningfulContact?: string | null;
}

export interface EngagementInput {
  at: string;                   // ISO instant or date
  kind: "reply" | "conversation" | "tracking_open" | "other";
  meaningful: boolean;
  hasNextStep: boolean;
  summary?: string | null;
}

export interface RequirementInput {
  status: "draft" | "estimated" | "client_confirmed" | "closed";
  hasArea: boolean;
  hasLocation: boolean;
  excluded?: boolean;           // client excluded our market / size out of band
  decisionDate?: string | null;
  occupationDate?: string | null;
  budgetSet: boolean;
  confirmedAt?: string | null;
}

export interface ScoreInput {
  subjectId: string;
  subjectName: string;
  today: string;
  radar: RadarItem[];
  requirement?: RequirementInput | null;
  leaseAreaSf?: number | null;
  fitBand?: { minSf: number | null; maxSf: number | null };
  signals: SignalInput[];
  relationships: RelationshipInput[];
  knownContacts: number;
  engagements: EngagementInput[];
  decisionPath: "confirmed" | "partial" | "unknown";
  disqualified?: string | null;
  suppressed?: string | null;
}

export interface ScoreResult {
  version: string;
  subjectId: string;
  total: number;
  rawTotal: number;
  components: Record<ComponentKey, Component>;
  tier: Tier;
  overrides: string[];
  evidenceConfidence: EvidenceTier | "none";
  warmth: "hot" | "warm" | "cold";
  flags: { deadlineWithin90: boolean; statusNeedsConfirmation: boolean; needsEnrichment: boolean; unverifiedDates: boolean };
  enrichment: string[];
  nextDeadline: { date: string; kind: "notice" | "decision"; days: number } | null;
}

const UNVERIFIED_TIMING_CAP = 10;

function comp(key: ComponentKey, points: number, band: string, evidence: string[], verified_on: string | null, tier: EvidenceTier | null): Component {
  return { points: Math.max(0, Math.min(COMPONENT_MAX[key], points)), max: COMPONENT_MAX[key], band, evidence, verified_on, evidence_tier: points > 0 ? tier : null };
}

function dateOnly(s: string | null | undefined): string | null {
  return s ? s.slice(0, 10) : null;
}

// ------------------------------------------------------------------ timing (25)
function scoreTiming(i: ScoreInput): { c: Component; deadline: ScoreResult["nextDeadline"]; deadlineVerified: boolean; expiredOnly: boolean; missing: boolean; unverified: boolean } {
  const today = i.today;
  type Opt = { points: number; band: string; ev: string; verified: boolean; date: string; deadline?: { date: string; kind: "notice" | "decision" } };
  const opts: Opt[] = [];
  let expiredOnly = i.radar.length > 0;
  let missing = i.radar.length === 0;

  // requirement decision date (client-confirmed action deadline)
  const rq = i.requirement;
  if (rq?.decisionDate && rq.decisionDate >= today) {
    const d = daysBetween(today, rq.decisionDate);
    const verified = rq.status === "client_confirmed";
    if (d <= 90) opts.push({ points: 25, band: "action deadline ≤90 days", ev: `Decision date ${rq.decisionDate} (${d} days, ${verified ? "client confirmed" : "estimated"})`, verified, date: rq.decisionDate, deadline: { date: rq.decisionDate, kind: "decision" } });
    else if (d <= 365) opts.push({ points: 20, band: "3–12-month opportunity", ev: `Decision date ${rq.decisionDate} (${d} days)`, verified, date: rq.decisionDate });
    else if (d <= 730) opts.push({ points: 10, band: "12–24 months", ev: `Decision date ${rq.decisionDate}`, verified, date: rq.decisionDate });
    missing = false;
    expiredOnly = false;
  }

  for (const r of i.radar) {
    if (r.status === "expired_needs_confirmation") continue;
    if (r.status !== "active") continue;
    expiredOnly = false;
    missing = false;
    const where = r.assetName ? ` at ${r.assetName}` : "";
    if (r.noticeDeadline && r.noticeDeadline.date >= today) {
      const d = daysBetween(today, r.noticeDeadline.date);
      if (d <= 90) opts.push({ points: 25, band: "notice deadline ≤90 days", ev: `Notice deadline ${r.noticeDeadline.date}${where} (${d} days; ${r.noticeDeadline.basisLabel})`, verified: r.noticeDeadline.verified, date: r.noticeDeadline.date, deadline: { date: r.noticeDeadline.date, kind: "notice" } });
    }
    if (r.expiry) {
      const d = r.daysToExpiry!;
      const ev = `Expiry ${r.expiry.date}${where} (${Math.round(d / 30.4)} months; ${r.expiry.basisLabel})`;
      if (d <= 90) {
        opts.push({ points: 25, band: "near expiry ≤3 months", ev, verified: r.expiry.verified, date: r.expiry.date });
      } else if (d <= 365) {
        const viable = r.plan?.viable ?? true;
        if (viable) opts.push({ points: 20, band: "3–12-month opportunity, viable decision timeline", ev: `${ev}; last decision ${r.plan?.lastDecision ?? "—"}`, verified: r.expiry.verified, date: r.expiry.date });
        else opts.push({ points: 10, band: "3–12 months but decision lead time already passed", ev: `${ev}; reverse plan says decision was due ${r.plan?.lastDecision} — likely renewal/holdover, validate`, verified: r.expiry.verified, date: r.expiry.date });
      } else if (d <= 730) {
        opts.push({ points: 10, band: "12–24 months (nurture)", ev, verified: r.expiry.verified, date: r.expiry.date });
      } else {
        opts.push({ points: 0, band: "beyond 24 months", ev, verified: r.expiry.verified, date: r.expiry.date });
      }
    }
  }
  if (i.radar.some((r) => r.status === "dates_unknown" || r.status === "quarantined") && opts.length === 0) missing = true;

  // apply verification cap, then take the best
  const scored = opts.map((o) => ({ ...o, eff: o.verified ? o.points : Math.min(o.points, UNVERIFIED_TIMING_CAP) }));
  scored.sort((a, b) => b.eff - a.eff || (a.date < b.date ? -1 : 1));
  const best = scored[0];
  const verifiedDeadline = scored.find((o) => o.deadline && o.verified);
  const anyDeadline = verifiedDeadline ?? scored.find((o) => o.deadline);
  const deadline = anyDeadline?.deadline ? { ...anyDeadline.deadline, days: daysBetween(today, anyDeadline.deadline.date) } : null;

  if (!best) {
    const evidence: string[] = [];
    let band = "unknown";
    if (expiredOnly) {
      band = "expired — status needs confirmation";
      for (const r of i.radar) if (r.expiry) evidence.push(`Lease expired ${r.expiry.date}${r.assetName ? ` at ${r.assetName}` : ""}: status needs confirmation (not a hot lead)`);
    } else evidence.push("No lease, notice or decision date known — enrichment task raised");
    return { c: comp("timing", 0, band, evidence, null, null), deadline: null, deadlineVerified: false, expiredOnly, missing: !expiredOnly && missing, unverified: false };
  }
  const evidence = [best.ev];
  if (!best.verified && best.points > best.eff) evidence.push(`Capped at ${UNVERIFIED_TIMING_CAP}: date is not contractual/confirmed — verify before relying on it`);
  const tier: EvidenceTier = best.verified ? "documentary_current" : "inference";
  return {
    c: comp("timing", best.eff, best.band + (best.verified ? "" : " (unverified)"), evidence, best.verified ? best.date : null, tier),
    deadline, deadlineVerified: !!verifiedDeadline && (verifiedDeadline.deadline!.date >= today) && daysBetween(today, verifiedDeadline.deadline!.date) <= 90,
    expiredOnly: false, missing: false, unverified: !best.verified,
  };
}

// ------------------------------------------------------------------ fit (15)
function scoreFit(i: ScoreInput): Component {
  const rq = i.requirement;
  if (rq?.excluded) return comp("fit", 0, "excluded", ["Requirement excluded by size/location constraints"], dateOnly(rq.confirmedAt), "documentary_current");
  if (rq && rq.status === "client_confirmed" && rq.hasArea && rq.hasLocation) {
    return comp("fit", 15, "confirmed fit", ["Client-confirmed requirement with area and location"], dateOnly(rq.confirmedAt), "documentary_current");
  }
  if (rq && (rq.hasArea || rq.hasLocation)) {
    return comp("fit", 8, "plausible, unconfirmed fit", [`Requirement ${rq.status.replace("_", " ")}: ${rq.hasArea ? "area" : ""}${rq.hasArea && rq.hasLocation ? " + " : ""}${rq.hasLocation ? "location" : ""} known, not client-confirmed`], null, "credible_reported");
  }
  const band = i.fitBand;
  if (i.leaseAreaSf != null && band) {
    const okMin = band.minSf == null || i.leaseAreaSf >= band.minSf;
    const okMax = band.maxSf == null || i.leaseAreaSf <= band.maxSf;
    if (okMin && okMax) return comp("fit", 8, "plausible, unconfirmed fit", [`Current lease ${Math.round(i.leaseAreaSf).toLocaleString("en-IN")} sf is inside the target band (from lease record, not a requirement)`], null, "inference");
    return comp("fit", 0, "outside target band", [`Current lease ${Math.round(i.leaseAreaSf)} sf is outside the target band`], null, null);
  }
  return comp("fit", 0, "unknown", ["No requirement or area known"], null, null);
}

// ------------------------------------------------------------------ trigger (20)
const DIRECT_DEMAND = new Set(["office_requirement", "active_search", "rfp", "space_requirement"]);
const EXPANSION = new Set(["expansion", "consolidation", "relocation", "gcc_plan", "rto", "new_office", "headcount_growth"]);

function scoreTrigger(i: ScoreInput): Component {
  const live = i.signals.filter((s) => !s.expiresOn || s.expiresOn >= i.today);
  if (i.requirement && i.requirement.status === "client_confirmed") {
    return comp("trigger", 20, "directly confirmed active office demand", ["Client-confirmed requirement on record"], dateOnly(i.requirement.confirmedAt), "documentary_current");
  }
  const when = (s: SignalInput) => s.observedOn ?? s.publishedOn ?? null;
  const line = (s: SignalInput) => `${s.claimType.replace(/_/g, " ")}${s.excerpt ? `: “${s.excerpt.slice(0, 120)}”` : ""}${when(s) ? ` (${when(s)})` : ""}${s.sourceUrl ? ` — ${s.sourceUrl}` : ""}`;
  const direct = live.filter((s) => DIRECT_DEMAND.has(s.claimType) && (s.status === "currently_confirmed" || s.evidenceTier === "documentary_current"));
  if (direct.length) return comp("trigger", 20, "directly confirmed active office demand", direct.slice(0, 3).map(line), when(direct[0]), "documentary_current");
  const corroborated = live.filter((s) => (EXPANSION.has(s.claimType) || DIRECT_DEMAND.has(s.claimType)) && (s.evidenceTier === "corroborated_public" || s.evidenceTier === "credible_reported" || s.evidenceTier === "documentary_current"));
  if (corroborated.length) {
    const t = corroborated.some((s) => s.evidenceTier === "credible_reported" || s.evidenceTier === "documentary_current") ? "credible_reported" : "corroborated_public";
    return comp("trigger", 12, "corroborated expansion/consolidation evidence", corroborated.slice(0, 3).map(line), when(corroborated[0]), t);
  }
  if (live.length) {
    const s = live[0];
    return comp("trigger", 5, "weak single signal", [line(s)], when(s), s.evidenceTier === "inference" ? "inference" : "single_unverified");
  }
  return comp("trigger", 0, "none", ["No current business trigger on record"], null, null);
}

// ------------------------------------------------------------------ relationship (15)
function scoreRelationship(i: ScoreInput): Component {
  const recent = (d?: string | null) => !!d && daysBetween(d.slice(0, 10), i.today) <= 365;
  const trusted = i.relationships.find((r) => !r.viaIntroducer && r.decisionMaker && (r.warmth === "trusted" || r.warmth === "hot") && recent(r.lastMeaningfulContact));
  if (trusted) return comp("relationship", 15, "active trusted decision-maker relationship", [`${trusted.personName ?? "Decision-maker"}: ${trusted.warmth}, last contact ${trusted.lastMeaningfulContact}`], dateOnly(trusted.lastMeaningfulContact), "documentary_current");
  const intro = i.relationships.find((r) => r.introPermission && (r.warmth === "warm" || r.warmth === "hot" || r.warmth === "trusted"));
  if (intro) return comp("relationship", 10, "permissioned warm introduction available", [`Warm intro path${intro.personName ? ` via ${intro.personName}` : ""} (intro permission recorded)`], dateOnly(intro.lastMeaningfulContact), "credible_reported");
  if (i.knownContacts > 0 || i.relationships.length > 0) return comp("relationship", 5, "known contact, no path", [`${Math.max(i.knownContacts, i.relationships.length)} known contact(s); no trusted or permissioned path`], null, "single_unverified");
  return comp("relationship", 0, "no path", ["No known contact or introduction path"], null, null);
}

// ------------------------------------------------------------------ engagement (15)
function scoreEngagement(i: ScoreInput): Component {
  const real = i.engagements.filter((e) => e.kind !== "tracking_open" && e.meaningful);
  const ignored = i.engagements.filter((e) => e.kind === "tracking_open").length;
  const age = (e: EngagementInput) => daysBetween(e.at.slice(0, 10), i.today);
  const sorted = [...real].sort((a, b) => (a.at < b.at ? 1 : -1));
  const note = ignored ? [`${ignored} email open/tracking event(s) ignored — not meaningful engagement`] : [];
  const reply = sorted.find((e) => e.kind === "reply" && e.hasNextStep && age(e) <= 30);
  if (reply) return comp("engagement", 15, "recent substantive reply with next step", [`Reply ${reply.at.slice(0, 10)}${reply.summary ? `: ${reply.summary.slice(0, 100)}` : ""}`, ...note], reply.at.slice(0, 10), "documentary_current");
  const conv = sorted.find((e) => age(e) <= 90);
  if (conv) return comp("engagement", 8, "meaningful conversation without next step", [`${conv.kind} ${conv.at.slice(0, 10)}${conv.summary ? `: ${conv.summary.slice(0, 100)}` : ""}`, ...note], conv.at.slice(0, 10), "documentary_current");
  if (sorted.length) return comp("engagement", 3, "older interaction", [`Last meaningful interaction ${sorted[0].at.slice(0, 10)}`, ...note], sorted[0].at.slice(0, 10), "documentary_current");
  return comp("engagement", 0, "none", ["No meaningful interaction on record", ...note], null, null);
}

// ------------------------------------------------------------------ budget/process (10)
function scoreBudget(i: ScoreInput): Component {
  const budget = !!i.requirement?.budgetSet;
  const budgetConfirmed = budget && i.requirement?.status === "client_confirmed";
  if (budgetConfirmed && i.decisionPath === "confirmed") return comp("budget", 10, "budget and decision path confirmed", ["Client-confirmed budget; approver/finance/procurement stakeholders mapped"], dateOnly(i.requirement?.confirmedAt), "documentary_current");
  if (budget || i.decisionPath !== "unknown") {
    const ev = [budget ? `Budget ${budgetConfirmed ? "confirmed" : "estimated"}` : "Budget unknown", i.decisionPath === "unknown" ? "decision path unknown" : `decision path ${i.decisionPath}`];
    return comp("budget", 5, "partially established", [ev.join("; ")], null, budgetConfirmed ? "documentary_current" : "credible_reported");
  }
  return comp("budget", 0, "unknown", ["Budget and decision path unknown"], null, null);
}

export function tierFor(total: number): Tier {
  if (total >= 75) return "act_this_week";
  if (total >= 50) return "validate_nurture";
  return "enrich_or_park";
}

export function scoreLead(i: ScoreInput): ScoreResult {
  const t = scoreTiming(i);
  const components: Record<ComponentKey, Component> = {
    timing: t.c, fit: scoreFit(i), trigger: scoreTrigger(i), relationship: scoreRelationship(i), engagement: scoreEngagement(i), budget: scoreBudget(i),
  };
  const rawTotal = (Object.keys(components) as ComponentKey[]).reduce((s, k) => s + components[k].points, 0);
  const overrides: string[] = [];
  let tier = tierFor(rawTotal);
  let total = rawTotal;
  if (t.deadlineVerified) {
    overrides.push("deadline_within_90d");
    tier = "act_this_week";
  }
  if (t.expiredOnly) overrides.push("expired_status_needs_confirmation");
  if (i.disqualified) {
    overrides.push(`disqualified: ${i.disqualified}`);
    tier = "suppressed";
    total = 0;
  }
  if (i.suppressed) {
    overrides.push(`suppressed: ${i.suppressed}`);
    tier = "suppressed";
    total = 0;
  }

  // evidence confidence = weakest tier among components that earned points (conservative)
  const tiers = (Object.values(components).map((c) => c.evidence_tier).filter(Boolean) as EvidenceTier[]);
  const evidenceConfidence = tiers.length ? tiers.reduce((w, x) => (EVIDENCE_ORDER.indexOf(x) > EVIDENCE_ORDER.indexOf(w) ? x : w)) : "none";

  const rel = components.relationship.points;
  const eng = components.engagement.points;
  const warmth: ScoreResult["warmth"] = rel === 15 || eng === 15 ? "hot" : rel >= 10 || eng >= 8 ? "warm" : "cold";

  const enrichment: string[] = [];
  if (t.missing) enrichment.push(`Find lease expiry / decision timing for ${i.subjectName}`);
  for (const r of i.radar) for (const e of r.enrichment) if (!enrichment.includes(e.reason)) enrichment.push(e.reason);

  return {
    version: SCORE_VERSION, subjectId: i.subjectId, total, rawTotal, components, tier, overrides, evidenceConfidence, warmth,
    flags: { deadlineWithin90: t.deadlineVerified, statusNeedsConfirmation: t.expiredOnly, needsEnrichment: enrichment.length > 0, unverifiedDates: t.unverified },
    enrichment,
    nextDeadline: t.deadline,
  };
}

/** One-line "why" for UI cards. */
export function explain(r: ScoreResult): string {
  const top = (Object.keys(r.components) as ComponentKey[])
    .filter((k) => r.components[k].points > 0)
    .sort((a, b) => r.components[b].points - r.components[a].points)
    .slice(0, 3)
    .map((k) => `${COMPONENT_LABEL[k]} ${r.components[k].points}/${r.components[k].max} (${r.components[k].band})`);
  const ov = r.overrides.length ? ` · overrides: ${r.overrides.join(", ")}` : "";
  return `${r.total}/100 — ${top.join("; ") || "no scoring evidence"}${ov}`;
}
