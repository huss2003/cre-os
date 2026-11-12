import "server-only";
import type { Db } from "@/lib/supabase/server";

/** Spec §5.1–5.6 event catalogue. DB triggers publish the ones marked (t); modules call publishEvent for the rest. */
export const EVENT_TYPES = [
  // company
  "company.created", "company.updated", "company.location_discovered", "company.occupancy_added", "company.lease_changed", "company.identity_updated",
  // research
  "research.signal_detected" /* (t) */, "research.lease_expiry_discovered", "research.leadership_change", "research.infrastructure_announcement", "research.property_trigger",
  // contact
  "contact.enriched", "contact.verified", "contact.employment_changed" /* (t) */, "contact.email_bounced", "contact.role_updated",
  // outreach
  "outreach.draft_generated", "outreach.draft_approved", "outreach.sent_confirmed", "outreach.reply_received", "outreach.followup_overdue", "outreach.meeting_requested",
  // meeting (t)
  "meeting.scheduled", "meeting.rescheduled", "meeting.cancelled", "meeting.completed", "meeting.notes_uploaded", "meeting.summary_approved",
  // commercial
  "commercial.quote_received" /* (t) */, "commercial.terms_revised", "commercial.availability_changed", "commercial.requirement_changed" /* (t) */, "commercial.offer_revised", "commercial.proposal_version_created",
  // platform
  "integration.failed" /* (t) */, "integration.recovered" /* (t) */,
  // records (t) — 20261111001800: company.created/updated also come from the organisation trigger
  "contact.created", "contact.info_added", "lease.created", "lease.changed",
  // Module 15 lease lifecycle (src/modules/leases/service.ts)
  "lease.executed_received", "lease.renewal_agreed", "lease.termination_notice_recorded", "lease.opportunity_identified",
  // Module 16 transactions (src/modules/transactions/events.ts TX_EVENTS)
  "transaction.stage_changed", "transaction.offer_received", "transaction.counteroffer_created", "transaction.offer_expiring", "transaction.issue_overdue",
  "transaction.approval_pending", "transaction.document_version_changed", "transaction.material_term_changed", "transaction.executed",
  "transaction.possession_approaching", "transaction.handover_incomplete",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Contract (master spec 4.2, docs/integration/EVENTS.md): id, type, subject type/id, occurred_at, source module, actor,
 * payload, correlation id, idempotency (dedupe) key, permission context (classification). The DB trigger
 * mudar_app.event_contract_fill derives source module (type prefix), actor (auth.uid()) and correlation (self) when omitted.
 */
export interface PublishInput { type: EventType | string; subjectType?: string | null; subjectId?: string | null; payload?: Record<string, unknown>; dedupeKey?: string;
  sourceModule?: string; correlationId?: string; classification?: "public" | "permitted_personal" | "corporate_confidential" | "licensed_restricted" }

/**
 * Write an event to the transactional outbox (event_outbox). Same dedupeKey twice → one event, duplicate counted,
 * never processed twice. Call it right after the business write (or rely on the DB triggers, which write in the
 * same transaction).
 */
export async function publishEvent(db: Db, ws: string, e: PublishInput): Promise<{ id: string; duplicate: boolean }> {
  const dedupe = e.dedupeKey ?? `${e.type}:${e.subjectId ?? "none"}:${crypto.randomUUID()}`;
  const { data, error } = await db.schema("mudar_app").rpc("publish_event", {
    p_ws: ws, p_type: e.type, p_subject_type: e.subjectType ?? null, p_subject_id: e.subjectId ?? null, p_payload: { ...(e.payload ?? {}), ...(e.sourceModule ? { source_module: e.sourceModule } : {}), ...(e.correlationId ? { correlation_id: e.correlationId } : {}), ...(e.classification ? { classification: e.classification } : {}) }, p_dedupe: dedupe,
  });
  if (error) throw new Error(error.message);
  return data as { id: string; duplicate: boolean };
}
