/**
 * Module 16 — pure constants, templates and status helpers. No I/O.
 */
import { codeLabel, formatINR } from "@/lib/util/labels";

export const TX_TYPES = ["conventional_leasing", "managed_office", "coworking", "lease_renewal", "relocation", "build_to_suit", "investment"] as const;
export type TxType = (typeof TX_TYPES)[number] | string;
export const TX_TYPE_LABEL: Record<string, string> = {
  conventional_leasing: "Conventional leasing", managed_office: "Managed office", coworking: "Coworking", lease_renewal: "Lease renewal",
  relocation: "Relocation", build_to_suit: "Build-to-suit", investment: "Investment",
};

const st = (...titles: string[]) => titles.map((title) => ({ key: title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), title }));
/** Default workflow templates (§3.2). A workspace can save its own per type in tx_stage_template. */
export const DEFAULT_TEMPLATES: Record<string, { key: string; title: string }[]> = {
  conventional_leasing: st("Requirement confirmation", "Property identification", "Property shortlist", "Availability confirmation", "Site visits", "Client feedback",
    "Commercial proposal", "Negotiation", "LOI", "Legal documentation", "Agreement execution", "Deposit", "Possession", "Fit-out", "Handover"),
  managed_office: st("Requirement confirmation", "Operator identification", "Capacity confirmation", "Location comparison", "Commercial proposal",
    "Seat and configuration confirmation", "Service and amenity clarification", "Negotiation", "Agreement", "Payment and deposit", "Access and onboarding", "Occupancy"),
  coworking: st("Requirement confirmation", "Operator identification", "Capacity confirmation", "Commercial proposal", "Negotiation", "Agreement", "Payment and deposit", "Access and onboarding", "Occupancy"),
  lease_renewal: st("Existing lease review", "Renewal timeline review", "Client consultation", "Existing commercial assessment", "Landlord proposal",
    "Alternative property assessment", "Renewal versus relocation comparison", "Negotiation", "Approval", "Renewal documentation", "Execution"),
  relocation: st("Existing lease assessment", "New requirement confirmation", "Property search", "Property comparison", "Site visits", "Commercial negotiations",
    "Relocation cost assessment", "Existing lease exit planning", "New agreement", "Possession", "Fit-out", "Relocation", "Handover"),
  build_to_suit: st("Requirement confirmation", "Site identification", "Feasibility assessment", "Technical specifications", "Development proposal",
    "Commercial negotiations", "Design approval", "Development milestones", "Inspection", "Completion", "Agreement and possession", "Handover"),
  investment: st("Investment requirement", "Asset identification", "Initial evaluation", "Financial analysis", "Due diligence", "Commercial negotiation",
    "Legal review", "Approval", "Documentation", "Transaction execution", "Closing and handover"),
};

/** §2.2 the sixteen workspace sections. */
export const WORKSPACE_SECTIONS = [
  ["overview", "Transaction overview"], ["requirements", "Client requirements"], ["property", "Property information"], ["offers", "Offers and counteroffers"],
  ["negotiation", "Commercial negotiations"], ["inspections", "Technical inspections"], ["issues", "Open issues"], ["stakeholders", "Stakeholders"],
  ["approvals", "Approvals"], ["loi", "LOI and term sheet"], ["legal", "Legal documents"], ["financial", "Financial information"],
  ["execution", "Execution milestones"], ["possession", "Possession and fit-out"], ["handover", "Handover"], ["closure", "Closure pack"],
] as const;

export const ISSUE_CATEGORIES = ["commercial", "technical", "legal", "financial", "documentation", "property", "approval", "possession", "fitout", "handover", "other"] as const;
export const ISSUE_STATUSES = ["open", "under_review", "awaiting_client", "awaiting_landlord", "awaiting_operator", "awaiting_legal", "awaiting_finance", "awaiting_approval", "resolved", "closed"] as const;
export const POINT_STATUSES = ["proposed", "under_negotiation", "agreed", "rejected", "pending_clarification", "subject_to_approval", "documented", "verified_executed"] as const;
export const POINT_STATUS_LABEL: Record<string, string> = {
  proposed: "Proposed", under_negotiation: "Under negotiation", agreed: "Agreed", rejected: "Rejected", pending_clarification: "Pending clarification",
  subject_to_approval: "Subject to approval", documented: "Documented", verified_executed: "Verified against executed agreement",
};
export const AGREED_STATUSES = ["agreed", "subject_to_approval", "documented", "verified_executed"];
export const APPROVAL_CATEGORIES = ["client_commercial", "internal_adviser", "landlord", "operator", "financial", "legal", "technical", "management"] as const;
export const APPROVAL_STATUSES = ["not_required", "pending", "under_review", "approved", "rejected", "changes_requested", "withdrawn"] as const;
export const STAKEHOLDER_CATEGORIES = ["client", "client_decision_maker", "client_finance", "client_procurement", "client_legal", "landlord", "developer", "asset_manager",
  "property_manager", "leasing_representative", "operator", "legal_adviser", "procurement_adviser", "finance_representative", "fitout_contractor", "technical_consultant", "internal_team"] as const;
