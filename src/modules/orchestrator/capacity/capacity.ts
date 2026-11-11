/**
 * Daily capacity and priority management (pure, spec §8). Plans work around the user's real day: meetings (from
 * meeting_visit / synced calendar records) are fixed; tasks are ranked by priority class and fitted into free working
 * time; anything that does not fit becomes a rescheduling SUGGESTION (never more tasks). Travel time is never
 * invented: without an authorised routing service it is reported as "travel time unknown".
 */
import { atLocal } from "@/lib/util/time";

export const PRIORITY_CLASSES = [
  "critical_client_commitment",
  "time_sensitive_transaction",
  "meeting_preparation",
  "important_follow_up",
  "commercial_proposal_deadline",
  "routine_account_research",
  "background_data_refresh",
  "non_urgent_maintenance",
] as const;
export type PriorityClass = (typeof PRIORITY_CLASSES)[number];

export const CLASS_LABEL: Record<PriorityClass, string> = {
  critical_client_commitment: "Critical client commitment",
  time_sensitive_transaction: "Time-sensitive transaction work",
  meeting_preparation: "Meeting preparation",
  important_follow_up: "Important follow-up",
  commercial_proposal_deadline: "Commercial proposal deadline",
  routine_account_research: "Routine account research",
  background_data_refresh: "Background data refresh",
  non_urgent_maintenance: "Non-urgent system maintenance",
};

export interface CapTask {
  id: string; title: string; dueAt: string | null; priority: number; source: string | null;
  linkedEntityType: string | null; idempotencyKey?: string | null;
  estimatedMinutes?: number | null; priorityClass?: PriorityClass | null;
  scheduledStart?: string | null; scheduledEnd?: string | null; userOverride?: boolean;
}
export interface CapMeeting { id: string; title: string | null; startAt: string; endAt: string; kind: string; status: string; location: string | null; needsPrep?: boolean; prepReady?: boolean }
export interface CapProposal { id: string; title: string; due: string }

/** Deterministic class rules (code, not a model). Returns class + the rule that fired. */
export function classifyTask(t: CapTask, nowIso: string): { cls: PriorityClass; why: string } {
  if (t.priorityClass && (PRIORITY_CLASSES as readonly string[]).includes(t.priorityClass)) return { cls: t.priorityClass, why: "Set by user" };
  const title = t.title.toLowerCase();
  const key = t.idempotencyKey ?? "";
  const dueSoon = !!t.dueAt && Date.parse(t.dueAt) - Date.parse(nowIso) <= 2 * 864e5;
  if (t.linkedEntityType === "interaction" || /caretaker:promise|^meeting:[^:]+:\d+$/.test(key) || /^deliver\b|commit/.test(title))
    return { cls: "critical_client_commitment", why: "A commitment made to a client" };
  if (["opportunity", "deal_milestone", "lease", "lease_event"].includes(t.linkedEntityType ?? "") && dueSoon)
    return { cls: "time_sensitive_transaction", why: "Deal / lease work due within 2 days" };
  if (["meeting_prep", "meeting_visit"].includes(t.linkedEntityType ?? "") || /^prepare\b/.test(title))
    return { cls: "meeting_preparation", why: "Preparation for a meeting" };
  if (["quote", "finance_scenario", "toolkit_analysis", "proposal"].includes(t.linkedEntityType ?? "") || /proposal|quotation|quote\b/.test(title))
    return { cls: "commercial_proposal_deadline", why: "Commercial proposal work" };
  if (["person", "outreach_item", "draft"].includes(t.linkedEntityType ?? "") || /follow[ -]?up|chase|reply/.test(title) || t.source === "capture")
    return { cls: "important_follow_up", why: "Follow-up with a contact" };
  if (["opportunity", "deal_milestone"].includes(t.linkedEntityType ?? "")) return { cls: "time_sensitive_transaction", why: "Active deal work" };
  if (t.source === "import" || t.source === "connector" || /refresh|re-?sync|enrich/.test(title)) return { cls: "background_data_refresh", why: "Data refresh" };
  if (/research|find |identify|verify/.test(title) || t.source === "brief") return { cls: "routine_account_research", why: "Account research" };
  if (t.priority < 40) return { cls: "non_urgent_maintenance", why: "Low priority" };
  return { cls: "important_follow_up", why: "Default for client work" };
}

export const rankOf = (c: PriorityClass) => PRIORITY_CLASSES.indexOf(c);

export interface Slot { start: string; end: string; minutes: number }
export interface Warning { kind: "too_many_meetings" | "overdue_commitments" | "urgent_proposals" | "insufficient_prep" | "travel_conflict" | "over_capacity" | "overlap"; severity: "urgent" | "info"; message: string; refs: string[] }
export interface Suggestion { kind: "reschedule" | "prep_slot" | "decline_or_move_meeting"; ref: string; title: string; reason: string; proposedDate?: string | null; proposedStart?: string | null }
export interface Placement { taskId: string; title: string; cls: PriorityClass; why: string; start: string; end: string; overridden: boolean }

