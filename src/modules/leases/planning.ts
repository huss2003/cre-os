/**
 * Pure planning helpers: reminders (§14), portfolio aggregates (§12), opportunities (§13), cost overview (§8.3),
 * conflicts (§17.13), handover defaults (§11). No DB, no clock (today is passed in).
 */
import Decimal from "decimal.js";
import { addDays, daysBetween } from "./dates";

export interface DateRow {
  id: string; lease_id: string; date_type: string; label: string | null; calculated_date: string | null; verification_status: string;
  document_id: string | null; page: number | null; clause_text: string | null; method: string | null; superseded_by?: string | null; archived_at?: string | null;
}

// ------------------------------------------------------------------ reminders
export const DEFAULT_OFFSETS: Record<string, number[]> = {
  expiry: [365, 270, 180, 90],
  renewal_notice_deadline: [90, 60, 30],
  termination_notice_deadline: [90, 60, 30],
  break_option: [90, 60, 30],
  escalation: [60, 30],
  lockin_end: [90, 30],
  deposit_refund_deadline: [30, 7],
  handover: [30, 7],
};
export interface ReminderPlan { lease_id: string; lease_date_id: string; date_type: string; target_date: string; offset_days: number; remind_on: string; dedupe_key: string }

/**
 * Reminders come ONLY from dates a human has confirmed (verified) — calculated / needs_review dates do not drive
 * contractual reminders (they surface in the review queue instead). Dedupe key includes the date value, so a changed
 * date yields new keys and the old reminders become obsolete.
 */
export function planReminders(dates: DateRow[], offsets: Record<string, number[]> = DEFAULT_OFFSETS, today: string): ReminderPlan[] {
  const out: ReminderPlan[] = [];
  for (const d of dates) {
    if (d.verification_status !== "confirmed" || !d.calculated_date || d.superseded_by || d.archived_at) continue;
    for (const off of offsets[d.date_type] ?? []) {
      const on = addDays(d.calculated_date, -off);
      if (d.calculated_date < today) continue;
      out.push({ lease_id: d.lease_id, lease_date_id: d.id, date_type: d.date_type, target_date: d.calculated_date, offset_days: off, remind_on: on < today ? today : on,
        dedupe_key: `lease_rem:${d.lease_id}:${d.date_type}:${d.calculated_date}:${off}` });
    }
  }
  return out;
}

// ------------------------------------------------------------------ conflicts
/** Same date type with different values from different documents → conflicting (never resolved by code). */
export function findConflicts(dates: DateRow[]): { date_type: string; ids: string[]; values: string[] }[] {
  const by = new Map<string, DateRow[]>();
  for (const d of dates) if (!d.archived_at && !d.superseded_by && d.calculated_date && d.document_id) by.set(d.date_type, [...(by.get(d.date_type) ?? []), d]);
  const out: { date_type: string; ids: string[]; values: string[] }[] = [];
  for (const [t, rows] of by) {
    if (["escalation", "other"].includes(t)) continue;
    const docs = new Set(rows.map((r) => r.document_id));
    const vals = [...new Set(rows.map((r) => r.calculated_date!))];
    if (docs.size > 1 && vals.length > 1) out.push({ date_type: t, ids: rows.map((r) => r.id), values: vals });
  }
  return out;
}

