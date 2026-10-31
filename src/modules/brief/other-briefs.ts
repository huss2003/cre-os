/**
 * Pre-meeting (T-60), 20:30 reconciliation and Friday weekly review content. PURE, deterministic.
 */
import type { MeetingView, PipelineInput, TaskLite } from "./builder";
import { effectiveTaskState } from "./builder";
import type { RadarItem } from "./lease-radar";
import type { SourceStatus } from "./source-health";

export interface PreMeetingInputs {
  meeting: MeetingView & { versionKey: string };
  org: { id: string; name: string } | null;
  score: { total: number; tier: string; why: string; components: { label: string; points: number; max: number; band: string }[] } | null;
  openTasks: TaskLite[];
  recent: { occurredAt: string; channel: string; direction: string | null; subject: string | null; summary: string | null }[];
  radar: RadarItem[];
  opportunity: { name: string; stage: string; nextAction: string | null; nextActionDue: string | null } | null;
}

export function buildPreMeetingBrief(i: PreMeetingInputs) {
  const questions: string[] = [];
  for (const r of i.radar) {
    if (r.status === "dates_unknown") questions.push(`Confirm lease expiry${r.assetName ? ` at ${r.assetName}` : ""} — not on record`);
    if (r.status === "expired_needs_confirmation") questions.push(`Lease${r.assetName ? ` at ${r.assetName}` : ""} expired ${r.expiry?.date}: renewed, moved or holding over?`);
    if (r.expiry && !r.expiry.verified) questions.push(`Verify expiry ${r.expiry.date} (${r.expiry.basisLabel})`);
  }
  if (i.score) for (const c of i.score.components) if (c.points === 0 && (c.label.startsWith("Budget") || c.label.startsWith("Size"))) questions.push(`Ask about ${c.label.toLowerCase()} (currently unknown)`);
  return {
    schema: "brief.pre_meeting.v1",
    meeting: i.meeting,
    org: i.org,
    score: i.score,
    opportunity: i.opportunity,
    openTasks: i.openTasks.slice(0, 10),
    recent: i.recent.slice(0, 5),
    leases: i.radar.map((r) => ({ leaseId: r.leaseId, asset: r.assetName, expiry: r.expiry?.date ?? null, basis: r.expiry?.basisLabel ?? null, notice: r.noticeDeadline?.date ?? null, status: r.status })),
    questions: [...new Set(questions)].slice(0, 6),
  };
}

export function buildReconciliation(i: { date: string; now: string; tasks: (TaskLite & { completedAt?: string | null })[]; doneToday: TaskLite[]; housekeeping: { woken: number; staled: number }; tomorrowMeetings: MeetingView[]; tomorrowTargets: { name: string; total: number }[]; staleAfterDays: number }) {
  const endOfDay = `${i.date}T23:59:59.999Z`;
  const dueTodayOpen = i.tasks.filter((t) => t.dueAt && t.dueAt.slice(0, 10) <= i.date && t.dueAt <= endOfDay && effectiveTaskState(t, i.now, i.staleAfterDays) !== "snoozed");
  return {
    schema: "brief.reconciliation.v1",
    date: i.date,
    done: i.doneToday.map((t) => ({ id: t.id, title: t.title })),
    stillOpen: dueTodayOpen.map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt })),
    housekeeping: i.housekeeping,
    tomorrow: { meetings: i.tomorrowMeetings.length, firstMeeting: i.tomorrowMeetings[0]?.startAt ?? null, topTargets: i.tomorrowTargets.slice(0, 5) },
    prompt: dueTodayOpen.length ? `${dueTodayOpen.length} promise(s) still open — complete with evidence, snooze, or reschedule.` : "All of today's due items are closed.",
  };
}

export function buildWeekly(i: { week: string; date: string; approachesThisMonth: number; cohortTarget: { minimum: number; pace: number }; doneThisWeek: number; overdue: number; stale: number; pipeline: PipelineInput; sources: SourceStatus[]; scoredAccounts: number; actThisWeek: number }) {
  return {
    schema: "brief.weekly.v1",
    week: i.week,
    date: i.date,
    funnel: { approachesThisMonth: i.approachesThisMonth, minimum: i.cohortTarget.minimum, pace: i.cohortTarget.pace },
    tasks: { doneThisWeek: i.doneThisWeek, overdue: i.overdue, stale: i.stale },
    pipeline: i.pipeline,
    accounts: { scored: i.scoredAccounts, actThisWeek: i.actThisWeek },
    dataFreshness: i.sources.map((s) => ({ source: s.label, state: s.state, lastSuccessAt: s.lastSuccessAt })),
  };
}