export interface CapacityInput {
  date: string; tz: string; now: string;
  workingHours: { start: string; end: string };
  limits: { maxMeetings: number; maxOverdueCommitments: number; maxUrgentProposals: number; prepMinutes: number; defaultTaskMinutes: number };
  meetings: CapMeeting[];
  tasks: CapTask[];                 // open tasks for the user (overdue + due today/soon + undated)
  overdueCommitments: { id: string; title: string }[];
  urgentProposals: CapProposal[];
  routingAvailable: boolean;        // an authorised routing/mapping service is configured
  nextWorkday: string | null;
}

export interface CapacityResult {
  date: string;
  workingMinutes: number; meetingMinutes: number; freeMinutes: number; demandMinutes: number;
  freeSlots: Slot[];
  placed: Placement[];
  unplaced: { taskId: string; title: string; cls: PriorityClass; minutes: number }[];
  conflicts: Warning[];
  warnings: Warning[];
  suggestions: Suggestion[];
  travel: { from: string; to: string; gapMinutes: number; status: "unknown" | "estimated"; message: string }[];
}

const ms = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();
const IN_PERSON = new Set(["meeting", "site_visit"]);

function subtract(free: [number, number][], busy: [number, number]): [number, number][] {
  const out: [number, number][] = [];
  for (const [s, e] of free) {
    if (busy[1] <= s || busy[0] >= e) { out.push([s, e]); continue; }
    if (busy[0] > s) out.push([s, busy[0]]);
    if (busy[1] < e) out.push([busy[1], e]);
  }
  return out;
}