// ------------------------------------------------------------------ portfolio
export interface PortfolioLease {
  id: string; lifecycle_status: string; area_sf: number | null; area_basis: string | null; monthly_rent: number | null; currency?: string | null;
  missing: string[];
}
export interface Portfolio {
  activeCount: number; byStatus: Record<string, number>;
  leasedArea: { total: string | null; basis: string | null; included: number; excluded: { id: string; reason: string }[] };
  monthlyRent: { total: string | null; included: number; excluded: { id: string; reason: string }[] };
  annualRent: string | null;
  incomplete: { id: string; missing: string[] }[];
}
const ACTIVEISH = ["executed", "active", "renewal_under_discussion", "renewal_agreed", "termination_notice_served", "expiring"];
/** Totals include only compatible, known values. Mixed area bases are not summed (dominant basis only, rest excluded). */
export function portfolio(leases: PortfolioLease[]): Portfolio {
  const act = leases.filter((l) => ACTIVEISH.includes(l.lifecycle_status));
  const byStatus: Record<string, number> = {};
  for (const l of leases) byStatus[l.lifecycle_status] = (byStatus[l.lifecycle_status] ?? 0) + 1;
  const bases = new Map<string, number>();
  for (const l of act) if (l.area_sf != null && l.area_basis) bases.set(l.area_basis, (bases.get(l.area_basis) ?? 0) + 1);
  const basis = [...bases.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  let area = new Decimal(0); let ai = 0; const aex: { id: string; reason: string }[] = [];
  let rent = new Decimal(0); let ri = 0; const rex: { id: string; reason: string }[] = [];
  for (const l of act) {
    if (l.area_sf == null) aex.push({ id: l.id, reason: "area unknown" });
    else if (!l.area_basis) aex.push({ id: l.id, reason: "area basis unknown" });
    else if (l.area_basis !== basis) aex.push({ id: l.id, reason: `different basis (${l.area_basis})` });
    else { area = area.add(l.area_sf); ai++; }
    if (l.monthly_rent == null) rex.push({ id: l.id, reason: "rent unknown" });
    else if (l.currency && l.currency !== "INR") rex.push({ id: l.id, reason: `currency ${l.currency}` });
    else { rent = rent.add(l.monthly_rent); ri++; }
  }
  return {
    activeCount: act.length, byStatus,
    leasedArea: { total: ai ? area.toFixed(2) : null, basis, included: ai, excluded: aex },
    monthlyRent: { total: ri ? rent.toFixed(2) : null, included: ri, excluded: rex },
    annualRent: ri ? rent.mul(12).toFixed(2) : null,
    incomplete: leases.filter((l) => l.missing.length).map((l) => ({ id: l.id, missing: l.missing })),
  };
}

// ------------------------------------------------------------------ cost overview
export interface CostInput { monthlyRent: number | null; camMonthly: number | null; parkingMonthly: number | null; otherMonthly: number | null; securityDeposit: number | null; expiry: string | null }
export function costOverview(c: CostInput, today: string) {
  const parts: [string, number | null][] = [["Rent", c.monthlyRent], ["CAM", c.camMonthly], ["Parking", c.parkingMonthly], ["Other recurring", c.otherMonthly]];
  const known = parts.filter(([, v]) => v != null) as [string, number][];
  const unknown = parts.filter(([, v]) => v == null).map(([k]) => k);
  const monthly = known.reduce((s, [, v]) => s.add(v), new Decimal(0));
  return {
    lines: parts.map(([label, v]) => ({ label, monthly: v == null ? null : new Decimal(v).toFixed(2), status: v == null ? "unknown" : "known" })),
    monthlyKnown: known.length ? monthly.toFixed(2) : null, annualKnown: known.length ? monthly.mul(12).toFixed(2) : null,
    unknown, complete: unknown.length === 0, securityDeposit: c.securityDeposit == null ? null : new Decimal(c.securityDeposit).toFixed(2),
    remainingMonths: c.expiry ? Math.max(0, Math.floor(daysBetween(today, c.expiry) / 30.4375)) : null,
    note: unknown.length ? `Known components only — ${unknown.join(", ")} unknown (not treated as zero).` : "All recurring components known.",
  };
}

// ------------------------------------------------------------------ opportunities
export interface OppLease { id: string; tenant_org_id: string | null; tenant_name: string | null; lifecycle_status: string }
export interface Opportunity { lease_id: string; org_id: string | null; kind: string; title: string; due: string | null; basis: string; label: "potential"; next_action: string; dedupe_key: string }
/**
 * Lease events → POTENTIAL advisory opportunities. Never a confirmed requirement / relocation (SPEC §13, rule 18).
 * Uses confirmed dates as "contractual", others are labelled "unverified" in `basis`.
 */
export function identifyOpportunities(leases: OppLease[], dates: DateRow[], today: string, horizonDays = 365): Opportunity[] {
  const out: Opportunity[] = [];
  const live = new Set(leases.filter((l) => !["expired", "terminated", "surrendered", "closed", "draft"].includes(l.lifecycle_status)).map((l) => l.id));
  for (const d of dates) {
    if (!live.has(d.lease_id) || !d.calculated_date || d.archived_at || d.superseded_by) continue;
    const days = daysBetween(today, d.calculated_date);
    if (days < 0 || days > horizonDays) continue;
    const l = leases.find((x) => x.id === d.lease_id)!;
    const who = l.tenant_name ?? "Tenant";
    const basis = d.verification_status === "confirmed" ? "confirmed contractual date" : `unverified (${d.verification_status}) date`;
    const mk = (kind: string, title: string, next: string) => out.push({ lease_id: d.lease_id, org_id: l.tenant_org_id, kind, title, due: d.calculated_date, basis, label: "potential", next_action: next, dedupe_key: `lease_opp:${d.lease_id}:${kind}:${d.calculated_date}` });
    if (d.date_type === "expiry") mk("expiry_approaching", `${who}: lease expiry on ${d.calculated_date} — potential renewal / relocation advisory`, "Review lease terms and ask the client about their plans (renewal vs relocation). Do not assume relocation.");
    if (d.date_type === "lockin_end") mk("lockin_completion", `${who}: lock-in completes ${d.calculated_date} — flexibility may increase`, "Check notice and termination conditions before discussing options.");
    if (d.date_type === "escalation") mk("rent_escalation", `${who}: rent escalation on ${d.calculated_date}`, "Check the escalation clause and prepare a cost view for the client.");
    if (d.date_type === "break_option") mk("break_option", `${who}: break option around ${d.calculated_date}`, "Review break eligibility conditions with the client.");
  }
  // multiple leases of one company expiring within 180 days of each other
  const exp = dates.filter((d) => d.date_type === "expiry" && d.calculated_date && live.has(d.lease_id) && !d.superseded_by && !d.archived_at);
  const byOrg = new Map<string, DateRow[]>();
  for (const d of exp) { const org = leases.find((l) => l.id === d.lease_id)?.tenant_org_id; if (org) byOrg.set(org, [...(byOrg.get(org) ?? []), d]); }
  for (const [org, rows] of byOrg) {
    const ids = new Set(rows.map((r) => r.lease_id));
    if (ids.size < 2) continue;
    const ds = rows.map((r) => r.calculated_date!).sort();
    if (daysBetween(ds[0], ds[ds.length - 1]) <= 180 && daysBetween(today, ds[0]) <= horizonDays * 2) {
      out.push({ lease_id: rows[0].lease_id, org_id: org, kind: "multi_lease_expiry", title: `${ids.size} leases of the same company expire between ${ds[0]} and ${ds[ds.length - 1]}`, due: ds[0], basis: "lease records", label: "potential", next_action: "Consider a portfolio consolidation conversation.", dedupe_key: `lease_opp:${org}:multi:${ds[0]}` });
    }
  }
  return out;
}

// ------------------------------------------------------------------ handover
export const DEFAULT_HANDOVER = [
  "Final property inspection", "Condition documentation", "Repair and restoration", "Removal of tenant assets", "Utility settlement",
  "Access card return", "Key return", "Outstanding payment review", "Security deposit reconciliation", "Final handover acknowledgement",
];
