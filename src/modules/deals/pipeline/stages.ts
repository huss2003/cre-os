/**
 * Pipeline stage machine (spec Part I §8 "Stage transitions"), outcomes, closing checklist templates and funnel maths
 * (spec Part I §12). Pure and deterministic.
 */
import Decimal from "decimal.js";

export const STAGES = [
  "research", "approach_attempted", "engaged", "qualified_discussion", "requirement_confirmed", "options_visits",
  "proposal_negotiation", "loi", "documentation", "signed", "possession", "invoiced", "recognised", "collected",
] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<Stage, string> = {
  research: "Research", approach_attempted: "Approach attempted", engaged: "Engaged", qualified_discussion: "Qualified discussion",
  requirement_confirmed: "Requirement confirmed", options_visits: "Options / visits", proposal_negotiation: "Proposal / negotiation",
  loi: "LOI", documentation: "Documentation", signed: "Signed", possession: "Possession", invoiced: "Invoiced",
  recognised: "Recognised", collected: "Collected",
};
export const OUTCOMES = ["open", "dormant", "lost", "disqualified", "won"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const TEMPERATURES = ["cold", "warm", "hot"] as const;
export const MANDATES = ["none", "non_exclusive", "exclusive", "support", "unknown"] as const;
export const LOST_REASONS = [
  "competitor_broker", "direct_deal", "renewal_in_place", "no_move", "budget", "timing", "requirement_cancelled",
  "landlord_rejected", "option_not_available", "internal_approval_failed", "disqualified_fit", "other",
] as const;

export const stageIndex = (s: string) => STAGES.indexOf(s as Stage);

export interface TransitionContext {
  outcome?: string | null;
  requirementStatus?: string | null;      // linked requirement status
  evidence?: string | null;
  openBlockingMilestones?: { title: string; required_for_stage: string | null }[];
  fee?: { invoiced: boolean; recognised: boolean; collected: boolean };
}

/** Evidence required to enter stages a model/email cannot prove (spec: a positive email cannot prove a signed deal). */
export const EVIDENCE_STAGES: Stage[] = ["qualified_discussion", "requirement_confirmed", "loi", "signed", "possession", "invoiced", "recognised", "collected"];

export function checkTransition(from: string, to: string, c: TransitionContext): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const fi = stageIndex(from), ti = stageIndex(to);
  if (ti < 0) return { ok: false, reasons: [`unknown stage: ${to}`] };
  if (fi === ti) return { ok: false, reasons: ["already in this stage"] };
  if (c.outcome && c.outcome !== "open" && c.outcome !== "won") reasons.push(`opportunity is ${c.outcome}: reopen it before moving stages`);
  const ev = (c.evidence ?? "").trim();
  if (ti < fi && !ev) reasons.push("moving backwards needs a reason");
  if (ti > fi && EVIDENCE_STAGES.slice().some((s) => stageIndex(s) > fi && stageIndex(s) <= ti) && !ev)
    reasons.push(`entering "${STAGE_LABEL[to as Stage]}" needs evidence (who confirmed what, document or email reference)`);
  if (ti >= stageIndex("requirement_confirmed") && ti > fi && c.requirementStatus !== "client_confirmed")
    reasons.push("the linked requirement must be client-confirmed first");
  for (const m of c.openBlockingMilestones ?? []) {
    if (m.required_for_stage && stageIndex(m.required_for_stage) >= 0 && stageIndex(m.required_for_stage) <= ti && ti > fi)
      reasons.push(`closing item open: ${m.title} (needed before ${STAGE_LABEL[m.required_for_stage as Stage] ?? m.required_for_stage})`);
  }
  if (ti > fi && c.fee) {
    if (ti >= stageIndex("invoiced") && !c.fee.invoiced) reasons.push("record the invoice (amount, date, evidence) in Fees first");
    if (ti >= stageIndex("recognised") && !c.fee.recognised) reasons.push("record revenue recognition in Fees first");
    if (ti >= stageIndex("collected") && !c.fee.collected) reasons.push("record the collection in Fees first");
  }
  return { ok: reasons.length === 0, reasons };
}

