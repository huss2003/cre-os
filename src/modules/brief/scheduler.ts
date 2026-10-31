/**
 * Timezone-aware schedule planner (spec Part III "Scheduled job specification"). PURE: returns job specs with
 * dedupe keys; `jobs.ts#schedule` enqueues them. Repeated ticks produce identical dedupe keys => one job.
 *
 *   brief.recalc        07:00 (brief − 60)  per workspace     lease/notice recalculation + lead scores
 *   brief.plan          07:20 (brief − 40)  per member        priority adviser daily plan
 *   brief.generate      07:40 (brief − 20)  per member        brief built (ready before 08:00)
 *   brief.health_check  07:55 (brief − 5)   per member        source check; deterministic fallback if missing
 *   brief.deliver       08:00               per member        mark delivered + private "brief_ready" notification
 *   brief.health_alert  08:05 (brief + 5)   per member        owner alert if the brief is still missing
 *   brief.reconcile     20:30               per member        reconciliation / next-day draft
 *   brief.weekly        Fri 18:00           per member        weekly review (ISO week key)
 *   brief.pre_meeting   T-60                per meeting       external id + start-time version; cancel/reschedule invalidates
 */
import { addDays, atLocal, isoWeekKey, isoWeekday, localDate } from "./dates";
import { type BriefSettings, shiftHHMM } from "./settings";

export interface JobSpec {
  workspaceId: string;
  type: string;
  payload: Record<string, unknown>;
  dueAt: Date;
  dedupeKey: string;
}

export interface MemberCtx { userId: string; role: string; settings: BriefSettings }
export interface WorkspaceCtx { id: string; timezone: string; status: string; settings: BriefSettings; members: MemberCtx[] }

