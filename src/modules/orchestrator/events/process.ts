import "server-only";
import type { Db } from "@/lib/supabase/server";
import { runWorkflow } from "../engine/runner";
import { scheduleMeetingPreps } from "../schedule/meetings";
import { RECORD_CHANGED } from "../reassess/records";

type Row = Record<string, any>;
export interface ConsumerResult { status: "done" | "skipped" | "routed"; detail: string; runId?: string | null; routedModule?: string; routedKind?: string }
export type Consumer = (db: Db, ws: string, e: Row) => Promise<ConsumerResult>;

/** Start a reassessment workflow for an event (dedupe = event id → one execution per event). */
const startFor = (key: string, input: (e: Row) => Record<string, unknown>, subject: (e: Row) => { type: string; id: string } | null = (e) => (e.subject_id ? { type: e.subject_type, id: e.subject_id } : null)): Consumer =>
  async (db, ws, e) => {
    const s = subject(e);
    const r = await runWorkflow(db, ws, key, { trigger: "event", triggerRef: { event_id: e.id, event_type: e.event_type }, dedupeKey: `evt:${e.id}:${key}`, input: { ...input(e), eventId: e.id }, subjectType: s?.type, subjectId: s?.id });
    return { status: "done", detail: `${key} ${r.duplicate ? "already started" : r.status}`, runId: r.id };
  };
/** meeting.* → (re)schedule / cancel the prep job of each prep of that meeting right away (not at the next sweep). */
const meetingPreps: Consumer = async (db, ws, e) => {
  const { data } = await db.from("meeting_prep").select("id").eq("workspace_id", ws).eq("meeting_visit_id", e.subject_id).limit(20);
  const preps = (data ?? []) as Row[];
  if (!preps.length) return { status: "skipped", detail: "No preparation record for this meeting." };
  let scheduled = 0, cancelled = 0;
  for (const p of preps) { const r = await scheduleMeetingPreps(db, ws, { prepId: p.id }); scheduled += r.scheduled ?? 0; cancelled += r.cancelled ?? 0; }
  return { status: "done", detail: `Prep jobs: ${scheduled} scheduled, ${cancelled} cancelled.` };
};
/**
 * Routed to an existing module process (no duplicate logic in the orchestrator). When the receiving process records a
 * run we can see (workflow_run kind), the log row is 'routed' and `trackRouted` follows it to completed/failed/delayed.
 */
const handledBy = (what: string, track?: { module: string; kind: string }): Consumer => async () =>
  track ? { status: "routed", detail: `Routed to ${what}.`, routedModule: track.module, routedKind: track.kind } : { status: "skipped", detail: `Handled by ${what}.` };
/** New / changed company, contact or lease → re-score + flag dependants (one run per record per 10 minutes). */
const recordChanged = (entity: string): Consumer => async (db, ws, e) => {
  const id = e.subject_id as string;
  const bucket = Math.floor(Date.parse(e.occurred_at ?? new Date().toISOString()) / 600_000);
  const r = await runWorkflow(db, ws, RECORD_CHANGED, { trigger: "event", triggerRef: { event_id: e.id, event_type: e.event_type }, dedupeKey: e.event_type === "lease.changed" ? `evt:${e.id}:${RECORD_CHANGED}` : `record:${entity}:${id}:${bucket}`,
    input: { entity, entityId: id, eventType: e.event_type, changed: e.payload?.changed ?? {}, eventId: e.id }, subjectType: entity, subjectId: id });
  return { status: "done", detail: `${RECORD_CHANGED} ${r.duplicate ? "already started" : r.status}`, runId: r.id };
};

/**
 * Event → downstream work (spec §5). Events with no consumer are marked ignored (still kept in the outbox history).
 * Each (event, consumer) pair runs once: event_processing_log is unique on it.
 */
