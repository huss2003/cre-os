/**
 * Revenue Controller (workflow 21) — pure, decimal maths. Every amount carries its OWN stage and status and a
 * transaction link (opportunity + fee milestone). Forecast (expected) fees are never added to invoiced, recognised or
 * collected totals. Unknown stays unknown (null), never 0.
 */
import Decimal from "decimal.js";
import type { FeeMilestoneRow } from "./fees";

export const MONEY_STAGES = ["expected", "contractual", "attributed", "invoiced", "recognised", "collected"] as const;
export type MoneyStage = (typeof MONEY_STAGES)[number];
export const MONEY_STAGE_LABEL: Record<MoneyStage, string> = {
  expected: "Expected (forecast)", contractual: "Contractual (agreed terms)", attributed: "Attributed / credited",
  invoiced: "Invoiced", recognised: "Recognised", collected: "Collected",
};
/** forecast: pipeline estimate only · agreed: signed fee terms · credited: attribution confirmed · computed: credit share × gross, not yet confirmed ·
 *  recorded: official event with date + evidence · missing_evidence: amount without evidence · unknown: inputs missing. */
export type MoneyStatus = "forecast" | "agreed" | "credited" | "computed" | "recorded" | "missing_evidence" | "unknown";

export interface FeeRowB extends FeeMilestoneRow {
  contractual_amount?: number | string | null; contract_ref?: string | null; attributed_on?: string | null; attribution_ref?: string | null;
  invoice_no?: string | null; invoice_due_on?: string | null; deal_milestone_id?: string | null;
}
export interface OppLite {
  id: string; name?: string | null; stage: string; outcome?: string | null; expected_fee?: number | string | null; credit_share?: number | string | null;
  expected_close?: string | null; crm_external_id?: string | null; created_at?: string | null;
}
export interface LedgerLine {
  stage: MoneyStage; status: MoneyStatus; amount: string | null; date: string | null; reference: string | null;
  transaction: { opportunityId: string; feeMilestoneId: string | null; crmId: string | null; invoiceNo: string | null };
  label: string;
}

const D = (x: unknown) => (x === null || x === undefined || x === "" ? null : new Decimal(x as string));
const f2 = (x: Decimal) => x.toDecimalPlaces(2).toFixed(2);

/** One line per money stage per fee milestone (plus the opportunity-level expected fee). */
export function feeLedger(opp: OppLite, rows: (FeeRowB & { id?: string })[]): LedgerLine[] {
  const tx = (r?: FeeRowB & { id?: string }) => ({ opportunityId: opp.id, feeMilestoneId: r?.id ?? null, crmId: opp.crm_external_id ?? null, invoiceNo: r?.invoice_no ?? null });
  const out: LedgerLine[] = [];
  const exp = D(opp.expected_fee);
  out.push({ stage: "expected", status: exp ? "forecast" : "unknown", amount: exp ? f2(exp) : null, date: opp.expected_close ?? null, reference: "opportunity expected fee", transaction: tx(), label: opp.name ?? "opportunity" });
  for (const r of rows) {
    const label = r.milestone ?? "fee milestone";
    const ev = !!(r.evidence ?? "").trim();
    const c = D(r.contractual_amount);
    out.push({ stage: "contractual", status: c ? "agreed" : "unknown", amount: c ? f2(c) : null, date: null, reference: r.contract_ref ?? null, transaction: tx(r), label });
    const g = D(r.gross_fee), share = D(r.credit_share) ?? D(opp.credit_share);
    const credited = g && share ? g.times(share) : null;
    out.push({ stage: "attributed", status: !credited ? "unknown" : r.attributed_on ? "credited" : "computed", amount: credited ? f2(credited) : null,
      date: r.attributed_on ?? null, reference: r.attribution_ref ?? null, transaction: tx(r), label });
    for (const [stage, amt, date] of [["invoiced", r.invoiced_amount, r.invoiced_on], ["recognised", r.recognised_amount, r.recognised_on], ["collected", r.collected_amount, r.collected_on]] as const) {
      const a = D(amt);
      out.push({ stage, status: !a ? "unknown" : ev ? "recorded" : "missing_evidence", amount: a ? f2(a) : null, date: date ?? null,
        reference: stage === "invoiced" ? (r.invoice_no ?? null) : null, transaction: tx(r), label });
    }
  }
  return out;
}

