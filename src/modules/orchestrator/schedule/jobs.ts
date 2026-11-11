import "server-only";
/**
 * Orchestrator scheduling jobs (spec §4, phases 2 & 5). `schedule(now)` runs on every /api/cron/tick and only
 * enqueues dedupe-keyed durable jobs (survive restarts). Keys:
 *   orchestrator.daily_plan:<ws>:<user>:<local date>     at the user's dailyPlanTime (default 08:00) in their timezone
 *   orchestrator.weekly_review:<ws>:<user>:<ISO week>    on the configured weekday/time
 *   orchestrator.sweep:<ws>:<UTC quarter-hour>           meeting prep (re)scheduling, completed-meeting detection,
 *                                                        obsolete-notification cancel
 *   orchestrator.hourly:<ws>:<UTC hour>                  overdue commitments (Workflow F) + budget alerts
 *   orchestrator.meeting_prep:<prep>:<start ISO>         ~1 h before each meeting (see meetings.ts)
 *   orchestrator.post_meeting:<prep>                     once per completed meeting
 *   orchestrator.plan_ai:<ws>:<user>:<date>              retry of a delayed AI headline
 * Keys that exist in ANY state are not re-created (a cancelled/dead job is not silently resurrected).
 */
import type { Job, JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Db } from "@/lib/supabase/server";
import { atLocal, localDate } from "@/lib/util/time";
import { isoWeekKey, isoWeekday } from "@/modules/brief/dates";
import { budgetAlerts } from "../budget/service";
import { sweepObsolete } from "../notify/service";
import { runOverdueCommitments } from "./commitments";
import { retryPlanAi, runDailyPlan } from "./daily-plan";
import { detectCompletedMeetings, POST_JOB, PREP_JOB, runMeetingPrep, runPostMeeting, scheduleMeetingPreps } from "./meetings";
import { loadAllMemberSettings } from "./settings-db";
import type { OrchSettings } from "./settings";
import { runWeeklyReview } from "./weekly";

export interface SlotSpec { workspaceId: string; type: string; dedupeKey: string; dueAt: Date; payload: Record<string, unknown> }

/** Pure: the daily-plan and weekly-review jobs for one member at `now` (local date in their timezone). */
export function memberSlots(now: Date, workspaceId: string, userId: string, s: OrchSettings): SlotSpec[] {
  const date = localDate(now, s.timezone);
  const out: SlotSpec[] = [];
  const workday = s.workdays.includes(isoWeekday(date));
  if (workday || s.brief.weekendBrief) {
    out.push({ workspaceId, type: "orchestrator.daily_plan", dedupeKey: `orchestrator.daily_plan:${workspaceId}:${userId}:${date}`, dueAt: atLocal(date, s.dailyPlanTime, s.timezone), payload: { userId, date } });
  }
  if (isoWeekday(date) === s.weeklyReview.weekday) {
    const week = isoWeekKey(date);
    out.push({ workspaceId, type: "orchestrator.weekly_review", dedupeKey: `orchestrator.weekly_review:${workspaceId}:${userId}:${week}`, dueAt: atLocal(date, s.weeklyReview.time, s.timezone), payload: { userId, week } });
  }
  return out;
}

export function workspaceSlots(now: Date, workspaceId: string): SlotSpec[] {
  const hour = now.toISOString().slice(0, 13);
  const quarter = `${hour}:${String(Math.floor(now.getUTCMinutes() / 15) * 15).padStart(2, "0")}`;
  return [
    { workspaceId, type: "orchestrator.sweep", dedupeKey: `orchestrator.sweep:${workspaceId}:${quarter}`, dueAt: now, payload: {} },
    { workspaceId, type: "orchestrator.hourly", dedupeKey: `orchestrator.hourly:${workspaceId}:${hour}`, dueAt: now, payload: {} },
  ];
}

/** Enqueue specs whose keys do not exist yet (any state). Exported for tests. */
export async function enqueueSpecs(admin: Db, specs: SlotSpec[]): Promise<number> {
  if (!specs.length) return 0;
  const existing = new Set<string>();
  const keys = specs.map((s) => s.dedupeKey);
  for (let i = 0; i < keys.length; i += 100) {
    const { data, error } = await admin.from("job").select("dedupe_key").in("dedupe_key", keys.slice(i, i + 100));
    if (error) throw error;
    for (const r of data ?? []) existing.add(r.dedupe_key);
  }
  let n = 0;
  for (const s of specs) {
    if (existing.has(s.dedupeKey)) continue;
    await enqueue({ workspaceId: s.workspaceId, type: s.type, payload: s.payload, dueAt: s.dueAt, dedupeKey: s.dedupeKey, maxAttempts: s.type === "orchestrator.daily_plan" ? 4 : 3 });
    n++;
  }
  return n;
}

export async function schedule(now: Date, admin: Db = createAdminClient(), opts: { workspaceIds?: string[] } = {}): Promise<{ enqueued: number }> {
  let q = admin.from("workspace").select("id").eq("status", "active");
  if (opts.workspaceIds) q = q.in("id", opts.workspaceIds);
  const { data: wss, error } = await q;
  if (error) throw error;
  const ids = ((wss ?? []) as { id: string }[]).map((w) => w.id);
  const members = await loadAllMemberSettings(admin, ids);
  const specs = [
    ...ids.flatMap((id) => workspaceSlots(now, id)),
    ...members.flatMap((m) => memberSlots(now, m.workspaceId, m.userId, m.settings)),
  ];
  return { enqueued: await enqueueSpecs(admin, specs) };
}

const needWs = (job: Job) => { if (!job.workspace_id) throw new Error("workspace required"); return job.workspace_id; };
const p = (job: Job) => job.payload as Record<string, any>;

export async function runSweep(admin: Db, ws: string, now = new Date()) {
  const prep = await scheduleMeetingPreps(admin, ws, { now });
  const completed = await detectCompletedMeetings(admin, ws, { now });
  const obsolete = await sweepObsolete(admin, ws);
  return { ...prep, postMeeting: completed, obsoleteNotifications: obsolete };
}

export const handlers: Record<string, JobHandler> = {
  "orchestrator.daily_plan": async (job) => runDailyPlan(createAdminClient(), needWs(job), p(job).userId),
  "orchestrator.plan_ai": async (job) => retryPlanAi(createAdminClient(), needWs(job), p(job).userId, p(job).date),
  "orchestrator.weekly_review": async (job) => runWeeklyReview(createAdminClient(), needWs(job), p(job).userId),
  "orchestrator.sweep": async (job) => runSweep(createAdminClient(), needWs(job)),
  "orchestrator.hourly": async (job) => {
    const admin = createAdminClient(), ws = needWs(job);
    return { commitments: await runOverdueCommitments(admin, ws), budgets: await budgetAlerts(admin, ws) };
  },
  [PREP_JOB]: async (job) => runMeetingPrep(createAdminClient(), needWs(job), p(job) as { prepId: string; startAt: string }),
  [POST_JOB]: async (job) => runPostMeeting(createAdminClient(), needWs(job), p(job).prepId),
};

/** Registration entry used by src/lib/jobs/registry.ts (module shape: { handlers, schedule }). */
export function register() { return { handlers, schedule: (now: Date) => schedule(now) }; }