export interface MeetingCtx {
  id: string;
  workspaceId: string;
  ownerUserId: string | null;
  externalId: string | null;
  startAt: string;
  status: string;
  archivedAt?: string | null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Meeting version: external id (or row id) + start-time instant. A reschedule changes it. */
export function meetingVersionKey(m: Pick<MeetingCtx, "id" | "externalId" | "startAt">): string {
  return `${m.externalId ?? m.id}@${new Date(m.startAt).toISOString()}`;
}

function slot(date: string, hhmm: string, offsetMin: number, tz: string): Date {
  const { hhmm: t, dayOffset } = shiftHHMM(hhmm, offsetMin);
  return atLocal(addDays(date, dayOffset), t, tz);
}

export function planSchedule(now: Date, workspaces: WorkspaceCtx[], meetings: MeetingCtx[]): JobSpec[] {
  const specs: JobSpec[] = [];
  const nowMs = now.getTime();
  const add = (s: JobSpec, graceMs: number) => {
    const due = s.dueAt.getTime();
    if (due + graceMs >= nowMs && due <= nowMs + 26 * HOUR) specs.push(s);
  };

  for (const ws of workspaces) {
    if (ws.status !== "active") continue;
    const tz = ws.timezone || "Asia/Kolkata";
    const today = localDate(now, tz);
    for (const date of [addDays(today, -1), today, addDays(today, 1)]) {
      // workspace-level recalculation uses the workspace brief time
      add({
        workspaceId: ws.id, type: "brief.recalc", payload: { date },
        dueAt: slot(date, ws.settings.briefTime, -60, tz), dedupeKey: `brief.recalc:${ws.id}:${date}`,
      }, 12 * HOUR);

      for (const m of ws.members) {
        const s = m.settings;
        const workday = s.workdays.includes(isoWeekday(date));
        const base = { date, userId: m.userId };
        const key = (job: string) => `brief.${job}:${ws.id}:${m.userId}:${date}`;
        if (workday || s.weekendBrief) {
          add({ workspaceId: ws.id, type: "brief.plan", payload: base, dueAt: slot(date, s.briefTime, -40, tz), dedupeKey: key("plan") }, 12 * HOUR);
          add({ workspaceId: ws.id, type: "brief.generate", payload: base, dueAt: slot(date, s.briefTime, -20, tz), dedupeKey: key("generate") }, 12 * HOUR);
          add({ workspaceId: ws.id, type: "brief.health_check", payload: base, dueAt: slot(date, s.briefTime, -5, tz), dedupeKey: key("health_check") }, 30 * MIN);
          add({ workspaceId: ws.id, type: "brief.deliver", payload: base, dueAt: slot(date, s.briefTime, 0, tz), dedupeKey: key("deliver") }, 12 * HOUR);
          add({ workspaceId: ws.id, type: "brief.health_alert", payload: base, dueAt: slot(date, s.briefTime, 5, tz), dedupeKey: key("health_alert") }, 2 * HOUR);
        }
        if (workday) {
          add({ workspaceId: ws.id, type: "brief.reconcile", payload: base, dueAt: slot(date, s.debriefTime, 0, tz), dedupeKey: key("reconcile") }, 3 * HOUR);
        }
        if (isoWeekday(date) === s.weeklyReview.weekday) {
          const week = isoWeekKey(date);
          add({
            workspaceId: ws.id, type: "brief.weekly", payload: { ...base, week },
            dueAt: slot(date, s.weeklyReview.time, 0, tz), dedupeKey: `brief.weekly:${ws.id}:${m.userId}:${week}`,
          }, 24 * HOUR);
        }
      }
    }
  }

  // pre-meeting briefs
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  for (const mt of meetings) {
    const ws = wsById.get(mt.workspaceId);
    if (!ws || ws.status !== "active") continue;
    if (mt.status === "cancelled" || mt.status === "completed" || mt.archivedAt) continue;
    const start = Date.parse(mt.startAt);
    if (start <= nowMs || start > nowMs + 26 * HOUR) continue;
    const owner = ws.members.find((m) => m.userId === mt.ownerUserId) ?? ws.members.find((m) => m.role === "owner");
    if (!owner) continue;
    const lead = owner.settings.preMeetingLeadMinutes * MIN;
    const version = meetingVersionKey(mt);
    const due = new Date(Math.max(start - lead, nowMs));
    specs.push({
      workspaceId: ws.id, type: "brief.pre_meeting",
      payload: { meetingId: mt.id, versionKey: version, userId: owner.userId, startAt: new Date(start).toISOString() },
      dueAt: due, dedupeKey: `brief.pre_meeting:${ws.id}:${mt.id}:${version}`,
    });
  }
  return specs;
}

export interface QueuedPreMeetingJob { id: string; workspaceId: string; payload: { meetingId?: string; versionKey?: string } }

/** Queued T-60 jobs whose meeting was cancelled, deleted/archived or rescheduled (version changed). */
export function staleMeetingJobs(jobs: QueuedPreMeetingJob[], meetings: MeetingCtx[]): { id: string; reason: string }[] {
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const out: { id: string; reason: string }[] = [];
  for (const j of jobs) {
    const m = j.payload.meetingId ? byId.get(j.payload.meetingId) : undefined;
    if (!m || m.archivedAt) out.push({ id: j.id, reason: "meeting deleted" });
    else if (m.status === "cancelled") out.push({ id: j.id, reason: "meeting cancelled" });
    else if (meetingVersionKey(m) !== j.payload.versionKey) out.push({ id: j.id, reason: "meeting rescheduled" });
  }
  return out;
}

/** Is `at` inside a DND window ("22:00"-"07:00" wraps midnight) in tz? */
export function inDnd(at: Date, dnd: { start: string; end: string }, tz: string): boolean {
  const date = localDate(at, tz);
  const t = at.getTime();
  const start = atLocal(date, dnd.start, tz).getTime();
  const end = atLocal(date, dnd.end, tz).getTime();
  if (start === end) return false;
  if (start < end) return t >= start && t < end;
  return t >= start || t < end; // wraps midnight
}

/** Next instant the DND window ends (for deferring alerts). */
export function dndEnd(at: Date, dnd: { start: string; end: string }, tz: string): Date {
  const date = localDate(at, tz);
  const endToday = atLocal(date, dnd.end, tz);
  return endToday.getTime() > at.getTime() ? endToday : atLocal(addDays(date, 1), dnd.end, tz);
}
