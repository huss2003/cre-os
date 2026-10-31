/**
 * Insights — deterministic, descriptive metrics (spec Part I §12-13; §8 advanced additions). No predictive models.
 *
 * Approach (spec §12): the FIRST qualifying outreach actually made (an outbound interaction, not a draft) to a distinct
 * company. Follow-ups and drafts are not new approaches. Companies whose first contact was inbound are reported as a
 * separate channel, never disguised as cold approaches. Discussions/closures are cohort-linked to the approach month.
 */
import { median, percentile, monthKey } from "../common";
import { STAGES, stageIndex } from "../network/graph";

export const TARGETS = {
  base: { approaches: 120, discussions: 15, label: "1 closure / month" },
  pace: { approaches: 170, discussions: 21.25, label: "17 closures / year (₹5 cr pace)" },
} as const;

export interface Touch { org_id: string; person_id?: string | null; occurred_at: string; direction: string | null; kind: "interaction" | "draft" }
export interface OppLite { id: string; org_id: string; stage: string; outcome: string; outcome_reason?: string | null; created_at: string; stage_entered_at?: string | null }
export interface StageEvent { opportunity_id: string; to_stage: string; changed_at: string }

export interface CohortRow {
  month: string; approaches: number; inbound_first: number; people_touched: number; total_touches: number;
  discussions: number; closures: number; vs_base: number; vs_pace: number;
}

/** Highest stage index an opportunity has reached (current stage or any history entry). */
export function maxStageReached(opp: OppLite, events: StageEvent[]): number {
  let m = stageIndex(opp.stage);
  for (const e of events) if (e.opportunity_id === opp.id) m = Math.max(m, stageIndex(e.to_stage));
  return m;
}

export function cohortFunnel(touches: Touch[], opps: OppLite[], events: StageEvent[]): CohortRow[] {
  const actual = touches.filter((t) => t.kind === "interaction" && t.direction !== "internal");
  // first actual touch per org
  const first = new Map<string, Touch>();
  for (const t of [...actual].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))) if (!first.has(t.org_id)) first.set(t.org_id, t);
  const cohortOf = new Map<string, string>();
  const rows = new Map<string, CohortRow>();
  const row = (m: string) => {
    let r = rows.get(m);
    if (!r) { r = { month: m, approaches: 0, inbound_first: 0, people_touched: 0, total_touches: 0, discussions: 0, closures: 0, vs_base: 0, vs_pace: 0 }; rows.set(m, r); }
    return r;
  };
  for (const [org, t] of first) {
    const m = monthKey(t.occurred_at);
    if (t.direction === "outbound") { row(m).approaches++; cohortOf.set(org, m); }
    else row(m).inbound_first++;
  }
  // touches & people by calendar month (outbound actual only), counted separately from approaches
  const people = new Map<string, Set<string>>();
  for (const t of actual.filter((x) => x.direction === "outbound")) {
    const m = monthKey(t.occurred_at);
    row(m).total_touches++;
    if (t.person_id) { const s = people.get(m) ?? new Set(); s.add(t.person_id); people.set(m, s); }
  }
  for (const [m, s] of people) row(m).people_touched = s.size;
  // discussions / closures by cohort — distinct companies, not requirements
  const qIdx = stageIndex("qualified_discussion"), sIdx = stageIndex("signed");
  const discussedOrgs = new Set<string>(), closedOrgs = new Set<string>();
  for (const o of opps) {
    const mx = maxStageReached(o, events);
    if (mx >= qIdx) discussedOrgs.add(o.org_id);
    if (mx >= sIdx || o.outcome === "won") closedOrgs.add(o.org_id);
  }
  for (const org of discussedOrgs) { const m = cohortOf.get(org); if (m) row(m).discussions++; }
  for (const org of closedOrgs) { const m = cohortOf.get(org); if (m) row(m).closures++; }
  for (const r of rows.values()) {
    r.vs_base = Math.round((r.approaches / TARGETS.base.approaches) * 1000) / 10;
    r.vs_pace = Math.round((r.approaches / TARGETS.pace.approaches) * 1000) / 10;
  }
  return [...rows.values()].sort((a, b) => b.month.localeCompare(a.month));
}

export interface StageConversion { stage: string; reached: number; conversion_from_previous: number | null }
export function stageConversion(opps: OppLite[], events: StageEvent[]): StageConversion[] {
  const reached = STAGES.map(() => 0);
  for (const o of opps) { const mx = maxStageReached(o, events); for (let i = 0; i <= mx; i++) reached[i]++; }
  return STAGES.map((s, i) => ({ stage: s, reached: reached[i], conversion_from_previous: i === 0 || reached[i - 1] === 0 ? null : Math.round((reached[i] / reached[i - 1]) * 1000) / 10 }));
}

