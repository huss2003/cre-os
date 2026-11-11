/**
 * Daily 08:00 plan + weekly review section builders (pure, spec §4.2 / §4.5). Deterministic: these ARE the fallback
 * when the AI provider is unavailable — AI only adds an optional headline, which is then marked "delayed".
 */
import { stableHashLite } from "./hash";

export interface PlanMeeting { id: string; title: string | null; startAt: string; endAt: string; kind: string; status: string; location: string | null; prep: { prepId: string; status: string; briefFresh: boolean; missing: string[]; critical: string[] } | null }
export interface PlanTask { id: string; title: string; dueAt: string | null; priority: number; status: string; linkedEntityType: string | null; linkedEntityId: string | null; source: string | null }
export interface Rec { title: string; why: string; href: string; ref: string }
export interface SectionOut<T = unknown> { state: "ok" | "unavailable"; items: T[]; note: string | null }

export interface DailyInputs {
  date: string; now: string;
  meetingsToday: SectionOut<PlanMeeting>;
  meetingsSoon: PlanMeeting[];                    // next 24 h (prep window)
  brief: { id: string; targets: { orgId: string; name: string; total: number; why?: string | null }[]; deadlines: { leaseId: string; tenant: string; kind: string; date: string; days: number; basisLabel: string; verified: boolean }[] } | null;
  briefError: string | null;
  signals: SectionOut<{ id: string; title: string; confidence: string; verification: string; href: string }>;
  tasks: SectionOut<PlanTask>;
  commitments: SectionOut<{ id: string; title: string; due: string; href: string; kind: string }>;
  deals: SectionOut<{ id: string; name: string; stage: string; reason: string; href: string; due: string | null }>;
  approvals: { changes: number; drafts: number; oldestAt: string | null } | null;
}

export const DAILY_SECTIONS = [
  "todays_meetings", "meetings_needing_prep", "priority_accounts", "new_signals", "lease_alerts",
  "followups_due_today", "overdue_commitments", "deals_attention", "pending_approvals", "recommended_actions",
] as const;

const ok = <T>(items: T[], note: string | null = null): SectionOut<T> => ({ state: "ok", items, note });
const na = <T>(note: string): SectionOut<T> => ({ state: "unavailable", items: [], note });

export function buildDailySections(i: DailyInputs) {
  const prepNeeded = i.meetingsSoon.filter((m) => m.status !== "cancelled" && m.kind !== "internal" && Date.parse(m.startAt) > Date.parse(i.now)
    && (!m.prep || !m.prep.briefFresh || m.prep.critical.length > 0));
  const dueToday = i.tasks.items.filter((t) => t.dueAt && t.dueAt.slice(0, 10) === i.date && Date.parse(t.dueAt) >= Date.parse(i.now) - 864e5 && t.status === "open");
  const overdueTasks = i.tasks.items.filter((t) => t.status === "open" && t.dueAt && Date.parse(t.dueAt) < Date.parse(i.now) && (t.linkedEntityType === "interaction" || t.source === "meeting"));
  const commitments = i.commitments.state === "ok"
    ? ok([
      ...i.commitments.items,
      ...overdueTasks.filter((t) => !i.commitments.items.some((c) => c.id === t.id)).map((t) => ({ id: t.id, title: t.title, due: t.dueAt!.slice(0, 10), href: `/tasks?q=${encodeURIComponent(t.title.slice(0, 40))}`, kind: "task" })),
    ])
    : i.commitments;
  const sections = {
    todays_meetings: i.meetingsToday.state === "ok"
      ? ok(i.meetingsToday.items.map((m) => ({ id: m.id, title: m.title, start: m.startAt, end: m.endAt, location: m.location, status: m.status, prep: m.prep ? (m.prep.briefFresh ? "Brief ready" : "No current brief") : "No preparation record", href: m.prep ? `/meetings/${m.prep.prepId}` : "/meetings" })))
      : i.meetingsToday,
    meetings_needing_prep: ok(prepNeeded.map((m) => ({ id: m.id, title: m.title, start: m.startAt, missing: m.prep ? [...m.prep.critical, ...m.prep.missing] : ["No preparation record — open the meeting to start one"], href: m.prep ? `/meetings/${m.prep.prepId}` : "/meetings" }))),
    priority_accounts: i.brief ? ok(i.brief.targets.slice(0, 5).map((t) => ({ orgId: t.orgId, name: t.name, score: t.total, why: t.why ?? null, href: `/companies/${t.orgId}` }))) : na(i.briefError ?? "Daily brief not available"),
    new_signals: i.signals,
    lease_alerts: i.brief ? ok(i.brief.deadlines.filter((d) => d.days <= 90).map((d) => ({ ...d, href: `/leases?q=${encodeURIComponent(d.tenant)}` }))) : na(i.briefError ?? "Daily brief not available"),
    followups_due_today: i.tasks.state === "ok" ? ok(dueToday.map((t) => ({ id: t.id, title: t.title, due: t.dueAt, href: "/tasks" }))) : i.tasks,
    overdue_commitments: commitments,
    deals_attention: i.deals,
    pending_approvals: i.approvals ? ok([{ changes: i.approvals.changes, drafts: i.approvals.drafts, oldestAt: i.approvals.oldestAt, href: "/approvals" }]) : na("Approvals could not be loaded"),
    recommended_actions: ok([] as Rec[]),
  };
  sections.recommended_actions = ok(recommend(sections));
  return sections;
}
export type DailySections = ReturnType<typeof buildDailySections>;

