import "server-only";
/**
 * Meeting preparation scheduling (spec §4.3) and post-meeting processing (§4.4).
 *
 * Prep: one durable job per (meeting_prep, start time) due ~1 h before (user's prepLeadMinutes). A reschedule produces a
 * new key (new start) and the queued job for the old start is cancelled; a cancelled meeting cancels its queued job and
 * its open notifications. The handler re-validates the meeting, calls the meetings module's generateBrief (Module 7)
 * unless a current brief already exists, saves it against the meeting (meeting_prep.brief + version) and notifies
 * "brief ready" listing missing information (never invented).
 *
 * Post-meeting: ONLY when meeting_visit.status = 'completed' or the user confirms (never because the end time passed).
 * Notes → meetings.structureOutcome (proposed updates); the user approves in the meeting page → applyOutcome sends
 * material changes to Review via proposeChange, creates commitment tasks and optional follow-up DRAFTS (Module 5);
 * the workflows meeting chain then re-scores (Module 3); toolkit recalculation follows confirmed commercial changes
 * through the orchestrator reassessment engine. Nothing is sent (S3).
 */
import type { Db } from "@/lib/supabase/server";
import { callStructured } from "@/lib/ai/gateway";
import { enqueue } from "@/lib/jobs/queue";
import { generateBrief, structureOutcome } from "@/modules/meetings/service";
import { cancelObsolete, notifyUser } from "../notify/service";
import { loadOrchSettings } from "./settings-db";

type Row = Record<string, any>;
export const PREP_JOB = "orchestrator.meeting_prep";
export const POST_JOB = "orchestrator.post_meeting";
export const prepKey = (prepId: string, startAt: string) => `${PREP_JOB}:${prepId}:${new Date(startAt).toISOString()}`;

/** Pure: due time for the prep job (lead minutes before start; if already inside the window, now). */
export function prepDueAt(startAt: string, leadMinutes: number, now: Date): Date | null {
  const start = Date.parse(startAt);
  if (start <= +now) return null;
  return new Date(Math.max(+now, start - leadMinutes * 60_000));
}

/**
 * Schedule / reschedule / cancel prep jobs for a workspace (or one prep). Called each sweep and on meeting events.
 * Returns counts. Admin client; every query filters workspace_id.
 */
export async function scheduleMeetingPreps(admin: Db, ws: string, opts: { now?: Date; prepId?: string; horizonHours?: number } = {}) {
  const now = opts.now ?? new Date();
  const horizon = new Date(+now + (opts.horizonHours ?? 48) * 3600e3).toISOString();
  let q = admin.from("meeting_prep").select("id, owner_user_id, status, meeting_type, meeting:meeting_visit_id!inner(id, start_at, status, kind)")
    .eq("workspace_id", ws).is("archived_at", null);
  q = opts.prepId ? q.eq("id", opts.prepId) : q.gt("meeting.start_at", now.toISOString()).lte("meeting.start_at", horizon);
  const { data, error } = await q.limit(500);
  if (error) throw error;
  const preps = (data ?? []) as Row[];
  let scheduled = 0, cancelled = 0;
  const leadByUser = new Map<string, number>();
  for (const p of preps) {
    const m = p.meeting;
    const live = m && m.status !== "cancelled" && p.status !== "cancelled" && p.status !== "completed" && m.kind !== "internal";
    if (live && Date.parse(m.start_at) > +now) {
      const owner = p.owner_user_id as string | null;
      if (owner && !leadByUser.has(owner)) leadByUser.set(owner, (await loadOrchSettings(admin, ws, owner)).prepLeadMinutes);
      const due = prepDueAt(m.start_at, owner ? leadByUser.get(owner)! : 60, now);
      if (due) {
        const key = prepKey(p.id, m.start_at);
        const { data: ex } = await admin.from("job").select("id").eq("workspace_id", ws).eq("dedupe_key", key).limit(1);
        if (!ex?.length) { await enqueue({ workspaceId: ws, type: PREP_JOB, payload: { prepId: p.id, startAt: new Date(m.start_at).toISOString() }, dueAt: due, dedupeKey: key, maxAttempts: 3 }); scheduled++; }
      }
    }
    cancelled += await cancelStalePrepJobs(admin, ws, p.id, live ? new Date(m.start_at).toISOString() : null, live ? "rescheduled" : "meeting cancelled");
    if (!live && (m?.status === "cancelled" || p.status === "cancelled")) await cancelObsolete(admin, ws, `meeting:${p.id}`, "meeting cancelled");
  }
  if (!opts.prepId) cancelled += await cancelOrphanPrepJobs(admin, ws);
  return { scheduled, cancelled };
}

