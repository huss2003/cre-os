import clsx from "clsx";
import { Badge } from "@/components/ui";
import { VERIFICATION_LABEL, type VerificationStatus } from "./dates";

// Lease view tabs come from the app shell (src/lib/nav.ts) — no in-page tab bar.

const TONE: Record<VerificationStatus, "ok" | "warn" | "neutral" | "bad"> = { confirmed: "ok", extracted: "neutral", calculated: "neutral", needs_review: "warn", conflicting: "bad" };
export function VerificationBadge({ status }: { status: string }) {
  const s = (status in TONE ? status : "extracted") as VerificationStatus;
  return <Badge tone={TONE[s]} title={s === "confirmed" ? "Reviewed and approved by a person" : "Not a confirmed contractual deadline until reviewed"}>{VERIFICATION_LABEL[s]}</Badge>;
}

export const DATE_TYPE_LABEL: Record<string, string> = {
  execution: "Execution", possession: "Possession", commencement: "Commencement", rent_commencement: "Rent commencement", rent_free_end: "Rent-free end",
  lockin_end: "Lock-in completion", escalation: "Rent escalation", renewal_option: "Renewal option", renewal_notice_deadline: "Renewal notice deadline",
  break_option: "Break option", termination_notice_deadline: "Termination notice deadline", expiry: "Lease expiry", deposit_refund_deadline: "Deposit refund deadline", handover: "Handover", other: "Other",
};

export function Flash({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const err = typeof sp.err === "string" ? sp.err : null; const ok = typeof sp.ok === "string" ? sp.ok : null;
  if (!err && !ok) return null;
  return <p role={err ? "alert" : "status"} className={clsx("rounded-md px-3 py-2 text-sm", err ? "bg-bad/10 text-bad" : "bg-ok/10 text-ok")}>{err ?? ok}</p>;
}

// ------------------------------------------------------------------ plain labels (browser test A, B6/B7)
const CONVENTION_LABEL: Record<string, string> = {
  exclusive_of_anchor: "counted from the day after the anchor date", inclusive_of_anchor: "counted including the anchor date",
  period_inclusive_end: "period ends the day before the anniversary", effective_on_anniversary: "takes effect on the anniversary date", clear_days: "clear days (both ends excluded)",
  eom_clamp: "month-end dates move to the last day of a shorter month", eom_to_eom: "month-end stays month-end",
};
export function conventionText(c: { counting?: string; monthRule?: string } | null | undefined): string | null {
  if (!c) return null;
  const parts = [c.counting, c.monthRule].filter((x): x is string => !!x).map((x) => CONVENTION_LABEL[x] ?? x.replace(/_/g, " "));
  return parts.length ? parts.join("; ") : null;
}
export const TERMINATION_STATUS_LABEL: Record<string, string> = { initiated: "Initiated", notice_served: "Notice served", in_settlement: "In settlement", completed: "Completed", withdrawn: "Withdrawn" };
export const DEPOSIT_STATUS_LABEL: Record<string, string> = { unknown: "recovery status unknown", pending: "recovery pending", partially_recovered: "partly recovered", recovered: "fully recovered", disputed: "disputed", not_recovered: "not recovered" };
export const FACT_STATUS_LABEL: Record<string, string> = {
  reported: "Reported", currently_confirmed: "Confirmed current", historical_observed: "Seen earlier (historical)", ai_inference: "AI inference (unverified)", stale: "Stale", unknown: "Unknown",
};
export const humanize = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : "—");

const ENTITY_LABEL: Record<string, string> = {
  lease: "Lease", lease_date: "Date", lease_document: "Document", lease_term_version: "Commercial terms", lease_obligation: "Obligation", lease_renewal: "Renewal",
  lease_termination: "Termination", lease_handover_item: "Handover item", lease_status_history: "Status change",
};
const ACTION_LABEL: Record<string, string> = { insert: "added", update: "updated", delete: "removed", archive: "archived" };
/** Human event text for an audit row (never table names). */
export function auditEventText(a: { action: string; entity_type: string; after?: Record<string, unknown> | null }, statusLabel: (s: string) => string = humanize): string {
  const ent = ENTITY_LABEL[a.entity_type] ?? humanize(a.entity_type);
  const after = a.after ?? {};
  const what = typeof after.label === "string" ? ` “${after.label}”` : typeof after.title === "string" ? ` “${after.title}”` : "";
  const vs = typeof after.verification_status === "string" ? ` — ${VERIFICATION_LABEL[after.verification_status as VerificationStatus] ?? humanize(after.verification_status)}` : "";
  const st = a.entity_type === "lease_status_history" && typeof after.to_status === "string" ? ` — ${statusLabel(after.to_status)}` : "";
  return `${ent}${what} ${ACTION_LABEL[a.action] ?? a.action}${vs}${st}`;
}
