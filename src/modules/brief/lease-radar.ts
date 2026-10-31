/**
 * Lease radar (spec Part I §8 "Lease radar", "Notice-period reverse planning", Part III date rules).
 * PURE: no DB. Deterministic date arithmetic only (rule S5).
 *
 * Rules enforced here:
 *  - contractual expiry, lock-in end, notice deadline and break are SEPARATE facts; lock-in is never used as expiry.
 *  - integer-month tenure -> expiry = EDATE(start, months) (month-end clamp, same as the source spreadsheets' EDATE);
 *    fractional tenure is quarantined (no date invented).
 *  - a notice deadline needs notice length + day rule (business/calendar) + an expiry/break basis; we never subtract an
 *    assumed notice period. Derived notice deadlines are labelled "calculated", never "contractual".
 *  - an expired lease is "status needs confirmation", not a hot lead.
 *  - missing dates -> enrichment issue (the caller turns it into a task), never a fabricated expiry.
 */
import { addDays, daysBetween, edate, minDate, quarterKey, subtractBusinessDays } from "./dates";
import { BRIEF_DEFAULTS, type ReversePlanSettings } from "./settings";

export const RADAR_ENGINE_VERSION = "radar-v1";

export type DateBasis = "contractual" | "calculated_from_source_tenure" | "source_formula_cached" | "reported" | "estimated" | "calculated_by_radar";

export const DATE_BASIS_LABEL: Record<DateBasis, string> = {
  contractual: "Contractual",
  calculated_from_source_tenure: "Calculated from source tenure",
  source_formula_cached: "Source formula (cached value)",
  reported: "Reported",
  estimated: "Estimated",
  calculated_by_radar: "Calculated by radar",
};

export interface LeaseInput {
  id: string;
  tenantOrgId: string | null;
  tenantName: string | null;
  landlordOrgId?: string | null;
  landlordName?: string | null;
  assetId?: string | null;
  assetName?: string | null;
  areaSf?: number | null;
  startDate?: string | null;
  startPrecision?: string | null;
  tenureMonthsRaw?: number | null;
  lockinMonthsRaw?: number | null;
  contractualExpiry?: string | null;
  status?: string | null;
  /** Escalation terms stated in a linked lease document clause (stated values only; never inferred). */
  escalationTerms?: EscalationTerm[];
}

export interface EscalationTerm {
  clauseId: string;
  documentId: string | null;
  percent: number | null;
  everyMonths: number | null;   // already converted from years by the loader (×12, integer only)
  needsReview?: boolean;
  excerpt?: string | null;
}

export interface LeaseEventInput {
  id: string;
  leaseId: string;
  eventType: "expiry" | "lockin_end" | "notice_deadline" | "break" | "escalation" | "option";
  eventDate: string | null;
  dateBasis: Exclude<DateBasis, "calculated_by_radar">;
  noticeDays?: number | null;
  noticeDayRule?: string | null; // 'business' | 'calendar'
  confirmed?: boolean;
  needsReview?: boolean;
  reviewReason?: string | null;
  formulaRaw?: string | null;
}

export interface DatedFact {
  date: string;
  basis: DateBasis;
  basisLabel: string;
  verified: boolean;     // confirmed, or a documentary/source-derived basis without a review flag
  confirmed: boolean;    // explicitly confirmed by the user/document
  source: "event" | "lease_field" | "radar";
  eventId?: string;
  formula?: string;
  inputs?: Record<string, unknown>;
  detail?: string;
  sourceClauseId?: string;
}

/** A radar-calculated date to persist as a lease_event row (calc_key, date_basis calculated_by_radar, confirmed=false). */
export interface CalculatedEvent {
  calcKey: string;
  leaseId: string;
  eventType: "expiry" | "lockin_end" | "notice_deadline" | "escalation";
  date: string;
  formula: string;
  inputs: Record<string, unknown>;
  sourceClauseId: string | null;
}

export interface ReviewFlag { key: string; eventId: string | null; eventType: string; date: string | null; reason: string }

export interface PlanMilestone { key: "options_start" | "decision_by" | "procurement_start" | "fitout_start" | "notice_deadline"; label: string; date: string }