export function checkOutcome(stage: string, outcome: string, reason?: string | null): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!(OUTCOMES as readonly string[]).includes(outcome)) reasons.push(`unknown outcome: ${outcome}`);
  if (outcome === "won" && stageIndex(stage) < stageIndex("signed")) reasons.push("won requires the deal to be signed");
  if ((outcome === "lost" || outcome === "disqualified") && !(LOST_REASONS as readonly string[]).includes(reason ?? ""))
    reasons.push(`a reason code is required: ${LOST_REASONS.join(", ")}`);
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------- closing coordinator + move dependencies
/** Mirrored in SQL by mudar_app.deals_closing_template() (auto-seeded at LOI); closing.test.ts keeps them equal. */
export interface MilestoneTemplate { key: string; kind: string; category: string; title: string; required_for_stage: Stage | null; proof_required: boolean; depends_on: string | null }
export const CLOSING_TEMPLATE: MilestoneTemplate[] = [
  { key: "loi_signed", kind: "document", category: "loi", title: "LOI / term sheet signed by both parties", required_for_stage: "documentation", proof_required: true, depends_on: null },
  { key: "title_due_diligence", kind: "legal", category: "legal", title: "Title, approvals and occupation certificate checked", required_for_stage: "signed", proof_required: true, depends_on: "loi_signed" },
  { key: "lease_draft_review", kind: "legal", category: "legal", title: "Lease draft reviewed by client legal", required_for_stage: "signed", proof_required: true, depends_on: "loi_signed" },
  { key: "internal_approval", kind: "approval", category: "approval", title: "Client internal / board approval", required_for_stage: "signed", proof_required: true, depends_on: "lease_draft_review" },
  { key: "stamp_registration", kind: "document", category: "legal", title: "Stamp duty and registration completed", required_for_stage: "possession", proof_required: true, depends_on: "internal_approval" },
  { key: "fitout_approval", kind: "move_dependency", category: "fitout_approval", title: "Fit-out drawings approved by landlord / authorities", required_for_stage: "possession", proof_required: true, depends_on: "loi_signed" },
  { key: "handover", kind: "possession", category: "handover", title: "Handover inspection and snag list signed", required_for_stage: "possession", proof_required: true, depends_on: "stamp_registration" },
  { key: "access", kind: "move_dependency", category: "access", title: "Access cards, parking allocation and signage", required_for_stage: null, proof_required: false, depends_on: "handover" },
  { key: "it_migration", kind: "move_dependency", category: "it_migration", title: "IT / connectivity migration plan", required_for_stage: null, proof_required: false, depends_on: "fitout_approval" },
  { key: "parallel_rent", kind: "move_dependency", category: "parallel_rent", title: "Parallel rent window agreed with old landlord", required_for_stage: null, proof_required: false, depends_on: null },
  { key: "reinstatement", kind: "move_dependency", category: "reinstatement", title: "Reinstatement obligations on the old premises", required_for_stage: null, proof_required: false, depends_on: null },
  { key: "business_interruption", kind: "move_dependency", category: "business_interruption", title: "Business-interruption / cut-over plan", required_for_stage: null, proof_required: false, depends_on: "it_migration" },
  { key: "fee_invoice_prereqs", kind: "fee", category: "fee", title: "Fee invoice prerequisites (signed lease copy, PO / engagement letter)", required_for_stage: "invoiced", proof_required: true, depends_on: "stamp_registration" },
];

// ---------------------------------------------------------------- funnel maths (spec §12) — decimal, no LLM
export interface FunnelInput {
  annualFeeTarget?: number | string | null;   // ₹ credited fee target per year; or give closuresPerYear
  closuresPerYear?: number | null;
  feePerClosure: number | string;              // ₹ credited fee per closure
  cohort: { approached: number; discussions: number; closures: number }; // planning assumption, e.g. 120 > 15 > 1
  workdaysPerYear?: number;                    // default 260
  weeksPerYear?: number;                       // default 52
  workdaysPerMonth?: number;                   // default 20
  lagMonths?: number;                          // approach-to-close lag (default 6)
}
export interface FunnelResult {
  closuresPerYear: number; attributedRevenue: string;
  approachToDiscussion: string; discussionToClose: string; approachToClose: string;
  approachesPerYear: string; discussionsPerYear: string; approachesPerMonth: string; discussionsPerMonth: string;
  approachesPerWeek: string; approachesPerWorkday: string; approachesPerWorkdayAtMonth: string; discussionsPerWeek: string;
  sixMonthApproachEnvelope: string; discussionWipEnvelope: string;
}
export function funnel(i: FunnelInput): FunnelResult {
  const fee = new Decimal(i.feePerClosure);
  if (fee.lte(0)) throw new Error("feePerClosure must be > 0");
  const { approached, discussions, closures } = i.cohort;
  if (!(approached > 0 && discussions > 0 && closures > 0)) throw new Error("cohort counts must be > 0");
  const closuresPerYear = i.closuresPerYear ?? new Decimal(i.annualFeeTarget ?? 0).div(fee).ceil().toNumber();
  const a2c = new Decimal(closures).div(approached);
  const d2c = new Decimal(closures).div(discussions);
  const a2d = new Decimal(discussions).div(approached);
  const apy = new Decimal(closuresPerYear).div(a2c);
  const dpy = new Decimal(closuresPerYear).div(d2c);
  const lag = i.lagMonths ?? 6;
  const f2 = (x: Decimal) => x.toDecimalPlaces(2).toFixed(2);
  return {
    closuresPerYear,
    attributedRevenue: f2(fee.times(closuresPerYear)),
    approachToDiscussion: a2d.times(100).toDecimalPlaces(4).toFixed(4),
    discussionToClose: d2c.times(100).toDecimalPlaces(4).toFixed(4),
    approachToClose: a2c.times(100).toDecimalPlaces(4).toFixed(4),
    approachesPerYear: f2(apy), discussionsPerYear: f2(dpy),
    approachesPerMonth: f2(apy.div(12)), discussionsPerMonth: f2(dpy.div(12)),
    approachesPerWeek: f2(apy.div(i.weeksPerYear ?? 52)), discussionsPerWeek: f2(dpy.div(i.weeksPerYear ?? 52)),
    approachesPerWorkday: f2(apy.div(i.workdaysPerYear ?? 260)),
    approachesPerWorkdayAtMonth: f2(apy.div(12).div(i.workdaysPerMonth ?? 20)),
    sixMonthApproachEnvelope: f2(apy.div(12).times(lag)),
    discussionWipEnvelope: f2(dpy.div(12).times(lag)),
  };
}