export function planCapacity(i: CapacityInput): CapacityResult {
  const dayStart = atLocal(i.date, i.workingHours.start, i.tz).getTime();
  const dayEnd = atLocal(i.date, i.workingHours.end, i.tz).getTime();
  const now = ms(i.now);
  const meetings = i.meetings.filter((m) => m.status !== "cancelled").sort((a, b) => a.startAt.localeCompare(b.startAt));
  const conflicts: Warning[] = [], warnings: Warning[] = [], suggestions: Suggestion[] = [];

  // overlaps
  for (let a = 0; a < meetings.length; a++) for (let b = a + 1; b < meetings.length; b++) {
    if (ms(meetings[b].startAt) < ms(meetings[a].endAt)) conflicts.push({ kind: "overlap", severity: "urgent", refs: [meetings[a].id, meetings[b].id], message: `"${meetings[a].title ?? "Meeting"}" overlaps "${meetings[b].title ?? "Meeting"}"` });
  }
  // travel between consecutive in-person meetings — never invented
  const travel: CapacityResult["travel"] = [];
  for (let k = 1; k < meetings.length; k++) {
    const p = meetings[k - 1], c = meetings[k];
    if (!IN_PERSON.has(p.kind) || !IN_PERSON.has(c.kind) || !p.location || !c.location) continue;
    if (p.location.trim().toLowerCase() === c.location.trim().toLowerCase()) continue;
    const gap = Math.round((ms(c.startAt) - ms(p.endAt)) / 60_000);
    travel.push({ from: p.location, to: c.location, gapMinutes: gap, status: "unknown", message: i.routingAvailable ? "Travel time to be estimated by the routing service" : `Travel time unknown — no authorised routing service (${gap} min between meetings)` });
    if (gap < 15) warnings.push({ kind: "travel_conflict", severity: "urgent", refs: [p.id, c.id], message: `Only ${gap} min between "${p.title ?? "meeting"}" (${p.location}) and "${c.title ?? "meeting"}" (${c.location}); travel time unknown` });
  }

  // free time inside working hours, after now
  let free: [number, number][] = [[Math.max(dayStart, Math.min(dayEnd, now > dayStart ? now : dayStart)), dayEnd]];
  if (free[0][0] >= free[0][1]) free = [];
  let meetingMinutes = 0;
  for (const m of meetings) {
    const s = Math.max(ms(m.startAt), dayStart), e = Math.min(ms(m.endAt), dayEnd);
    if (e > s) meetingMinutes += (e - s) / 60_000;
    free = subtract(free, [ms(m.startAt), ms(m.endAt)]);
  }
  const workingMinutes = Math.max(0, (dayEnd - dayStart) / 60_000);

  if (meetings.length > i.limits.maxMeetings) {
    warnings.push({ kind: "too_many_meetings", severity: "urgent", refs: meetings.map((m) => m.id), message: `${meetings.length} meetings today (your limit is ${i.limits.maxMeetings})` });
    const movable = meetings.filter((m) => m.kind === "internal" || m.kind === "call").slice(-(meetings.length - i.limits.maxMeetings));
    for (const m of movable) suggestions.push({ kind: "decline_or_move_meeting", ref: m.id, title: m.title ?? "Meeting", reason: "Internal / call — easiest to move", proposedDate: i.nextWorkday });
  }
  if (i.overdueCommitments.length >= i.limits.maxOverdueCommitments)
    warnings.push({ kind: "overdue_commitments", severity: "urgent", refs: i.overdueCommitments.map((c) => c.id), message: `${i.overdueCommitments.length} client commitments are overdue` });
  if (i.urgentProposals.length >= i.limits.maxUrgentProposals)
    warnings.push({ kind: "urgent_proposals", severity: "urgent", refs: i.urgentProposals.map((p) => p.id), message: `${i.urgentProposals.length} commercial proposals are due within 2 days` });

  // fixed user-overridden task blocks
  const placed: Placement[] = [];
  const tasks = i.tasks.map((t) => ({ t, ...classifyTask(t, i.now), minutes: t.estimatedMinutes ?? i.limits.defaultTaskMinutes }));
  for (const x of tasks.filter((x) => x.t.userOverride && x.t.scheduledStart && x.t.scheduledEnd)) {
    free = subtract(free, [ms(x.t.scheduledStart!), ms(x.t.scheduledEnd!)]);
    placed.push({ taskId: x.t.id, title: x.t.title, cls: x.cls, why: x.why, start: x.t.scheduledStart!, end: x.t.scheduledEnd!, overridden: true });
  }

  // preparation slots before meetings that need prep (and are not ready)
  for (const m of meetings.filter((m) => m.needsPrep && !m.prepReady && ms(m.startAt) > now)) {
    const need = i.limits.prepMinutes * 60_000;
    const slot = free.filter(([s, e]) => e <= ms(m.startAt) && e - s >= need).pop();
    if (!slot) {
      warnings.push({ kind: "insufficient_prep", severity: "urgent", refs: [m.id], message: `No ${i.limits.prepMinutes}-minute gap before "${m.title ?? "meeting"}" to prepare` });
      continue;
    }
    const s = slot[1] - need;
    free = subtract(free, [s, slot[1]]);
    suggestions.push({ kind: "prep_slot", ref: m.id, title: `Prepare: ${m.title ?? "meeting"}`, reason: "Free time before the meeting", proposedStart: iso(s) });
  }

  // rank and fit remaining tasks (class, then due, then priority)
  const queue = tasks.filter((x) => !(x.t.userOverride && x.t.scheduledStart)).sort((a, b) =>
    rankOf(a.cls) - rankOf(b.cls) || (a.t.dueAt ?? "9999").localeCompare(b.t.dueAt ?? "9999") || b.t.priority - a.t.priority);
  const unplaced: CapacityResult["unplaced"] = [];
  for (const x of queue) {
    const need = x.minutes * 60_000;
    const idx = free.findIndex(([s, e]) => e - s >= need);
    if (idx < 0) { unplaced.push({ taskId: x.t.id, title: x.t.title, cls: x.cls, minutes: x.minutes }); continue; }
    const [s] = free[idx];
    free = subtract(free, [s, s + need]);
    placed.push({ taskId: x.t.id, title: x.t.title, cls: x.cls, why: x.why, start: iso(s), end: iso(s + need), overridden: false });
  }
  const demandMinutes = tasks.reduce((n, x) => n + x.minutes, 0);
  if (unplaced.length) {
    warnings.push({ kind: "over_capacity", severity: "info", refs: unplaced.map((u) => u.taskId), message: `${unplaced.length} task${unplaced.length === 1 ? "" : "s"} do not fit today's free time` });
    // lowest classes move first — realistic rescheduling instead of more tasks
    for (const u of [...unplaced].sort((a, b) => rankOf(b.cls) - rankOf(a.cls)))
      suggestions.push({ kind: "reschedule", ref: u.taskId, title: u.title, reason: `${CLASS_LABEL[u.cls]} — no free ${u.minutes}-minute slot today`, proposedDate: i.nextWorkday });
  }
  const freeSlots = free.filter(([s, e]) => e - s >= 5 * 60_000).map(([s, e]) => ({ start: iso(s), end: iso(e), minutes: Math.round((e - s) / 60_000) }));
  return {
    date: i.date, workingMinutes, meetingMinutes: Math.round(meetingMinutes), freeMinutes: freeSlots.reduce((n, f) => n + f.minutes, 0), demandMinutes,
    freeSlots, placed: placed.sort((a, b) => a.start.localeCompare(b.start)), unplaced, conflicts, warnings, suggestions, travel,
  };
}