export interface ReversePlan {
  occupation: string;
  occupationBasis: "requirement" | "expiry";
  moveBy: string;
  fitoutStart: string;
  fitoutMonths: number;
  procurementStart: string;   // LOI/documentation/approvals must start by
  decisionBy: string;         // site decision
  optionsStart: string;       // options/visits must begin
  noticeDeadline: string | null;
  lastDecision: string;       // min(decisionBy, notice deadline)
  viable: boolean;            // lastDecision is today or later
}

export interface CallWindow {
  opens: string;
  closes: string;
  state: "upcoming" | "open" | "closing" | "missed";
}

export type RadarStatus = "active" | "expired_needs_confirmation" | "dates_unknown" | "quarantined";

export interface RadarItem {
  leaseId: string;
  tenantOrgId: string | null;
  tenantName: string | null;
  landlordName: string | null;
  assetId: string | null;
  assetName: string | null;
  areaSf: number | null;
  expiry: DatedFact | null;
  lockinEnd: DatedFact | null;
  noticeDeadline: DatedFact | null;
  breaks: DatedFact[];
  escalations: DatedFact[];     // rent escalation events — their own event type
  options: DatedFact[];         // renewal/extension option events
  reviewFlags: ReviewFlag[];    // ambiguous clauses / unverified events needing human review
  calculated: CalculatedEvent[]; // radar-calculated dates to persist (distinct from verified/imported events)
  status: RadarStatus;
  issues: string[];
  enrichment: { reason: string; key: string }[]; // become idempotent enrichment tasks
  plan: ReversePlan | null;
  callWindow: CallWindow | null;
  daysToExpiry: number | null;
  daysToNotice: number | null;
  nextKeyDate: string | null; // earliest upcoming of notice / break / expiry
}

/** Spec Part I §3: "Expiry arithmetic is not documentary verification" — only contractual (or confirmed) dates are verified. */
const VERIFIED_BASES = new Set<DateBasis>(["contractual"]);

function fact(e: LeaseEventInput): DatedFact {
  return {
    date: e.eventDate!,
    basis: e.dateBasis,
    basisLabel: DATE_BASIS_LABEL[e.dateBasis] + (e.confirmed ? " · confirmed" : ""),
    verified: !!e.confirmed || (VERIFIED_BASES.has(e.dateBasis) && !e.needsReview),
    confirmed: !!e.confirmed,
    source: "event",
    eventId: e.id,
    formula: e.formulaRaw ?? undefined,
    detail: e.needsReview ? `needs review${e.reviewReason ? `: ${e.reviewReason}` : ""}` : undefined,
  };
}

const BASIS_RANK: Record<DateBasis, number> = {
  contractual: 0, calculated_from_source_tenure: 2, source_formula_cached: 3, calculated_by_radar: 4, reported: 5, estimated: 6,
};

/** Best event of a type: confirmed first, then contractual, then derived, then reported/estimated. */
function pickEvent(events: LeaseEventInput[], type: LeaseEventInput["eventType"]): LeaseEventInput | null {
  const c = events.filter((e) => e.eventType === type && e.eventDate);
  c.sort((a, b) => Number(!!b.confirmed) - Number(!!a.confirmed) || BASIS_RANK[a.dateBasis] - BASIS_RANK[b.dateBasis] || (a.eventDate! < b.eventDate! ? -1 : 1));
  return c[0] ?? null;
}

