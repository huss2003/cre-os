/** Module 13 memory — shared types (pure; see docs/intelligence-layer/CONTRACT.md). */
import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MemCtx = { db: SupabaseClient<any, any, any>; workspaceId: string; userId: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export type EntityType = "organisation" | "person" | "asset" | "requirement" | "opportunity" | "meeting";
export interface EntityRef { type: EntityType | string; id: string; label?: string }
export interface SourceRef { type: string; id: string; label: string; href: string | null }

export type MemoryStatus = "current" | "historical" | "superseded" | "unverified" | "conflicting";
export type Verification = "verified" | "reported" | "estimated" | "inferred" | "unverified" | "unknown";
export type RequirementConfidence = "confirmed" | "indicative" | "estimated" | "inferred" | "outdated" | "conflicting" | "unknown";

export interface MemoryItem {
  entityId: string;
  entityType: EntityType | string;
  category: string;
  label: string;
  value: unknown;
  display: string;
  sourceRef: SourceRef | null;
  observedAt: string | null;
  lastVerifiedAt: string | null;
  verification: Verification;
  confidence: number | null;
  version: number | null;
  related: EntityRef[];
  status: MemoryStatus;
}

export type TimelineEventType = "interaction" | "meeting" | "employment" | "requirement_version" | "opportunity_stage"
  | "quote" | "availability" | "commitment" | "objection" | "rejection" | "signal" | "relationship_level" | "transaction";
export const TIMELINE_TYPES: TimelineEventType[] = ["interaction", "meeting", "employment", "requirement_version", "opportunity_stage",
  "quote", "availability", "commitment", "objection", "rejection", "signal", "relationship_level", "transaction"];
export const TIMELINE_TYPE_LABEL: Record<TimelineEventType, string> = {
  interaction: "Conversation", meeting: "Meeting", employment: "Job change", requirement_version: "Requirement change",
  opportunity_stage: "Deal stage", quote: "Quotation", availability: "Availability", commitment: "Commitment", objection: "Objection",
  rejection: "Property rejected", signal: "Business development", relationship_level: "Relationship change", transaction: "Transaction",
};

export interface TimelineEvent {
  id: string; at: string; type: TimelineEventType; title: string; detail: string | null;
  refs: EntityRef[]; sourceRef: SourceRef | null; verification: Verification;
}
export interface TimelineFilters {
  orgId?: string; personId?: string; assetId?: string; requirementId?: string; opportunityId?: string;
  from?: string; to?: string; types?: TimelineEventType[]; limit?: number;
}

export const UNKNOWN = "Unknown";
export const hrefFor = (type: string, id: string): string | null =>
  type === "organisation" ? `/companies/${id}` : type === "person" ? `/people/${id}` : type === "asset" ? `/buildings/${id}`
    : type === "requirement" ? `/requirements/${id}` : type === "opportunity" ? `/deals/${id}` : type === "meeting" ? `/meetings/${id}` : null;

/** Module 1 fact_status → verification. Unknown stays unknown. */
export function verificationOf(factStatus: string | null | undefined): Verification {
  switch (factStatus) {
    case "currently_confirmed": return "verified";
    case "historical_observed": return "verified";
    case "reported": return "reported";
    case "ai_inference": return "inferred";
    case "unknown": case null: case undefined: return "unknown";
    default: return "unverified";
  }
}

export function display(v: unknown): string {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && (v.length === 0 || v.every((x) => x === null || x === undefined)))) return UNKNOWN;
  if (Array.isArray(v)) return v.map((x) => (x === null || x === undefined ? "?" : String(x))).join(" – ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function item(p: Omit<MemoryItem, "display" | "lastVerifiedAt" | "confidence" | "version" | "related"> & Partial<Pick<MemoryItem, "display" | "lastVerifiedAt" | "confidence" | "version" | "related">>): MemoryItem {
  return { lastVerifiedAt: null, confidence: null, version: null, related: [], display: display(p.value), ...p };
}