export const CONSUMERS: Record<string, Record<string, Consumer>> = {
  "commercial.quote_received": { reassess: startFor("reassess.quote", (e) => ({ quoteId: e.subject_id, causeType: "quote", causeId: e.subject_id })) },
  "commercial.requirement_changed": { reassess: startFor("reassess.requirement", (e) => ({ requirementId: e.subject_id, changed: e.payload?.changed ?? {}, causeType: "requirement", causeId: e.subject_id })) },
  "meeting.cancelled": { reassess: startFor("reassess.meeting_cancelled", (e) => ({ meetingId: e.subject_id })), prep_schedule: meetingPreps },
  "meeting.rescheduled": { brief: handledBy("meetings (reschedule moves remind_at; autobrief regenerates T-60)"), prep_schedule: meetingPreps },
  "meeting.scheduled": { brief: handledBy("meetings.autobrief / meetings.remind schedulers"), prep_schedule: meetingPreps },
  "meeting.completed": { followup: handledBy("workflows.meeting_chain (rescore + follow-ups)", { module: "meetings", kind: "meeting_chain" }) },
  "contact.employment_changed": { review: startFor("reassess.employment", (e) => ({ personId: e.subject_id, employmentId: e.payload?.employment_id, newOrgId: e.payload?.new_org_id })),
    reengage: handledBy("workflows.employer_chain (one re-engagement draft, never sent)", { module: "workflows", kind: "employer_chain" }) },
  "research.signal_detected": { chain: handledBy("workflows.signal_chain (match company → contacts → scoring → draft)", { module: "signals", kind: "signal_chain" }) },
  "company.created": { dependants: recordChanged("organisation") },
  "company.updated": { dependants: recordChanged("organisation") },
  "contact.created": { dependants: recordChanged("person") },
  "contact.info_added": { dependants: recordChanged("person") },
  "lease.created": { dependants: recordChanged("lease"), renewal: handledBy("workflows.lease_chain (renewal window → requirement → comparison)", { module: "workflows", kind: "lease_chain" }) },
  "lease.changed": { dependants: recordChanged("lease"), renewal: handledBy("workflows.lease_chain (renewal window → requirement → comparison)", { module: "workflows", kind: "lease_chain" }) },
  "integration.failed": { health: startFor("reassess.integration_failed", (e) => ({ source: e.payload?.source ?? e.subject_type, error: e.payload?.error ?? e.payload?.status ?? "unavailable", subjectType: e.subject_type, subjectId: e.subject_id, important: e.payload?.important === true })) },
  "integration.recovered": { health: startFor("reassess.integration_recovered", (e) => ({ source: e.payload?.source ?? e.subject_type })) },
};

/** Extension point for other agents (notify/schedule): add a consumer for an event type. */
export function registerConsumer(eventType: string, name: string, c: Consumer) {
  (CONSUMERS[eventType] ??= {})[name] = c;
}

const MAX_EVENT_ATTEMPTS = 5;

/** Process pending events of one workspace (idempotent consumers). Safe to run concurrently and repeatedly. */
export async function processEvents(db: Db, ws: string, opts: { limit?: number; eventIds?: string[] } = {}) {
  let q = db.from("event_outbox").select("*").eq("workspace_id", ws).eq("status", "pending");
  if (opts.eventIds) q = q.in("id", opts.eventIds);
  const { data: events } = await q.order("occurred_at").limit(opts.limit ?? 25);
  const summary = { processed: 0, ignored: 0, failed: 0, skippedDuplicate: 0 };
  for (const e of (events ?? []) as Row[]) {
    const consumers = CONSUMERS[e.event_type] ?? {};
    if (!Object.keys(consumers).length) {
      await db.from("event_outbox").update({ status: "ignored", processed_at: new Date().toISOString() }).eq("id", e.id);
      summary.ignored++; continue;
    }
    let failed = false;
    for (const [name, fn] of Object.entries(consumers)) {
      // Inbox claim: insert (event, consumer); if it exists, only a previously failed attempt may be re-claimed.
      const ins = await db.from("event_processing_log").insert({ workspace_id: ws, event_id: e.id, consumer: name, status: "processing" }).select("id").maybeSingle();
      let logId = ins.data?.id as string | undefined;
      if (ins.error) {
        if (ins.error.code !== "23505") throw new Error(ins.error.message);
        const re = await db.from("event_processing_log").update({ status: "processing", updated_at: new Date().toISOString() }).eq("event_id", e.id).eq("consumer", name).eq("status", "failed").select("id").maybeSingle();
        if (!re.data) { summary.skippedDuplicate++; continue; }
        logId = re.data.id;
      }
      try {
        const r = await fn(db, ws, e);
        await db.from("event_processing_log").update({ status: r.status, detail: r.detail.slice(0, 1000), run_id: r.runId ?? null, updated_at: new Date().toISOString(),
          ...(r.status === "routed" ? { routed_module: r.routedModule ?? null, routed_kind: r.routedKind ?? null, routed_status: "pending" } : {}) }).eq("id", logId!);
      } catch (err) {
        failed = true;
        await db.from("event_processing_log").update({ status: "failed", detail: String((err as Error)?.message ?? err).slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", logId!);
      }
    }
    const attempts = (e.attempts ?? 0) + 1;
    if (failed) {
      await db.from("event_outbox").update({ attempts, last_error: "consumer failed (see event_processing_log)", status: attempts >= MAX_EVENT_ATTEMPTS ? "failed" : "pending" }).eq("id", e.id);
      summary.failed++;
    } else {
      await db.from("event_outbox").update({ attempts, status: "processed", processed_at: new Date().toISOString() }).eq("id", e.id);
      summary.processed++;
    }
  }
  return summary;
}
