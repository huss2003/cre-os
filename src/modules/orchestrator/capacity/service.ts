import "server-only";
/**
 * Calendar-aware capacity for one user + local date (spec §8). Meetings come from meeting_visit (manual, .ics and
 * synced calendar records share that table); tasks from the task table + task_schedule (estimates, class, user
 * override). No routing service is authorised in CRE OS, so travel time is always reported as unknown.
 */
import type { Db } from "@/lib/supabase/server";
import { loadMeetings, loadOpenTasks } from "@/modules/brief/data";
import { addDays, isoWeekday } from "@/modules/brief/dates";
import { loadOpenDeals, loadOverdueCommitments, loadPrepStatus, urgentProposals, type LoadCtx } from "../schedule/data";
import type { OrchSettings } from "../schedule/settings";
import { classifyTask, planCapacity, PRIORITY_CLASSES, type CapacityResult, type CapTask, type PriorityClass } from "./capacity";

/** No mapping/routing integration is configured in CRE OS; flip only when an authorised service is added. */
export const ROUTING_AVAILABLE = false;

export async function loadCapacity(c: LoadCtx, s: OrchSettings, date: string, now = new Date()): Promise<CapacityResult> {
  const [meetings, tasks, commitments, deals] = await Promise.all([
    loadMeetings(c, date), loadOpenTasks(c), loadOverdueCommitments(c, date, { mineOnly: true }).catch(() => []), loadOpenDeals(c).catch(() => []),
  ]);
  const prep = await loadPrepStatus(c, meetings.map((m) => m.id)).catch(() => new Map());
  const endOfDay = `${addDays(date, 1)}T00:00:00Z`;
  const relevant = tasks.filter((t) => t.status === "open" && (!t.dueAt || t.dueAt < endOfDay));
  const ids = relevant.map((t) => t.id);
  const sched = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await c.db.from("task_schedule").select("task_id, estimated_minutes, priority_class, scheduled_start, scheduled_end, user_override").eq("workspace_id", c.workspaceId).in("task_id", ids.slice(i, i + 200));
    for (const r of data ?? []) sched.set(r.task_id, r);
  }
  const { data: keys } = ids.length ? await c.db.from("task").select("id, idempotency_key").eq("workspace_id", c.workspaceId).in("id", ids.slice(0, 500)) : { data: [] };
  const keyOf = new Map(((keys ?? []) as any[]).map((k) => [k.id, k.idempotency_key]));
  const capTasks: CapTask[] = relevant.map((t) => {
    const sc = sched.get(t.id);
    return {
      id: t.id, title: t.title, dueAt: t.dueAt, priority: t.priority, source: t.source, linkedEntityType: t.linkedEntityType, idempotencyKey: keyOf.get(t.id) ?? null,
      estimatedMinutes: sc?.estimated_minutes ?? null, priorityClass: sc?.priority_class ?? null,
      scheduledStart: sc?.scheduled_start ?? null, scheduledEnd: sc?.scheduled_end ?? null, userOverride: !!sc?.user_override,
    };
  });
  let next = addDays(date, 1);
  for (let k = 0; k < 7 && !s.workdays.includes(isoWeekday(next)); k++) next = addDays(next, 1);
  const overdueTaskCommitments = capTasks.filter((t) => t.dueAt && Date.parse(t.dueAt) < +now && classifyTask(t, now.toISOString()).cls === "critical_client_commitment");
  return planCapacity({
    date, tz: s.timezone, now: now.toISOString(), workingHours: s.workingHours, limits: s.capacity,
    meetings: meetings.map((m) => ({ id: m.id, title: m.title, startAt: m.startAt, endAt: m.endAt, kind: m.kind, status: m.status, location: m.location, needsPrep: m.kind !== "internal", prepReady: !!prep.get(m.id)?.briefFresh })),
    tasks: capTasks,
    overdueCommitments: [...commitments.map((x) => ({ id: x.id, title: x.title })), ...overdueTaskCommitments.filter((t) => !commitments.some((x) => x.key === keyOf.get(t.id)?.replace(/^brief\./, ""))).map((t) => ({ id: t.id, title: t.title }))],
    urgentProposals: urgentProposals(deals, date),
    routingAvailable: ROUTING_AVAILABLE, nextWorkday: next,
  });
}

export class CapacityError extends Error {}

/** User override / estimate for a task (user client, RLS). Overrides are honoured as fixed blocks by planCapacity. */
export async function setTaskSchedule(db: Db, ws: string, userId: string, taskId: string, f: { estimatedMinutes?: number | null; priorityClass?: PriorityClass | null; start?: string | null; end?: string | null }) {
  const { data: t } = await db.from("task").select("id, classification, owner_user_id").eq("workspace_id", ws).eq("id", taskId).maybeSingle();
  if (!t) throw new CapacityError("Task not found.");
  if (f.priorityClass && !(PRIORITY_CLASSES as readonly string[]).includes(f.priorityClass)) throw new CapacityError("Unknown priority class.");
  if (f.estimatedMinutes != null && !(Number.isInteger(f.estimatedMinutes) && f.estimatedMinutes > 0 && f.estimatedMinutes <= 1440)) throw new CapacityError("Estimate must be 1–1440 minutes.");
  if ((f.start && !f.end) || (!f.start && f.end) || (f.start && f.end && Date.parse(f.end) <= Date.parse(f.start))) throw new CapacityError("Give a start and a later end.");
  const row = {
    workspace_id: ws, task_id: taskId, owner_user_id: t.owner_user_id ?? userId, classification: t.classification,
    ...(f.estimatedMinutes !== undefined ? { estimated_minutes: f.estimatedMinutes } : {}),
    ...(f.priorityClass !== undefined ? { priority_class: f.priorityClass } : {}),
    ...(f.start !== undefined ? { scheduled_start: f.start, scheduled_end: f.end, user_override: !!f.start } : {}),
  };
  const { data, error } = await db.from("task_schedule").upsert(row, { onConflict: "task_id" }).select("*").single();
  if (error) throw error;
  return data;
}