export function isIntegerMonths(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

export function fitoutMonthsFor(areaSf: number | null | undefined, s: ReversePlanSettings): number {
  if (areaSf == null) return s.fitoutMonthsBySize[Math.min(1, s.fitoutMonthsBySize.length - 1)].months; // unknown size -> typical mid band
  for (const b of s.fitoutMonthsBySize) if (b.maxSf === null || areaSf <= b.maxSf) return b.months;
  return s.fitoutMonthsBySize[s.fitoutMonthsBySize.length - 1].months;
}

/** Work backwards from occupation (spec: "working backwards from occupation, not just expiry"). */
export function reversePlan(opts: {
  occupation: string;
  occupationBasis: "requirement" | "expiry";
  areaSf?: number | null;
  noticeDeadline?: string | null;
  today: string;
  settings?: ReversePlanSettings;
}): ReversePlan {
  const s = opts.settings ?? BRIEF_DEFAULTS.reversePlan;
  const fitoutMonths = fitoutMonthsFor(opts.areaSf, s);
  const moveBy = addDays(opts.occupation, -s.moveBufferDays);
  const fitoutStart = edate(moveBy, -fitoutMonths);
  const procurementStart = edate(fitoutStart, -s.procurementMonths);
  const decisionBy = procurementStart;
  const optionsStart = edate(decisionBy, -s.decisionMonths);
  const lastDecision = minDate(decisionBy, opts.noticeDeadline ?? null)!;
  return {
    occupation: opts.occupation, occupationBasis: opts.occupationBasis, moveBy, fitoutStart, fitoutMonths,
    procurementStart, decisionBy, optionsStart, noticeDeadline: opts.noticeDeadline ?? null, lastDecision,
    viable: lastDecision >= opts.today,
  };
}

export function callWindowFor(plan: ReversePlan, today: string, s: ReversePlanSettings = BRIEF_DEFAULTS.reversePlan): CallWindow {
  const opens = edate(plan.optionsStart, -s.engagementLeadMonths);
  const closes = plan.lastDecision;
  let state: CallWindow["state"];
  if (today > closes) state = "missed";
  else if (today < opens) state = "upcoming";
  else if (daysBetween(today, closes) <= 30) state = "closing";
  else state = "open";
  return { opens, closes, state };
}

/** Derive the radar view of one lease from its fields and events. */
export function analyseLease(
  lease: LeaseInput,
  events: LeaseEventInput[],
  today: string,
  opts: { settings?: ReversePlanSettings; occupationOverride?: string | null } = {},
): RadarItem {
  const issues: string[] = [];
  const enrichment: RadarItem["enrichment"] = [];
  const ev = events.filter((e) => e.leaseId === lease.id);

  // ---- expiry (never from lock-in)
  const expiryCandidates: DatedFact[] = [];
  const expEvent = pickEvent(ev, "expiry");
  if (expEvent) expiryCandidates.push(fact(expEvent));
  if (lease.contractualExpiry) {
    expiryCandidates.push({ date: lease.contractualExpiry, basis: "contractual", basisLabel: DATE_BASIS_LABEL.contractual, verified: true, confirmed: false, source: "lease_field" });
  }
  expiryCandidates.sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || BASIS_RANK[a.basis] - BASIS_RANK[b.basis]);
  let expiry: DatedFact | null = expiryCandidates[0] ?? null;
  const tenure = lease.tenureMonthsRaw;
  let calculated: string | null = null;
  if (tenure != null && lease.startDate) {
    if (isIntegerMonths(tenure)) {
      calculated = edate(lease.startDate, tenure);
      if (lease.startPrecision && lease.startPrecision !== "day" && lease.startPrecision !== "unknown") {
        issues.push(`Start date precision is ${lease.startPrecision}; calculated dates inherit that uncertainty.`);
      }
    } else {
      issues.push(`Fractional tenure (${tenure} months) quarantined — interpret the source before calculating expiry.`);
      enrichment.push({ reason: `Confirm tenure for ${lease.tenantName ?? "lease"} (source shows ${tenure} months)`, key: "fractional_tenure" });
    }
  }
  if (!expiry && calculated) {
    expiry = {
      date: calculated, basis: "calculated_by_radar", basisLabel: DATE_BASIS_LABEL.calculated_by_radar, verified: false, confirmed: false, source: "radar",
      formula: `EDATE(${lease.startDate}, ${tenure})`, inputs: { start_date: lease.startDate, tenure_months: tenure, lease_id: lease.id },
    };
  } else if (expiry && calculated && expiry.date !== calculated && expiry.basis !== "estimated" && expiry.basis !== "reported") {
    issues.push(`Calculated expiry ${calculated} (EDATE(start, ${tenure})) differs from ${expiry.basisLabel.toLowerCase()} ${expiry.date}; ${expiry.basisLabel.toLowerCase()} kept.`);
  }

  // ---- lock-in (separate)
  let lockinEnd: DatedFact | null = null;
  const lockEvent = pickEvent(ev, "lockin_end");
  if (lockEvent) lockinEnd = fact(lockEvent);
  else if (lease.startDate && lease.lockinMonthsRaw != null) {
    if (isIntegerMonths(lease.lockinMonthsRaw)) {
      lockinEnd = {
        date: edate(lease.startDate, lease.lockinMonthsRaw), basis: "calculated_by_radar", basisLabel: DATE_BASIS_LABEL.calculated_by_radar,
        verified: false, confirmed: false, source: "radar", formula: `EDATE(${lease.startDate}, ${lease.lockinMonthsRaw})`,
        inputs: { start_date: lease.startDate, lockin_months: lease.lockinMonthsRaw, lease_id: lease.id },
      };
    } else {
      issues.push(`Fractional lock-in (${lease.lockinMonthsRaw} months) quarantined.`);
    }
  }

  // ---- breaks
  const byDate = (a: DatedFact, b: DatedFact) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const breaks = ev.filter((e) => e.eventType === "break" && e.eventDate).map(fact).sort(byDate);
  const options = ev.filter((e) => e.eventType === "option" && e.eventDate).map(fact).sort(byDate);

  // ---- review flags: ambiguous clauses / events explicitly marked for review
  const reviewFlags: ReviewFlag[] = ev.filter((e) => e.needsReview).map((e) => ({
    key: `event:${e.id}`, eventId: e.id, eventType: e.eventType, date: e.eventDate,
    reason: e.reviewReason?.trim() || `${e.eventType.replace(/_/g, " ")} event flagged for review (no reason recorded)`,
  }));
  for (const e of ev.filter((x) => !x.eventDate && !x.needsReview)) {
    reviewFlags.push({ key: `event:${e.id}`, eventId: e.id, eventType: e.eventType, date: null, reason: `${e.eventType.replace(/_/g, " ")} event has no date — clause needs interpretation` });
  }

  // ---- notice deadline: explicit event, else derived only when length + day rule + basis exist
  let noticeDeadline: DatedFact | null = null;
  const noticeEvent = pickEvent(ev, "notice_deadline");
  if (noticeEvent) noticeDeadline = fact(noticeEvent);
  else {
    const withNotice = ev.filter((e) => (e.eventType === "expiry" || e.eventType === "break") && e.eventDate && e.noticeDays != null && e.noticeDays > 0);
    const derived: DatedFact[] = [];
    for (const e of withNotice) {
      const rule = (e.noticeDayRule ?? "").toLowerCase();
      if (rule !== "business" && rule !== "calendar") {
        issues.push(`Notice length ${e.noticeDays} days on ${e.eventType} event has no business/calendar day rule — notice deadline not calculated.`);
        continue;
      }
      const d = rule === "business" ? subtractBusinessDays(e.eventDate!, e.noticeDays!) : addDays(e.eventDate!, -e.noticeDays!);
      derived.push({
        date: d, basis: "calculated_by_radar", basisLabel: `${DATE_BASIS_LABEL.calculated_by_radar} (${e.eventType} − ${e.noticeDays} ${rule} days)`,
        verified: fact(e).verified, confirmed: false, source: "radar", formula: `${e.eventType} ${e.eventDate} − ${e.noticeDays} ${rule} days`,
        inputs: { base_event_id: e.id, base_event_type: e.eventType, base_date: e.eventDate, notice_days: e.noticeDays, day_rule: rule, lease_id: lease.id },
      });
    }
    const upcoming = derived.filter((d) => d.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
    noticeDeadline = upcoming[0] ?? derived.sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null;
  }

  // ---- rent escalation (its own event type): recorded events first; otherwise calculated from a stated clause term
  let escalations: DatedFact[] = ev.filter((e) => e.eventType === "escalation" && e.eventDate).map(fact).sort(byDate);
  for (const t of lease.escalationTerms ?? []) {
    if (t.needsReview) reviewFlags.push({ key: `clause:${t.clauseId}`, eventId: null, eventType: "escalation", date: null, reason: `Escalation clause needs review${t.excerpt ? `: “${t.excerpt.slice(0, 140)}”` : ""}` });
  }
  if (escalations.length === 0 && lease.escalationTerms?.length) {
    const t = lease.escalationTerms.find((x) => isIntegerMonths(x.everyMonths)) ?? null;
    if (!t) {
      reviewFlags.push({ key: `clause:${lease.escalationTerms[0].clauseId}:frequency`, eventId: null, eventType: "escalation", date: null, reason: "Escalation clause found but its frequency is not stated — escalation dates not calculated" });
    } else if (!lease.startDate) {
      issues.push("Escalation term known but the lease start date is unknown — escalation dates not calculated.");
    } else if (!expiry) {
      issues.push("Escalation term known but the lease term/expiry is unknown — escalation dates not calculated.");
    } else {
      const every = t.everyMonths!;
      const pct = t.percent;
      for (let k = 1; k <= 40; k++) {
        const d = edate(lease.startDate, k * every);
        if (d >= expiry.date) break;
        escalations.push({
          date: d, basis: "calculated_by_radar", basisLabel: DATE_BASIS_LABEL.calculated_by_radar, verified: false, confirmed: false, source: "radar",
          formula: `EDATE(${lease.startDate}, ${k} × ${every})`, detail: pct != null ? `+${pct}% (stated)` : "rate not stated",
          inputs: { start_date: lease.startDate, every_months: every, step: k, percent: pct, clause_id: t.clauseId, document_id: t.documentId, lease_id: lease.id },
          sourceClauseId: t.clauseId,
        });
      }
    }
  }
  escalations = escalations.sort(byDate);

  // ---- status
  let status: RadarStatus = "active";
  if (!expiry) {
    if (tenure != null && !isIntegerMonths(tenure)) status = "quarantined";
    else {
      status = "dates_unknown";
      if (lockinEnd) issues.push("Only a lock-in end is known — it is not an expiry or notice deadline.");
      enrichment.push({ reason: `Find lease expiry for ${lease.tenantName ?? "tenant"}${lease.assetName ? ` at ${lease.assetName}` : ""} (no contractual or calculable date)`, key: "missing_expiry" });
    }
  } else if (expiry.date < today) {
    status = "expired_needs_confirmation";
    enrichment.push({ reason: `Confirm current status of ${lease.tenantName ?? "tenant"}${lease.assetName ? ` at ${lease.assetName}` : ""} — lease expired ${expiry.date} (renewed, moved or holding over?)`, key: "expired_status" });
  }

  // ---- reverse plan + call window (only for active leases or an explicit occupation date)
  let plan: ReversePlan | null = null;
  let callWindow: CallWindow | null = null;
  const occupation = opts.occupationOverride ?? (status === "active" ? expiry!.date : null);
  if (occupation) {
    const nd = noticeDeadline && noticeDeadline.date >= today ? noticeDeadline.date : null;
    plan = reversePlan({ occupation, occupationBasis: opts.occupationOverride ? "requirement" : "expiry", areaSf: lease.areaSf, noticeDeadline: nd, today, settings: opts.settings });
    callWindow = callWindowFor(plan, today, opts.settings);
  }

  const upcomingKey = [noticeDeadline?.date, ...breaks.map((b) => b.date), ...options.map((o) => o.date), ...escalations.map((e) => e.date), expiry?.date].filter((d): d is string => !!d && d >= today).sort();

  // ---- radar-calculated dates to persist (reproducible: same inputs -> same keys and values)
  const calculatedEvents: CalculatedEvent[] = [];
  const persist = (key: string, type: CalculatedEvent["eventType"], f: DatedFact | null) => {
    if (f && f.source === "radar" && f.formula) calculatedEvents.push({ calcKey: `radar:${lease.id}:${key}`, leaseId: lease.id, eventType: type, date: f.date, formula: f.formula, inputs: f.inputs ?? {}, sourceClauseId: f.sourceClauseId ?? null });
  };
  persist("expiry", "expiry", expiry);
  persist("lockin_end", "lockin_end", lockinEnd);
  persist("notice_deadline", "notice_deadline", noticeDeadline);
  escalations.forEach((e) => persist(`escalation:${(e.inputs?.step as number | undefined) ?? e.date}`, "escalation", e));

  return {
    leaseId: lease.id,
    tenantOrgId: lease.tenantOrgId,
    tenantName: lease.tenantName,
    landlordName: lease.landlordName ?? null,
    assetId: lease.assetId ?? null,
    assetName: lease.assetName ?? null,
    areaSf: lease.areaSf ?? null,
    expiry, lockinEnd, noticeDeadline, breaks, escalations, options, reviewFlags, calculated: calculatedEvents, status, issues, enrichment, plan, callWindow,
    daysToExpiry: expiry ? daysBetween(today, expiry.date) : null,
    daysToNotice: noticeDeadline ? daysBetween(today, noticeDeadline.date) : null,
    nextKeyDate: upcomingKey[0] ?? null,
  };
}

export function runRadar(leases: LeaseInput[], events: LeaseEventInput[], today: string, settings?: ReversePlanSettings): RadarItem[] {
  const byLease = new Map<string, LeaseEventInput[]>();
  for (const e of events) {
    const l = byLease.get(e.leaseId) ?? [];
    l.push(e);
    byLease.set(e.leaseId, l);
  }
  return leases.map((l) => analyseLease(l, byLease.get(l.id) ?? [], today, { settings }));
}

// ------------------------------------------------------------------ filters & aggregation

export type RadarWindow = "0-3" | "3-12" | "12-24" | "notice-90" | "expired" | "unknown" | "all";

export const WINDOW_LABEL: Record<RadarWindow, string> = {
  "0-3": "Expiring in 0–3 months",
  "3-12": "Expiring in 3–12 months",
  "12-24": "Expiring in 12–24 months",
  "notice-90": "Notice deadline within 90 days",
  expired: "Expired — status needs confirmation",
  unknown: "Dates unknown / quarantined",
  all: "All leases",
};

export function inWindow(item: RadarItem, w: RadarWindow, today: string): boolean {
  const exp = item.expiry?.date;
  switch (w) {
    case "all": return true;
    case "expired": return item.status === "expired_needs_confirmation";
    case "unknown": return item.status === "dates_unknown" || item.status === "quarantined";
    case "notice-90": return item.daysToNotice != null && item.daysToNotice >= 0 && item.daysToNotice <= 90;
    default: {
      if (!exp || item.status !== "active") return false;
      const [a, b] = w.split("-").map(Number);
      const lower = a === 0 ? today : edate(today, a);
      return exp >= lower && exp < edate(today, b);
    }
  }
}

export interface ConcentrationRow {
  key: string;
  building: string;
  landlord: string | null;
  quarter: string;
  leases: number;
  areaSf: number;
  tenants: string[];
}

/** Landlord retention/expiry concentration: documented events by building and quarter. */
export function landlordConcentration(items: RadarItem[], today: string, horizonMonths = 24): ConcentrationRow[] {
  const horizon = edate(today, horizonMonths);
  const map = new Map<string, ConcentrationRow>();
  for (const it of items) {
    const d = it.expiry?.date;
    if (!d || d < today || d > horizon) continue;
    const building = it.assetName ?? "Unknown building";
    const q = quarterKey(d);
    const key = `${it.assetId ?? building}|${q}`;
    const row = map.get(key) ?? { key, building, landlord: it.landlordName, quarter: q, leases: 0, areaSf: 0, tenants: [] };
    row.leases++;
    row.areaSf += it.areaSf ?? 0;
    if (it.tenantName && !row.tenants.includes(it.tenantName)) row.tenants.push(it.tenantName);
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.leases - a.leases || b.areaSf - a.areaSf || a.quarter.localeCompare(b.quarter));
}

/** Reverse-plan milestones (decision, procurement, fit-out start, notice) to turn into dated tasks. */
export function planMilestones(item: Pick<RadarItem, "plan" | "status">): PlanMilestone[] {
  const p = item.plan;
  if (!p || item.status !== "active") return [];
  const out: PlanMilestone[] = [
    { key: "options_start", label: "Start options / site visits", date: p.optionsStart },
    { key: "decision_by", label: "Site decision", date: p.decisionBy },
    { key: "procurement_start", label: "Start LOI / documentation / approvals", date: p.procurementStart },
    { key: "fitout_start", label: "Fit-out must start", date: p.fitoutStart },
  ];
  if (p.noticeDeadline) out.push({ key: "notice_deadline", label: "Serve / decide notice", date: p.noticeDeadline });
  return out;
}

/** Upcoming rent escalation / option events within `days` (for alerts and the brief). */
export function upcomingEventFacts(item: RadarItem, today: string, days: number): { kind: "escalation" | "option"; fact: DatedFact; days: number }[] {
  const out: { kind: "escalation" | "option"; fact: DatedFact; days: number }[] = [];
  for (const [kind, list] of [["escalation", item.escalations], ["option", item.options]] as const) {
    for (const f of list) {
      const d = daysBetween(today, f.date);
      if (d >= 0 && d <= days) out.push({ kind, fact: f, days: d });
    }
  }
  return out.sort((a, b) => a.days - b.days);
}
