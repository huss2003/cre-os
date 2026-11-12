/**
 * Shared plain-language display helpers: Indian-grouped money, areas and human labels for internal codes
 * (snake_case statuses, stages, field keys). Display only — never used for maths or storage.
 */

/** ₹ with Indian digit grouping ("₹1,90,00,000"). Unknown stays "unknown". */
export function formatINR(v: number | string | null | undefined, unknown = "unknown"): string {
  if (v === null || v === undefined || v === "") return unknown;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/** "40,618 SF" (Indian grouping). Unknown stays "area unknown". */
export function formatArea(v: number | string | null | undefined, unit = "SF", unknown = "area unknown"): string {
  if (v === null || v === undefined || v === "") return unknown;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `${Math.round(n).toLocaleString("en-IN")} ${unit}`;
}

const CODE_LABELS: Record<string, string> = {
  // deal stages
  research: "Research", approach_attempted: "Approach attempted", engaged: "Engaged", qualified_discussion: "Qualified discussion",
  requirement_confirmed: "Requirement confirmed", options_visits: "Options / visits", proposal_negotiation: "Proposal / negotiation",
  loi: "LOI", documentation: "Documentation",
  // transaction / document statuses
  in_progress: "In progress", not_started: "Not started", done: "Done", skipped: "Skipped", active: "Active", completed: "Completed",
  on_hold: "On hold", cancelled: "Cancelled", draft: "Draft", submitted: "Submitted", client_review: "Client review",
  counterparty_review: "Counterparty review", agreed: "Agreed", superseded: "Superseded", signed: "Signed", executed: "Executed",
  unsigned: "Unsigned", partially_signed: "Partially signed", term_sheet: "Term sheet", agreement: "Agreement",
  executed_agreement: "Executed agreement", handover: "Handover", other: "Other",
  pending: "Pending", under_review: "Under review", changes_requested: "Changes requested", approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn",
  discrepancy: "Discrepancy", responded: "Responded", accepted: "Accepted", open: "Open", requested: "Requested", received: "Received", verified: "Verified",
  // transaction types
  conventional_leasing: "Conventional leasing", managed_office: "Managed office", coworking: "Coworking", lease_renewal: "Lease renewal",
  relocation: "Relocation", build_to_suit: "Build-to-suit", investment: "Investment",
  // approval categories
  client_commercial: "Client commercial", internal_adviser: "Internal adviser",
  // field keys / bases / sources
  cam_per_sf: "CAM per SF", rent_per_sf: "Rent per SF", lockin_months: "Lock-in (months)", lock_in_months: "Lock-in (months)",
  escalation_pct: "Escalation (%)", security_deposit_months: "Security deposit (months)", rent_free_days: "Rent-free (days)",
  per_sf_per_month: "per SF per month", per_seat_per_month: "per seat per month", spreadsheet_import: "Spreadsheet import",
  historical_observed: "Historical (observed)", currently_confirmed: "Currently confirmed", ai_inference: "AI inference", reported: "Reported",
};

/** Human label for an internal code: known dictionary first, else "snake_case" → "Snake case". */
export function codeLabel(code: string | null | undefined, fallback = "—"): string {
  if (code === null || code === undefined || code === "") return fallback;
  const k = String(code);
  if (CODE_LABELS[k]) return CODE_LABELS[k];
  const t = k.replace(/[_-]+/g, " ").replace(/\bsf\b/gi, "SF").replace(/\bpct\b/gi, "%").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** True for values that look like internal codes ("per_sf_per_month"), not prose. */
export const looksLikeCode = (s: string) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(s);