export interface TimeToStage { stage: string; n: number; median_days: number | null; p75_days: number | null; censored_open: number }
export function timeToStage(opps: OppLite[], events: StageEvent[], stages = ["engaged", "qualified_discussion", "requirement_confirmed", "proposal_negotiation", "loi", "signed"]): TimeToStage[] {
  return stages.map((st) => {
    const idx = stageIndex(st);
    const days: number[] = [];
    let censored = 0;
    for (const o of opps) {
      const evs = events.filter((e) => e.opportunity_id === o.id && stageIndex(e.to_stage) >= idx).sort((a, b) => a.changed_at.localeCompare(b.changed_at));
      const at = evs[0]?.changed_at ?? (stageIndex(o.stage) >= idx ? o.stage_entered_at ?? null : null);
      if (at) days.push(Math.max(0, Math.round((new Date(at).getTime() - new Date(o.created_at).getTime()) / 86_400_000)));
      else if (o.outcome === "open") censored++;
    }
    return { stage: st, n: days.length, median_days: median(days), p75_days: percentile(days, 75), censored_open: censored };
  });
}

export function lostReasons(opps: OppLite[]): { outcome: string; reason: string; count: number }[] {
  const m = new Map<string, { outcome: string; reason: string; count: number }>();
  for (const o of opps.filter((x) => ["lost", "disqualified", "dormant"].includes(x.outcome))) {
    const reason = (o.outcome_reason ?? "").trim() || "No reason coded";
    const k = `${o.outcome}|${reason.toLowerCase()}`;
    const cur = m.get(k) ?? { outcome: o.outcome, reason, count: 0 };
    cur.count++;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

// ------------------------------------------------------------------ landlord concentration & portfolio
export interface LeaseLite { id: string; tenant: string | null; tenant_org_id: string | null; landlord: string | null; building: string | null; area_sf: number | null; contractual_expiry: string | null; events: { event_type: string; event_date: string | null; confirmed: boolean }[] }

export function quarterOf(d: string): string { const m = Number(d.slice(5, 7)); return `${d.slice(0, 4)}-Q${Math.ceil(m / 3)}`; }

/** Documented lease events aggregated by landlord/building and quarter. Unknown landlord stays "Landlord unknown". */
export function landlordConcentration(leases: LeaseLite[], fromDate: string, toDate: string) {
  const out = new Map<string, { landlord: string; building: string; quarters: Map<string, { events: number; area_sf: number; area_unknown: number }> }>();
  for (const l of leases) {
    const dates = [...l.events.filter((e) => e.event_date).map((e) => e.event_date as string), ...(l.contractual_expiry ? [l.contractual_expiry] : [])];
    const uniq = [...new Set(dates)].filter((d) => d >= fromDate && d <= toDate);
    if (!uniq.length) continue;
    const landlord = l.landlord ?? "Landlord unknown", building = l.building ?? "Building unknown";
    const k = `${landlord}|${building}`;
    const cur = out.get(k) ?? { landlord, building, quarters: new Map() };
    const qs = new Set(uniq.map(quarterOf));
    for (const q of qs) {
      const c = cur.quarters.get(q) ?? { events: 0, area_sf: 0, area_unknown: 0 };
      c.events++;
      if (l.area_sf !== null) c.area_sf += l.area_sf; else c.area_unknown++;
      cur.quarters.set(q, c);
    }
    out.set(k, cur);
  }
  return [...out.values()].map((v) => ({ landlord: v.landlord, building: v.building, total_events: [...v.quarters.values()].reduce((s, q) => s + q.events, 0), quarters: [...v.quarters.entries()].sort().map(([quarter, q]) => ({ quarter, ...q })) }))
    .sort((a, b) => b.total_events - a.total_events);
}

export function portfolioView(leases: LeaseLite[], today: string) {
  const by = new Map<string, LeaseLite[]>();
  for (const l of leases) { const k = l.tenant_org_id ?? `raw:${l.tenant ?? "unknown"}`; by.set(k, [...(by.get(k) ?? []), l]); }
  return [...by.entries()].map(([key, ls]) => {
    const ladder = ls.map((l) => ({ lease_id: l.id, building: l.building ?? "Building unknown", area_sf: l.area_sf, expiry: l.contractual_expiry,
      next_event: l.events.filter((e) => e.event_date && e.event_date >= today).sort((a, b) => (a.event_date! < b.event_date! ? -1 : 1))[0] ?? null }))
      .sort((a, b) => (a.expiry ?? "9999").localeCompare(b.expiry ?? "9999"));
    const known = ls.filter((l) => l.area_sf !== null);
    return { key, tenant_org_id: ls[0].tenant_org_id, tenant: ls[0].tenant ?? "Tenant unknown", sites: ls.length,
      total_area_sf: known.length ? known.reduce((s, l) => s + (l.area_sf as number), 0) : null, area_unknown_sites: ls.length - known.length, ladder,
      consolidation_hint: ls.length >= 2 && new Set(ls.map((l) => l.contractual_expiry?.slice(0, 4))).size < ls.length ? "Two or more sites expire in the same year — consolidation question worth asking." : null };
  }).filter((p) => p.sites > 0).sort((a, b) => b.sites - a.sites);
}

// ------------------------------------------------------------------ procurement-cycle map
export const PROCUREMENT_STEPS = [
  { key: "vendor_onboarding", label: "Vendor onboarding", default_days: 30, role: "procurement" },
  { key: "rfp", label: "RFP / mandate", default_days: 21, role: "procurement" },
  { key: "comparative", label: "Comparative / shortlist", default_days: 21, role: "finance" },
  { key: "board_approval", label: "Board / budget approval", default_days: 30, role: "approver" },
  { key: "legal_review", label: "Legal review (LOI → lease)", default_days: 30, role: "legal" },
] as const;

export function procurementMap(opp: { id: string; name: string; stage: string }, req: { decision_date: string | null; constraints: Record<string, unknown> | null } | null, roles: string[]) {
  const proc = (req?.constraints?.procurement ?? req?.constraints?.procurement_process ?? null) as Record<string, unknown> | null;
  const steps = PROCUREMENT_STEPS.map((s) => {
    const recorded = proc && typeof proc === "object" ? proc[s.key] : undefined;
    const days = typeof recorded === "number" ? recorded : recorded && typeof recorded === "object" && typeof (recorded as { days?: unknown }).days === "number" ? Number((recorded as { days: number }).days) : null;
    return { ...s, lead_days: days ?? s.default_days, basis: days !== null ? "recorded" as const : "operating default — confirm with client" as const, owner_involved: roles.includes(s.role) };
  });
  const total = steps.reduce((t, s) => t + s.lead_days, 0);
  let latestStart: string | null = null;
  if (req?.decision_date) { const d = new Date(`${req.decision_date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - total); latestStart = d.toISOString().slice(0, 10); }
  return { opportunity_id: opp.id, name: opp.name, stage: opp.stage, decision_date: req?.decision_date ?? null, total_lead_days: total, latest_start: latestStart, steps };
}

// ------------------------------------------------------------------ experiments
export interface ExperimentLite { id: string; name: string; variants: { key: string; label: string }[]; outcome_window_days: number; min_sample_per_variant: number }
export interface SubjectLite { variant_key: string; exposed_at: string; outcome_at: string | null }

/** Only subjects whose full outcome window has elapsed are counted (identical windows); small samples are flagged. */
export function experimentSummary(e: ExperimentLite, subjects: SubjectLite[], now: Date) {
  const w = e.outcome_window_days * 86_400_000;
  const variants = e.variants.map((v) => {
    const mine = subjects.filter((s) => s.variant_key === v.key);
    const matured = mine.filter((s) => new Date(s.exposed_at).getTime() + w <= now.getTime());
    const hits = matured.filter((s) => s.outcome_at && new Date(s.outcome_at).getTime() - new Date(s.exposed_at).getTime() <= w).length;
    return { key: v.key, label: v.label, exposed: mine.length, matured: matured.length, outcomes: hits, rate: matured.length ? Math.round((hits / matured.length) * 1000) / 10 : null, pending: mine.length - matured.length };
  });
  const warnings: string[] = [];
  for (const v of variants) if (v.matured < e.min_sample_per_variant) warnings.push(`${v.label}: ${v.matured} matured subject(s) — below the minimum sample of ${e.min_sample_per_variant}; do not draw conclusions.`);
  if (variants.length < 2) warnings.push("An experiment needs at least two variants.");
  return { variants, warnings, conclusive: warnings.length === 0, note: "Descriptive comparison only; no significance test is claimed." };
}