/** Deterministic next actions: commitments first, then preparation, deals, approvals, lease windows, follow-ups, signals. */
export function recommend(s: Omit<DailySections, "recommended_actions">, max = 7): Rec[] {
  const r: Rec[] = [];
  for (const c of (s.overdue_commitments.items as any[]).slice(0, 3)) r.push({ title: c.title, why: `Overdue commitment (due ${c.due})`, href: c.href, ref: `commitment:${c.id}` });
  for (const m of (s.meetings_needing_prep.items as any[]).slice(0, 2)) r.push({ title: `Prepare for ${m.title ?? "meeting"}`, why: m.missing.length ? `Missing: ${m.missing.slice(0, 2).join("; ")}` : "No current brief", href: m.href, ref: `meeting:${m.id}` });
  for (const d of (s.deals_attention.items as any[]).slice(0, 2)) r.push({ title: `Move ${d.name} forward`, why: d.reason, href: d.href, ref: `deal:${d.id}` });
  const ap = (s.pending_approvals.items as any[])[0];
  if (ap && ap.changes + ap.drafts > 0) r.push({ title: `Review ${ap.changes + ap.drafts} pending approval${ap.changes + ap.drafts === 1 ? "" : "s"}`, why: "Proposed changes and drafts wait for you", href: "/approvals", ref: "approvals" });
  for (const l of (s.lease_alerts.items as any[]).filter((x) => x.days <= 30).slice(0, 2)) r.push({ title: `${l.tenant}: ${l.kind} on ${l.date}`, why: `${l.days} days away (${l.basisLabel})`, href: l.href, ref: `lease:${l.leaseId}:${l.kind}` });
  for (const t of (s.followups_due_today.items as any[]).slice(0, 2)) r.push({ title: t.title, why: "Due today", href: t.href, ref: `task:${t.id}` });
  for (const sg of (s.new_signals.items as any[]).slice(0, 1)) r.push({ title: `Review signal: ${sg.title}`, why: `New ${sg.confidence}-confidence signal (${sg.verification})`, href: sg.href, ref: `signal:${sg.id}` });
  return r.slice(0, max);
}

export const WEEKLY_SECTIONS = [
  "new_opportunities", "priority_account_changes", "important_signals", "meetings_completed", "meetings_scheduled",
  "followups_completed", "overdue_commitments", "requirements_changed", "active_deals", "stalled_transactions",
  "proposals_pending", "market_developments", "recommended_next_week",
] as const;

export function weeklyRecommendations(s: Record<string, SectionOut<any>>, max = 7): Rec[] {
  const r: Rec[] = [];
  for (const c of (s.overdue_commitments?.items ?? []).slice(0, 2)) r.push({ title: c.title, why: `Overdue since ${c.due}`, href: c.href, ref: `commitment:${c.id}` });
  for (const d of (s.stalled_transactions?.items ?? []).slice(0, 2)) r.push({ title: `Unblock ${d.name}`, why: d.reason, href: d.href, ref: `deal:${d.id}` });
  for (const p of (s.proposals_pending?.items ?? []).slice(0, 2)) r.push({ title: `Progress proposal: ${p.name}`, why: `Stage ${p.stage}`, href: p.href, ref: `deal:${p.id}` });
  for (const m of (s.meetings_scheduled?.items ?? []).slice(0, 1)) r.push({ title: `Prepare for ${m.title ?? "meeting"} (${String(m.start).slice(0, 10)})`, why: "Scheduled next week", href: m.href, ref: `meeting:${m.id}` });
  for (const a of (s.priority_account_changes?.items ?? []).filter((x: any) => x.delta > 0).slice(0, 1)) r.push({ title: `Approach ${a.name}`, why: `Score rose ${a.delta} points`, href: a.href, ref: `org:${a.id}` });
  return r.slice(0, max);
}

export function planHash(sections: unknown): string { return stableHashLite(sections); }