export const CLARIFICATION_TOPICS = ["hvac", "electrical_capacity", "power_backup", "floor_loading", "fire_safety", "lift_capacity", "internet", "parking", "building_access", "fitout_conditions", "other"] as const;
export const POSITION_KINDS = ["client_requirement", "adviser_recommendation", "counterparty_proposal"] as const;

/** §16: never interchangeable. Order is display order only — none implies another. */
export const MILESTONE_KINDS = ["commercially_agreed", "legally_approved", "signed", "executed", "possession_completed", "fitout_completed", "occupied", "handover_completed"] as const;
export const MILESTONE_LABEL: Record<string, string> = {
  commercially_agreed: "Commercially agreed", legally_approved: "Legally approved", signed: "Signed", executed: "Executed",
  possession_completed: "Possession completed", fitout_completed: "Fit-out completed", occupied: "Occupied", handover_completed: "Handover completed",
};

/** Negotiation variables (§5.1) — keys match toolkit OfferTerms where a toolkit field exists. */
export const OFFER_TERM_FIELDS: { key: string; label: string; numeric: boolean }[] = [
  { key: "areaSf", label: "Quoted area (SF)", numeric: true }, { key: "areaBasis", label: "Area measurement", numeric: false },
  { key: "rentPerSf", label: "Rent ₹/SF/month", numeric: true }, { key: "camPerSf", label: "CAM ₹/SF/month", numeric: true },
  { key: "depositMonths", label: "Security deposit (months)", numeric: true }, { key: "rentFreeMonths", label: "Rent-free (months)", numeric: true },
  { key: "escalationPct", label: "Escalation %", numeric: true }, { key: "escalationEveryMonths", label: "Escalation every (months)", numeric: true },
  { key: "lockInMonths", label: "Lock-in (months)", numeric: true }, { key: "tenureMonths", label: "Lease duration (months)", numeric: true },
  { key: "fitoutContribution", label: "Fit-out support ₹", numeric: true }, { key: "possessionDate", label: "Possession date", numeric: false },
  { key: "handover", label: "Handover / possession conditions", numeric: false }, { key: "parkingSlots", label: "Parking slots", numeric: true },
  { key: "parkingRatePerSlot", label: "Parking ₹/slot/month", numeric: true }, { key: "breakClause", label: "Early termination flexibility", numeric: false },
  { key: "renewalOption", label: "Renewal option", numeric: false }, { key: "noticeMonths", label: "Notice (months)", numeric: true },
  { key: "leaseCommencement", label: "Lease commencement", numeric: false }, { key: "discountRatePct", label: "Discount rate % (analysis)", numeric: true },
  { key: "other", label: "Other concessions / conditions", numeric: false },
];
export const TERM_LABEL: Record<string, string> = Object.fromEntries(OFFER_TERM_FIELDS.map((f) => [f.key, f.label]));
/** Terms that become commercial points (not analysis-only inputs). */
export const COMMERCIAL_TERMS = OFFER_TERM_FIELDS.filter((f) => !["discountRatePct", "leaseCommencement"].includes(f.key)).map((f) => f.key);

export type Terms = Record<string, string | number | null | undefined>;

/** Deterministic canonical JSON (sorted keys, blanks dropped) → stable content hash input. */
export function canonical(x: unknown): string {
  if (x === null || x === undefined || x === "") return "null";
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => !(o[k] === null || o[k] === undefined || o[k] === "")).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(typeof x === "number" ? String(x) : x);
}