export type LedgerTotals = Record<MoneyStage, { amount: string; unknownCount: number }>;
/** Totals per stage. Only lines of that stage are summed — a forecast can never appear under collected. */
export function ledgerTotals(lines: LedgerLine[]): LedgerTotals {
  const t = Object.fromEntries(MONEY_STAGES.map((s) => [s, { sum: new Decimal(0), unknownCount: 0 }])) as Record<MoneyStage, { sum: Decimal; unknownCount: number }>;
  for (const l of lines) {
    if (l.amount === null) { t[l.stage].unknownCount++; continue; }
    // collected / recognised / invoiced count only recorded official events
    if ((l.stage === "collected" || l.stage === "recognised" || l.stage === "invoiced") && l.status !== "recorded" && l.status !== "missing_evidence") continue;
    t[l.stage].sum = t[l.stage].sum.plus(l.amount);
  }
  return Object.fromEntries(MONEY_STAGES.map((s) => [s, { amount: f2(t[s].sum), unknownCount: t[s].unknownCount }])) as LedgerTotals;
}

// ---------------------------------------------------------------- receivables aging (needs invoice due dates)
export const AGING_BUCKETS = ["not_due", "1_30", "31_60", "61_90", "90_plus", "due_date_unknown"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export const AGING_LABEL: Record<AgingBucket, string> = { not_due: "Not yet due", "1_30": "1–30 days", "31_60": "31–60 days", "61_90": "61–90 days", "90_plus": "90+ days", due_date_unknown: "Due date unknown" };
export interface AgingItem { feeMilestoneId: string | null; opportunityId: string | null; invoiceNo: string | null; outstanding: string; dueOn: string | null; daysPastDue: number | null; bucket: AgingBucket }

export function receivablesAging(rows: (FeeRowB & { id?: string; opportunity_id?: string })[], asOf: string): { items: AgingItem[]; buckets: Record<AgingBucket, string>; total: string } {
  const sums = Object.fromEntries(AGING_BUCKETS.map((b) => [b, new Decimal(0)])) as Record<AgingBucket, Decimal>;
  const items: AgingItem[] = [];
  for (const r of rows) {
    const inv = D(r.invoiced_amount);
    if (!inv) continue;
    const outstanding = inv.minus(D(r.collected_amount) ?? 0);
    if (outstanding.lte(0)) continue;
    let bucket: AgingBucket, dpd: number | null = null;
    if (!r.invoice_due_on) bucket = "due_date_unknown";
    else {
      dpd = Math.round((Date.parse(asOf) - Date.parse(r.invoice_due_on)) / 86_400_000);
      bucket = dpd <= 0 ? "not_due" : dpd <= 30 ? "1_30" : dpd <= 60 ? "31_60" : dpd <= 90 ? "61_90" : "90_plus";
    }
    sums[bucket] = sums[bucket].plus(outstanding);
    items.push({ feeMilestoneId: r.id ?? null, opportunityId: r.opportunity_id ?? null, invoiceNo: r.invoice_no ?? null, outstanding: f2(outstanding), dueOn: r.invoice_due_on ?? null, daysPastDue: dpd, bucket });
  }
  const total = AGING_BUCKETS.reduce((a, b) => a.plus(sums[b]), new Decimal(0));
  return { items: items.sort((a, b) => (b.daysPastDue ?? -1e9) - (a.daysPastDue ?? -1e9)), buckets: Object.fromEntries(AGING_BUCKETS.map((b) => [b, f2(sums[b])])) as Record<AgingBucket, string>, total: f2(total) };
}

// ---------------------------------------------------------------- slippage (expected_close history)
export interface CloseChange { opportunity_id: string; old_expected_close: string | null; new_expected_close: string | null; changed_at: string }
export interface SlippageRow { opportunityId: string; name: string; stage: string; firstExpected: string | null; currentExpected: string | null; pushes: number; pullIns: number; slippedDays: number; passedWithoutClose: boolean; daysPastExpected: number | null }

const CLOSED_STAGES = new Set(["signed", "possession", "invoiced", "recognised", "collected"]);
export function slippageReport(opps: OppLite[], history: CloseChange[], asOf: string): { rows: SlippageRow[]; slippingCount: number; passedCount: number; totalSlippedDays: number } {
  const byOpp = new Map<string, CloseChange[]>();
  for (const h of [...history].sort((a, b) => a.changed_at.localeCompare(b.changed_at))) byOpp.set(h.opportunity_id, [...(byOpp.get(h.opportunity_id) ?? []), h]);
  const rows: SlippageRow[] = [];
  for (const o of opps) {
    const h = byOpp.get(o.id) ?? [];
    let pushes = 0, pullIns = 0, slipped = 0;
    for (const c of h) {
      if (!c.old_expected_close || !c.new_expected_close) continue;
      const d = Math.round((Date.parse(c.new_expected_close) - Date.parse(c.old_expected_close)) / 86_400_000);
      if (d > 0) { pushes++; slipped += d; } else if (d < 0) pullIns++;
    }
    const current = o.expected_close ?? null;
    const open = (o.outcome ?? "open") === "open" && !CLOSED_STAGES.has(o.stage);
    const passed = open && !!current && current < asOf;
    if (!pushes && !passed && !pullIns) continue;
    rows.push({ opportunityId: o.id, name: o.name ?? o.id, stage: o.stage, firstExpected: h.find((c) => c.new_expected_close)?.new_expected_close ?? current, currentExpected: current,
      pushes, pullIns, slippedDays: slipped, passedWithoutClose: passed, daysPastExpected: passed ? Math.round((Date.parse(asOf) - Date.parse(current!)) / 86_400_000) : null });
  }
  rows.sort((a, b) => Number(b.passedWithoutClose) - Number(a.passedWithoutClose) || b.slippedDays - a.slippedDays);
  return { rows, slippingCount: rows.filter((r) => r.pushes > 0).length, passedCount: rows.filter((r) => r.passedWithoutClose).length, totalSlippedDays: rows.reduce((a, r) => a + r.slippedDays, 0) };
}

// ---------------------------------------------------------------- cohort funnel from actual stage history
export const FUNNEL_STAGES = ["engaged", "qualified_discussion", "requirement_confirmed", "proposal_negotiation", "loi", "signed", "collected"] as const;
const ORDER = ["research", "approach_attempted", "engaged", "qualified_discussion", "requirement_confirmed", "options_visits", "proposal_negotiation", "loi", "documentation", "signed", "possession", "invoiced", "recognised", "collected"];
export interface StageHist { opportunity_id: string; to_stage: string; changed_at: string }
export interface CohortRow { cohort: string; opportunities: number; reached: Record<string, number>; conversionPct: Record<string, string | null>; won: number; lost: number }

/**
 * Cohort = calendar month (UTC) the opportunity first appears in its stage history (else created_at). "Reached" counts
 * opportunities whose history (or current stage) ever reached the stage; conversion % is relative to the cohort size.
 */
export function cohortFunnel(opps: OppLite[], history: StageHist[]): CohortRow[] {
  const first = new Map<string, string>(), maxIdx = new Map<string, number>();
  for (const h of history) {
    if (!first.has(h.opportunity_id) || h.changed_at < first.get(h.opportunity_id)!) first.set(h.opportunity_id, h.changed_at);
    maxIdx.set(h.opportunity_id, Math.max(maxIdx.get(h.opportunity_id) ?? -1, ORDER.indexOf(h.to_stage)));
  }
  const cohorts = new Map<string, CohortRow>();
  for (const o of opps) {
    const start = first.get(o.id) ?? o.created_at ?? null;
    if (!start) continue;
    const key = start.slice(0, 7);
    const row = cohorts.get(key) ?? { cohort: key, opportunities: 0, reached: Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 0])), conversionPct: {}, won: 0, lost: 0 };
    row.opportunities++;
    const reached = Math.max(maxIdx.get(o.id) ?? -1, ORDER.indexOf(o.stage));
    for (const s of FUNNEL_STAGES) if (reached >= ORDER.indexOf(s)) row.reached[s]++;
    if (o.outcome === "won") row.won++;
    if (o.outcome === "lost" || o.outcome === "disqualified") row.lost++;
    cohorts.set(key, row);
  }
  for (const r of cohorts.values()) for (const s of FUNNEL_STAGES)
    r.conversionPct[s] = r.opportunities ? new Decimal(r.reached[s]).div(r.opportunities).times(100).toDecimalPlaces(1).toFixed(1) : null;
  return [...cohorts.values()].sort((a, b) => b.cohort.localeCompare(a.cohort));
}
