/**
 * Module 13 §6 — historical memory & change detection: shared pure types (no server-only; safe in tests and UI).
 */

export type ChangeKind =
  | "employer_change" | "promotion" | "designation_change" | "office_location_change" | "expansion" | "reduction"
  | "rent_change" | "cam_change" | "inventory_change" | "lease_expiry_approaching"
  | "requirement_area_change" | "requirement_budget_change" | "requirement_location_change" | "requirement_timeline_change" | "requirement_other_change"
  | "decision_maker_change" | "opportunity_inactive" | "rejected_property_relevant";

export type ChangeVerification = "verified" | "reported" | "estimated" | "inferred" | "unverified" | "unknown";

import type { SourceRef } from "../types";
export type { SourceRef };
export interface RecordRef { type: string; id: string; label?: string }

export interface Difference { text: string; delta?: number | null; pct?: number | null; added?: string[]; removed?: string[] }

/** §6.2 historical comparison: one detected change with both values kept. */
export interface DetectedChange {
  dedupeKey: string;
  kind: ChangeKind;
  entityType: string;
  entityId: string;
  field: string | null;
  previous: unknown;            // null = unknown / not recorded
  latest: unknown;
  difference: Difference;
  changedAt: string | null;     // null = date unknown (never invented)
  source: SourceRef | null;
  verification: ChangeVerification;
  affectedRecords: RecordRef[];
  affectedOpportunityIds: string[];
  modules: string[];
  material: boolean;
  impact?: Record<string, unknown>;
}

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  employer_change: "Contact changed employer", promotion: "Contact promoted", designation_change: "Designation changed",
  office_location_change: "Office location changed", expansion: "Company expanded space", reduction: "Company reduced space",
  rent_change: "Rent changed", cam_change: "CAM changed", inventory_change: "Inventory changed", lease_expiry_approaching: "Lease expiry approaching",
  requirement_area_change: "Requirement area changed", requirement_budget_change: "Requirement budget changed",
  requirement_location_change: "Requirement location changed", requirement_timeline_change: "Requirement timeline changed",
  requirement_other_change: "Requirement changed", decision_maker_change: "Decision-maker changed",
  opportunity_inactive: "Opportunity inactive", rejected_property_relevant: "Rejected property may be relevant again",
};

/** Downstream modules (§11) told about each kind of change. */
export const CHANGE_MODULES: Record<ChangeKind, string[]> = {
  employer_change: ["contacts", "scoring", "outreach", "deals"], promotion: ["contacts", "scoring", "outreach"], designation_change: ["contacts", "outreach"],
  office_location_change: ["scoring", "signals", "deals"], expansion: ["scoring", "signals", "deals"], reduction: ["scoring", "signals", "deals"],
  rent_change: ["deals", "toolkit"], cam_change: ["deals", "toolkit"], inventory_change: ["deals", "toolkit"], lease_expiry_approaching: ["brief", "scoring", "outreach"],
  requirement_area_change: ["deals", "toolkit", "scoring", "meetings"], requirement_budget_change: ["deals", "toolkit", "scoring"],
  requirement_location_change: ["deals", "toolkit", "scoring"], requirement_timeline_change: ["deals", "toolkit", "scoring", "brief"],
  requirement_other_change: ["deals"], decision_maker_change: ["deals", "outreach", "meetings", "scoring"],
  opportunity_inactive: ["deals", "brief"], rejected_property_relevant: ["deals", "toolkit"],
};

export const hrefFor = (type: string, id: string): string | null => ({
  organisation: `/companies/${id}`, person: `/people/${id}`, asset: `/buildings/${id}`, requirement: `/requirements/${id}`,
  opportunity: `/deals/${id}`, lease: `/leases?id=${id}`, interaction: null, meeting: `/meetings`, quote: null, change: `/intelligence/quality#c-${id}`,
} as Record<string, string | null>)[type] ?? null;