/** Cancel queued prep jobs for this prep whose start differs from `currentStart` (or all, when null). */
async function cancelStalePrepJobs(admin: Db, ws: string, prepId: string, currentStart: string | null, reason: string): Promise<number> {
  const { data } = await admin.from("job").select("id, payload").eq("workspace_id", ws).eq("job_type", PREP_JOB).eq("state", "queued").filter("payload->>prepId", "eq", prepId);
  let n = 0;
  for (const j of (data ?? []) as Row[]) {
    if (currentStart && j.payload?.startAt === currentStart) continue;
    const { data: u } = await admin.from("job").update({ state: "cancelled", last_error: `cancelled: ${reason}`, updated_at: new Date().toISOString() }).eq("id", j.id).eq("state", "queued").select("id");
    n += u?.length ?? 0;
  }
  return n;
}

/** Queued prep jobs whose meeting was cancelled/moved outside the horizon query (e.g. moved far out). */
async function cancelOrphanPrepJobs(admin: Db, ws: string): Promise<number> {
  const { data: jobs } = await admin.from("job").select("id, payload").eq("workspace_id", ws).eq("job_type", PREP_JOB).eq("state", "queued").limit(500);
  if (!jobs?.length) return 0;
  const ids = [...new Set((jobs as Row[]).map((j) => j.payload?.prepId).filter(Boolean))];
  const { data: preps } = await admin.from("meeting_prep").select("id, status, archived_at, meeting:meeting_visit_id(start_at, status)").eq("workspace_id", ws).in("id", ids.slice(0, 300));
  const byId = new Map(((preps ?? []) as Row[]).map((p) => [p.id, p]));
  let n = 0;
  for (const j of jobs as Row[]) {
    const p = byId.get(j.payload?.prepId);
    const ok = p && !p.archived_at && p.status !== "cancelled" && p.meeting?.status !== "cancelled" && new Date(p.meeting.start_at).toISOString() === j.payload?.startAt;
    if (ok) continue;
    const { data: u } = await admin.from("job").update({ state: "cancelled", last_error: "cancelled: meeting cancelled or rescheduled", updated_at: new Date().toISOString() }).eq("id", j.id).eq("state", "queued").select("id");
    n += u?.length ?? 0;
  }
  return n;
}

