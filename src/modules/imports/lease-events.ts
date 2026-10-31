/*
 * Independent lease-event engine (spec Part III "Temporal and unit rules", Part V "Lease-event calculations").
 * expiry / lock-in end = EDATE(start, integer tenure months), clamped to month end.
 * Fractional tenure is NEVER truncated: the event carries no date and needs review.
 */
import { edate } from "@/lib/util/time";

export const LEASE_ENGINE_VERSION = "imports.edate.v1";

export interface DerivedEvent {
  event_date: string | null;
  date_basis: "calculated_from_source_tenure";
  needs_review: boolean;
  review_reason: string | null;
  integer_tenure: boolean;
}

export function deriveEventDate(startDate: string | null, tenureMonths: number | null, cached?: string | null): DerivedEvent {
  if (!startDate || tenureMonths === null || !Number.isFinite(tenureMonths) || tenureMonths <= 0) {
    return {
      event_date: null, date_basis: "calculated_from_source_tenure", needs_review: true, integer_tenure: false,
      review_reason: "Missing or invalid start date / tenure; no event date derived",
    };
  }
  if (!Number.isInteger(tenureMonths)) {
    return {
      event_date: null, date_basis: "calculated_from_source_tenure", needs_review: true, integer_tenure: false,
      review_reason: `Fractional tenure ${tenureMonths} months: source EDATE truncates to ${Math.trunc(tenureMonths)}; intended tenure must be confirmed${cached ? ` (source cached value: ${cached})` : ""}`,
    };
  }
  return { event_date: edate(startDate, tenureMonths), date_basis: "calculated_from_source_tenure", needs_review: false, review_reason: null, integer_tenure: true };
}

/** Event in the inclusive [asOf+3 months, asOf+12 months] window (Part V reporting definition). */
export function inThreeToTwelveMonthWindow(eventDate: string, asOf: string): boolean {
  const lo = edate(asOf, 3);
  const hi = edate(asOf, 12);
  return eventDate >= lo && eventDate <= hi;
}