export function cleanTerms(t: Terms): Terms {
  const out: Terms = {};
  for (const f of OFFER_TERM_FIELDS) {
    const v = t[f.key];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) continue; // unknown stays unknown (S6)
    out[f.key] = f.numeric ? String(v).trim() : String(v).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- issues
export interface IssueLike { status: string; due_date: string | null; blocking: boolean; depends_on?: string[] | null; next_action?: string | null; priority?: string }
export const isOpenIssue = (i: { status: string }) => !["resolved", "closed"].includes(i.status);
export const isOverdue = (i: IssueLike, today: string) => isOpenIssue(i) && !!i.due_date && i.due_date < today;
/** Issue waiting on another unresolved issue. */
export function waitingOn(i: IssueLike & { id?: string }, all: (IssueLike & { id: string })[]): string[] {
  return (i.depends_on ?? []).filter((d) => all.some((x) => x.id === d && isOpenIssue(x)));
}

// ---------------------------------------------------------------------------------------------- deposits (§13.3)
export interface DepositLike { proposed_on: string | null; approved_on: string | null; due_date: string | null; paid_on: string | null; acknowledged_on: string | null; refundable: boolean | null; refunded_on: string | null }
/** Every stage reported separately — an approved or due deposit is never reported as paid. */
export function depositStages(d: DepositLike, today: string) {
  return {
    proposed: !!d.proposed_on, approved: !!d.approved_on, due: !!d.due_date, overdue: !!d.due_date && !d.paid_on && d.due_date < today,
    paid: !!d.paid_on, acknowledged: !!d.acknowledged_on, refundable: d.refundable === null ? "unknown" : d.refundable, refunded: !!d.refunded_on,
  };
}
export function depositHeadline(d: DepositLike, today: string): string {
  const s = depositStages(d, today);
  if (s.refunded) return "Refunded";
  if (s.acknowledged) return "Paid and acknowledged";
  if (s.paid) return "Paid (acknowledgement pending)";
  if (s.overdue) return "Due — overdue, not paid";
  if (s.due) return "Due — not paid";
  if (s.approved) return "Approved — not yet due/paid";
  if (s.proposed) return "Proposed";
  return "Not started";
}

// ---------------------------------------------------------------------------------------------- milestones
export interface MilestoneLike { kind: string; achieved_on: string | null; expected_on: string | null }
/** Status per milestone straight from its own record; nothing is inferred from another milestone. */
export function milestoneMatrix(rows: MilestoneLike[]) {
  return MILESTONE_KINDS.map((k) => {
    const r = rows.find((x) => x.kind === k);
    return { kind: k, label: MILESTONE_LABEL[k], achieved: !!r?.achieved_on, achievedOn: r?.achieved_on ?? null, expectedOn: r?.expected_on ?? null };
  });
}

/** B13: coming from a deal, preselect the deal's linked requirement (client-confirmed preferred by the caller's list). */
export function prefillRequirement(opportunityId: string | null | undefined, opps: { id: string; requirement_id: string | null }[]): string {
  if (!opportunityId) return "";
  return opps.find((o) => o.id === opportunityId)?.requirement_id ?? "";
}

const UUID_RE = /\s*\(?\b(?:lease\s+)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b\)?/gi;
/** Timeline text for people: snake_case codes → words, bare ids dropped, rupee amounts grouped (works on stored rows too). */
export function plainSummary(s: string | null | undefined): string {
  if (!s) return "";
  const out = s
    .replace(UUID_RE, "")
    .replace(/₹(\d{4,}(?:\.\d+)?)(?![\d,])/g, (_, n) => formatINR(n))
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (m) => codeLabel(m).toLowerCase())
    .replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** Deposit stage flags → "✓ Proposed · — Approved …" (labels, not raw booleans). */
export function depositStageText(stages: Record<string, unknown>): string {
  return Object.entries(stages).map(([k, x]) => `${x ? "✓" : "—"} ${codeLabel(k)}`).join(" · ");
}

/** Clarification requirement column: text requirement, else the numeric minimum ("≥ 400"), else "—". */
export function clarificationRequirement(c: { required_value: string | null; required_numeric: number | string | null; topic?: string }): string {
  if (c.required_value) return c.required_value;
  if (c.required_numeric === null || c.required_numeric === undefined || c.required_numeric === "") return "—";
  const unit = c.topic === "electrical_capacity" || c.topic === "power_backup" ? " kVA" : c.topic === "floor_loading" ? " kN/m²" : "";
  return `≥ ${Number(c.required_numeric).toLocaleString("en-IN")}${unit}`;
}