/** Job handler: generate (or reuse) the brief ~1 h before and notify. Re-validates the meeting at run time. */
export async function runMeetingPrep(admin: Db, ws: string, payload: { prepId: string; startAt: string }, opts: { now?: Date; ai?: typeof callStructured } = {}) {
  const now = opts.now ?? new Date();
  const { data: p } = await admin.from("meeting_prep").select("id, owner_user_id, status, brief, readiness, readiness_detail, archived_at, meeting:meeting_visit_id(id, title, start_at, status)")
    .eq("workspace_id", ws).eq("id", payload.prepId).maybeSingle();
  if (!p || p.archived_at) return { skipped: "meeting not found" };
  const m = p.meeting as Row | null;
  if (!m || m.status === "cancelled" || p.status === "cancelled") return { skipped: "meeting cancelled" };
  if (new Date(m.start_at).toISOString() !== payload.startAt) return { skipped: "meeting rescheduled — a new prep job is scheduled for the new time" };
  const owner = p.owner_user_id as string | null;
  const fresh = !!p.brief && Date.parse(p.brief?.overview?.start) === Date.parse(m.start_at) && p.status !== "rescheduled";
  let generated = false, error: string | null = null;
  if (!fresh) {
    if (!owner) return { skipped: "meeting has no owner" };
    await admin.from("meeting_prep").update({ auto_brief_for: m.start_at }).eq("workspace_id", ws).eq("id", p.id); // the meetings autobrief will not repeat it
    try { await generateBrief(admin, ws, owner, p.id, opts.ai ?? callStructured); generated = true; }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  const { data: after } = await admin.from("meeting_prep").select("brief_version, readiness, readiness_detail, brief_error").eq("workspace_id", ws).eq("id", p.id).single();
  const missing: string[] = [...(after?.readiness_detail?.critical ?? []), ...(after?.readiness_detail?.missing ?? [])];
  if (owner) {
    await notifyUser(admin, ws, error
      ? { userId: owner, category: "meeting_prep", eventKey: `meeting_prep_failed:${p.id}:${payload.startAt}`, severity: "urgent", title: `Brief for "${m.title ?? "meeting"}" could not be generated`, body: (after?.brief_error ?? error).slice(0, 300), record: { type: "meeting_prep", id: p.id }, href: `/meetings/${p.id}`, triggerKey: `meeting:${p.id}`, now }
      : { userId: owner, category: "meeting_prep", eventKey: `meeting_prep_ready:${p.id}:${payload.startAt}`, severity: "info", title: `Brief ready: ${m.title ?? "meeting"}`, body: missing.length ? `Missing information: ${missing.slice(0, 5).join("; ")}` : "No missing information flagged", record: { type: "meeting_prep", id: p.id }, href: `/meetings/${p.id}`, triggerKey: `meeting:${p.id}`, now });
  }
  if (error) throw new Error(`brief generation failed: ${error}`); // queue retries (attempts are limited)
  return { prepId: p.id, generated, reused: !generated, version: after?.brief_version ?? null, readiness: after?.readiness ?? null, missing };
}

/** Enqueue post-meeting processing for meetings whose status is completed (by the user or the calendar), never by end time. */
export async function detectCompletedMeetings(admin: Db, ws: string, opts: { now?: Date; lookbackDays?: number } = {}) {
  const now = opts.now ?? new Date();
  const since = new Date(+now - (opts.lookbackDays ?? 14) * 864e5).toISOString();
  const { data } = await admin.from("meeting_prep").select("id, status, meeting:meeting_visit_id!inner(status, start_at)").eq("workspace_id", ws).is("archived_at", null)
    .gte("meeting.start_at", since).lte("meeting.start_at", now.toISOString()).limit(500);
  let n = 0;
  for (const p of (data ?? []) as Row[]) {
    if (p.meeting?.status !== "completed" && p.status !== "completed") continue;
    const key = `${POST_JOB}:${p.id}`;
    const { data: ex } = await admin.from("job").select("id").eq("workspace_id", ws).eq("dedupe_key", key).limit(1);
    if (ex?.length) continue;
    await enqueue({ workspaceId: ws, type: POST_JOB, payload: { prepId: p.id }, dedupeKey: key, maxAttempts: 3 });
    n++;
  }
  return n;
}

export class MeetingFlowError extends Error {}

/** The user confirms the meeting took place (user client, RLS) → status completed + post-meeting job. */
export async function confirmMeetingCompleted(db: Db, ws: string, prepId: string) {
  const { data: p } = await db.from("meeting_prep").select("id, meeting_visit_id, status, meeting:meeting_visit_id(start_at, status)").eq("workspace_id", ws).eq("id", prepId).maybeSingle();
  if (!p) throw new MeetingFlowError("Meeting not found.");
  if ((p.meeting as Row)?.status === "cancelled" || p.status === "cancelled") throw new MeetingFlowError("This meeting was cancelled.");
  if (Date.parse((p.meeting as Row)?.start_at) > Date.now()) throw new MeetingFlowError("The meeting has not started yet.");
  const { error: e1 } = await db.from("meeting_visit").update({ status: "completed" }).eq("workspace_id", ws).eq("id", p.meeting_visit_id);
  if (e1) throw e1;
  const { error: e2 } = await db.from("meeting_prep").update({ status: "completed" }).eq("workspace_id", ws).eq("id", prepId);
  if (e2) throw e2;
  const job = await enqueue({ workspaceId: ws, type: POST_JOB, payload: { prepId }, dedupeKey: `${POST_JOB}:${prepId}`, maxAttempts: 3 });
  return { ok: true, job };
}

/** Job handler: notes → proposed outcome (Module 7) → user is asked to review; no notes → reminder to add them. */
export async function runPostMeeting(admin: Db, ws: string, prepId: string, opts: { now?: Date; ai?: typeof callStructured } = {}) {
  const now = opts.now ?? new Date();
  const { data: p } = await admin.from("meeting_prep").select("id, owner_user_id, status, outcome, meeting:meeting_visit_id(title, status)").eq("workspace_id", ws).eq("id", prepId).maybeSingle();
  if (!p) return { skipped: "meeting not found" };
  const m = p.meeting as Row | null;
  if (m?.status !== "completed" && p.status !== "completed") return { skipped: "meeting not confirmed as completed" };
  const owner = p.owner_user_id as string | null;
  if ((p.outcome as Row | null)?.applied) return { skipped: "outcome already applied" };
  const { count } = await admin.from("meeting_note").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("prep_id", prepId).is("archived_at", null);
  const { count: fb } = await admin.from("meeting_property_feedback").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("prep_id", prepId).is("archived_at", null);
  if (!count && !fb) {
    if (owner) await notifyUser(admin, ws, { userId: owner, category: "meeting_outcome", eventKey: `meeting_notes_needed:${prepId}`, title: `Add notes for "${m?.title ?? "meeting"}"`, body: "No notes or recording are available yet — add notes to turn them into proposed updates.", record: { type: "meeting_prep", id: prepId }, href: `/meetings/${prepId}`, triggerKey: `meeting_outcome:${prepId}`, now });
    return { waiting: "notes" };
  }
  let proposed = (p.outcome as Row | null)?.proposed ?? null;
  if (!proposed) {
    if (!owner) return { skipped: "meeting has no owner" };
    proposed = await structureOutcome(admin, ws, owner, prepId, "", opts.ai ?? callStructured);
  }
  if (owner) {
    await cancelObsolete(admin, ws, `meeting_outcome:${prepId}`, "notes added");
    await notifyUser(admin, ws, { userId: owner, category: "meeting_outcome", eventKey: `meeting_outcome_ready:${prepId}`, title: `Review the outcome of "${m?.title ?? "meeting"}"`,
      body: "Proposed updates, commitments and follow-ups are ready. Nothing changes until you approve.", record: { type: "meeting_prep", id: prepId }, href: `/meetings/${prepId}`, now });
  }
  return { prepId, proposed: true, commitments: Array.isArray(proposed?.commitments) ? proposed.commitments.length : null };
}
