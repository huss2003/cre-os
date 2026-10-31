/**
 * 08:00 brief builder (spec Part I §7 "08:00 brief format", Part III "Brief source freshness…"). PURE and deterministic:
 * the same inputs always give the same sections. AI synthesis is layered on top later (synthesis.ts) and is optional —
 * `fallbackText` is always present so the brief works with the model down (rule S10, Spend cap test).
 *
 * Sections, in spec order: source status; three highest-impact actions; new-company approaches still needed (120/170);
 * overdue promises; today's meetings + locality clusters; expiry/notice events; hot replies (only when inbox healthy);
 * pending approvals; one sourced intelligence item; fee/pipeline snapshot. Plus targets (with score breakdown + why) and
 * the capacity summary from the daily plan.
 */
import Decimal from "decimal.js";
import { addDays, daysBetween, isoWeekday, monthEnd, workdaysBetween } from "./dates";
import type { RadarItem } from "./lease-radar";
import type { Capacity, DisplacedCandidate, SelectedTarget } from "./priority";
import type { Component, ComponentKey } from "./scoring";
import { COMPONENT_LABEL } from "./scoring";
import type { SourceStatus } from "./source-health";

export const BRIEF_SCHEMA = "brief.v1";

export type BriefKind = "daily" | "pre_meeting" | "weekly" | "reconciliation";
export type SectionState = "ok" | "stale" | "unavailable";

export interface TaskLite {
  id: string;
  title: string;
  dueAt: string | null;
  priority: number;
  status: string;
  snoozedUntil: string | null;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  source: string | null;
  completedAt?: string | null;
  updatedAt?: string | null;
}

export interface MeetingView {
  id: string;
  title: string | null;
  startAt: string;
  endAt: string;
  kind: string;
  status: string;
  location: string | null;
  routeGroup: string | null;
  linkedEntityType?: string | null;
  linkedEntityId?: string | null;
}

export interface ReplyLite { id: string; occurredAt: string; subject: string | null; summary: string | null; orgId: string | null; orgName: string | null }
export interface IntelLite { id: string; orgId: string; orgName: string; claimType: string; excerpt: string | null; sourceUrl: string; date: string | null; status: string; evidenceTier: string | null }

export interface TargetView extends SelectedTarget {
  components: { key: ComponentKey; label: string; points: number; max: number; band: string; evidence: string[] }[];
  overrides: string[];
  evidenceConfidence: string;
  warmth: string;
  enrichment: string[];
}

export interface PipelineInput {
  open: number;
  byStage: Record<string, number>;
  expectedFee: string;          // decimal string, credited share applied (S5)
  closingThisQuarter: number;
  missingNextAction: number;
  feesInvoicedFy: string;
  feesCollectedFy: string;
}

export interface BriefInputs {
  kind: BriefKind;
  date: string;
  tz: string;
  now: string;
  mode: "workday" | "light";
  sources: SourceStatus[];
  targets: TargetView[];
  displaced: DisplacedCandidate[];
  capacity: Capacity | null;
  planGeneratedAt: string | null;
  tasks: TaskLite[];
  meetings: MeetingView[];
  radar: RadarItem[];
  replies: ReplyLite[];
  approvals: { changes: number; drafts: number; oldestAt: string | null };
  intel: IntelLite[];
  pipeline: PipelineInput;
  approachesThisMonth: number;
  cohortTarget: { minimum: number; pace: number };
  workdays: number[];
  staleTaskAfterDays: number;
}

export interface ActionItem { kind: "notice" | "overdue" | "deadline_target" | "reply" | "target" | "approvals" | "enrichment"; title: string; why: string; href: string; ref: string }

export interface DeadlineItem {
  leaseId: string; tenant: string; asset: string | null; kind: "notice" | "expiry" | "expired" | "break";
  date: string; days: number; basisLabel: string; verified: boolean; lastDecision: string | null; callWindow: string | null;
}

export interface BriefContent {
  schema: typeof BRIEF_SCHEMA;
  kind: BriefKind;
  date: string;
  mode: "workday" | "light";
  modeNote: string | null;
  sources: SourceStatus[];
  staleSections: string[];
  actions: ActionItem[];
  approaches: { thisMonth: number; minimum: number; pace: number; remainingMinimum: number; remainingPace: number; workdaysLeft: number; perDayMinimum: number; perDayPace: number };
  overdue: { items: TaskLite[]; staleCount: number; snoozedCount: number };
  meetings: { state: SectionState; note: string | null; clusters: { label: string; meetings: MeetingView[] }[]; conflicts: string[] };
  deadlines: { items: DeadlineItem[]; expiredNeedingConfirmation: number };
  replies: { state: SectionState; note: string | null; items: ReplyLite[] };
  approvals: { changes: number; drafts: number; oldestAt: string | null };
  intel: IntelLite | null;
  pipeline: PipelineInput;
  targets: TargetView[];
  displaced: DisplacedCandidate[];
  capacity: Capacity | null;
  planGeneratedAt: string | null;
  fallbackText: string;
}

// ------------------------------------------------------------------ helpers

export function isOverdue(t: TaskLite, now: string): boolean {
  return t.status === "open" && !!t.dueAt && t.dueAt < now;
}

/** UI-facing state: done / cancelled / snoozed (until) / stale / overdue / open — kept distinct (spec: stale ≠ snoozed ≠ done). */
export function effectiveTaskState(t: Pick<TaskLite, "status" | "dueAt" | "snoozedUntil" | "updatedAt">, now: string, staleAfterDays: number): "done" | "cancelled" | "snoozed" | "stale" | "overdue" | "open" {
  if (t.status === "done") return "done";
  if (t.status === "cancelled") return "cancelled";
  if (t.status === "snoozed" && t.snoozedUntil && t.snoozedUntil > now) return "snoozed";
  if (t.status === "stale") return "stale";
  const due = t.dueAt;
  if (due && due < now) {
    if (daysBetween(due.slice(0, 10), now.slice(0, 10)) > staleAfterDays) return "stale";
    return "overdue";
  }
  return "open";
}

function locality(m: MeetingView): string {
  if (m.routeGroup) return m.routeGroup;
  if (!m.location) return m.kind === "call" ? "Calls (no travel)" : "Location not set";
  return m.location.split(",")[0].trim().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function clusterMeetings(ms: MeetingView[]): { clusters: { label: string; meetings: MeetingView[] }[]; conflicts: string[] } {
  const active = ms.filter((m) => m.status !== "cancelled").sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
  const map = new Map<string, MeetingView[]>();
  for (const m of active) map.set(locality(m), [...(map.get(locality(m)) ?? []), m]);
  const clusters = [...map.entries()].map(([label, meetings]) => ({ label, meetings }))
    .sort((a, b) => (a.meetings[0].startAt < b.meetings[0].startAt ? -1 : 1));
  const conflicts: string[] = [];
  for (let i = 1; i < active.length; i++) {
    const prev = active[i - 1], cur = active[i];
    if (cur.startAt < prev.endAt) conflicts.push(`“${prev.title ?? "Meeting"}” overlaps “${cur.title ?? "Meeting"}”`);
  }
  return { clusters, conflicts };
}

function deadlineItems(radar: RadarItem[], today: string): { items: DeadlineItem[]; expired: number } {
  const items: DeadlineItem[] = [];
  let expired = 0;
  for (const r of radar) {
    const tenant = r.tenantName ?? "Unknown tenant";
    const base = { leaseId: r.leaseId, tenant, asset: r.assetName, lastDecision: r.plan?.lastDecision ?? null, callWindow: r.callWindow ? `${r.callWindow.opens} → ${r.callWindow.closes} (${r.callWindow.state})` : null };
    if (r.status === "expired_needs_confirmation") { expired++; continue; }
    if (r.noticeDeadline && r.daysToNotice != null && r.daysToNotice >= 0 && r.daysToNotice <= 90) {
      items.push({ ...base, kind: "notice", date: r.noticeDeadline.date, days: r.daysToNotice, basisLabel: r.noticeDeadline.basisLabel, verified: r.noticeDeadline.verified });
    }
    for (const b of r.breaks) {
      const d = daysBetween(today, b.date);
      if (d >= 0 && d <= 90) items.push({ ...base, kind: "break", date: b.date, days: d, basisLabel: b.basisLabel, verified: b.verified });
    }
    if (r.status === "active" && r.expiry && r.daysToExpiry != null && r.daysToExpiry >= 0 && r.daysToExpiry <= 90) {
      items.push({ ...base, kind: "expiry", date: r.expiry.date, days: r.daysToExpiry, basisLabel: r.expiry.basisLabel, verified: r.expiry.verified });
    }
  }
  items.sort((a, b) => a.days - b.days || a.tenant.localeCompare(b.tenant));
  return { items, expired };
}

function rankActions(i: BriefInputs, overdue: TaskLite[], deadlines: DeadlineItem[], repliesOk: boolean): ActionItem[] {
  const cand: (ActionItem & { w: number })[] = [];
  const light = i.mode === "light";
  for (const d of deadlines.filter((x) => x.kind === "notice" && x.days <= 30)) {
    cand.push({ kind: "notice", w: 1000 - d.days, ref: `lease:${d.leaseId}`, href: `/leases?lease=${d.leaseId}`,
      title: `Notice deadline ${d.date} — ${d.tenant}${d.asset ? ` (${d.asset})` : ""}`,
      why: `${d.days} days left; ${d.basisLabel}${d.verified ? "" : " — not contractual, verify the clause"}` });
  }
  for (const t of overdue) {
    cand.push({ kind: "overdue", w: 500 + t.priority - Math.min(99, daysBetween((t.dueAt ?? i.now).slice(0, 10), i.date)), ref: `task:${t.id}`, href: `/tasks?focus=${t.id}`,
      title: `Overdue: ${t.title}`, why: `Due ${t.dueAt?.slice(0, 10)} · priority ${t.priority}` });
  }
  if (!light) {
    for (const t of i.targets.filter((x) => x.slot === "deadline")) {
      cand.push({ kind: "deadline_target", w: 800 - (t.rank ?? 0), ref: `org:${t.orgId}`, href: `/today#target-${t.orgId}`, title: `Call ${t.name} (deadline)`, why: t.why });
    }
    if (repliesOk) {
      for (const r of i.replies.slice(0, 3)) {
        cand.push({ kind: "reply", w: 700, ref: `reply:${r.id}`, href: r.orgId ? `/companies/${r.orgId}` : `/today#replies`,
          title: `Reply: ${r.orgName ?? "contact"} — ${r.subject ?? "inbound message"}`, why: `Inbound ${r.occurredAt.slice(0, 16).replace("T", " ")} UTC; draft only, you send` });
      }
    }
    for (const t of i.targets.filter((x) => x.slot !== "deadline").slice(0, 3)) {
      cand.push({ kind: "target", w: 300 + t.total, ref: `org:${t.orgId}`, href: `/today#target-${t.orgId}`, title: `Approach ${t.name} (${t.total}/100)`, why: t.why });
    }
  }
  const pending = i.approvals.changes + i.approvals.drafts;
  if (pending > 0) cand.push({ kind: "approvals", w: 400 + Math.min(pending, 50), ref: "approvals", href: "/approvals", title: `Review ${pending} pending approval${pending === 1 ? "" : "s"}`, why: `${i.approvals.changes} data change(s), ${i.approvals.drafts} draft(s) waiting` });
  cand.sort((a, b) => b.w - a.w || a.title.localeCompare(b.title));
  const seen = new Set<string>();
  const out: ActionItem[] = [];
  for (const c of cand) {
    if (seen.has(c.ref)) continue;
    seen.add(c.ref);
    out.push({ kind: c.kind, title: c.title, why: c.why, href: c.href, ref: c.ref });
    if (out.length === 3) break;
  }
  return out;
}

function approachesBlock(i: BriefInputs) {
  const end = monthEnd(i.date);
  const workdaysLeft = workdaysBetween(i.date, end, i.workdays);
  const remainingMinimum = Math.max(0, i.cohortTarget.minimum - i.approachesThisMonth);
  const remainingPace = Math.max(0, i.cohortTarget.pace - i.approachesThisMonth);
  const per = (n: number) => (workdaysLeft > 0 ? Math.ceil(n / workdaysLeft) : n);
  return { thisMonth: i.approachesThisMonth, minimum: i.cohortTarget.minimum, pace: i.cohortTarget.pace, remainingMinimum, remainingPace, workdaysLeft, perDayMinimum: per(remainingMinimum), perDayPace: per(remainingPace) };
}

const fmtTime = (iso: string, tz: string) => new Intl.DateTimeFormat("en-IN", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

/** Plain-text deterministic brief (tasks/meetings/deadlines) — the cached fallback when AI synthesis is unavailable. */
export function renderFallbackText(c: Omit<BriefContent, "fallbackText">, tz: string): string {
  const L: string[] = [];
  L.push(`CRE OS brief — ${c.date}${c.mode === "light" ? " (light review)" : ""}`);
  const bad = c.sources.filter((s) => s.state !== "ok");
  L.push(bad.length ? `Sources: ${bad.map((s) => s.note).join("; ")}` : "Sources: all connected sources fresh");
  L.push("", "Top actions:");
  if (c.actions.length) c.actions.forEach((a, n) => L.push(`${n + 1}. ${a.title} — ${a.why}`));
  else L.push("- No urgent actions computed");
  L.push("", `New-company approaches: ${c.approaches.thisMonth} this month (minimum ${c.approaches.minimum}, pace ${c.approaches.pace}); ${c.approaches.perDayMinimum}/workday needed for minimum over ${c.approaches.workdaysLeft} workdays`);
  L.push("", `Overdue (${c.overdue.items.length}):`);
  for (const t of c.overdue.items.slice(0, 10)) L.push(`- ${t.title} (due ${t.dueAt?.slice(0, 10)})`);
  L.push("", "Meetings today:");
  if (c.meetings.note) L.push(`! ${c.meetings.note}`);
  const ms = c.meetings.clusters.flatMap((cl) => cl.meetings.map((m) => ({ cl: cl.label, m })));
  if (ms.length) for (const { cl, m } of ms) L.push(`- ${fmtTime(m.startAt, tz)}–${fmtTime(m.endAt, tz)} ${m.title ?? "Meeting"} [${cl}]`);
  else L.push(c.meetings.state === "ok" ? "- None scheduled" : "- None recorded (calendar not verified)");
  L.push("", "Expiry / notice (≤90 days):");
  if (c.deadlines.items.length) for (const d of c.deadlines.items.slice(0, 10)) L.push(`- ${d.kind} ${d.date} (${d.days} d) ${d.tenant}${d.asset ? ` @ ${d.asset}` : ""} — ${d.basisLabel}`);
  else L.push("- None in the next 90 days");
  if (c.deadlines.expiredNeedingConfirmation) L.push(`- ${c.deadlines.expiredNeedingConfirmation} expired lease(s) need status confirmation`);
  L.push("", "Replies:");
  if (c.replies.state !== "ok") L.push(`! ${c.replies.note}`);
  for (const r of c.replies.items.slice(0, 5)) L.push(`- ${r.orgName ?? "Unknown"}: ${r.subject ?? "(no subject)"}`);
  if (c.replies.state === "ok" && c.replies.items.length === 0) L.push("- No new meaningful replies since the last brief");
  L.push("", `Pending approvals: ${c.approvals.changes} change(s), ${c.approvals.drafts} draft(s)`);
  if (c.intel) L.push("", `Intel: ${c.intel.orgName} — ${c.intel.claimType.replace(/_/g, " ")} (${c.intel.date ?? "undated"}) ${c.intel.sourceUrl}`);
  L.push("", `Pipeline: ${c.pipeline.open} open, expected credited fee ₹${c.pipeline.expectedFee}, ${c.pipeline.closingThisQuarter} closing this quarter, ${c.pipeline.missingNextAction} without next action`);
  return L.join("\n");
}

export function buildBrief(i: BriefInputs): BriefContent {
  const today = i.date;
  const src = new Map(i.sources.map((s) => [s.key, s]));
  const staleSections: string[] = [];

  // overdue promises / tasks
  const overdueItems = i.tasks.filter((t) => effectiveTaskState(t, i.now, i.staleTaskAfterDays) === "overdue")
    .sort((a, b) => b.priority - a.priority || (a.dueAt! < b.dueAt! ? -1 : 1));
  const staleCount = i.tasks.filter((t) => effectiveTaskState(t, i.now, i.staleTaskAfterDays) === "stale").length;
  const snoozedCount = i.tasks.filter((t) => effectiveTaskState(t, i.now, i.staleTaskAfterDays) === "snoozed").length;

  // meetings (calendar)
  const cal = src.get("calendar");
  let meetingsState: SectionState = "ok";
  let meetingsNote: string | null = null;
  if (!cal || cal.state === "not_connected") meetingsNote = "Calendar not connected — showing meetings entered in CRE OS only";
  else if (cal.state !== "ok") { meetingsState = "stale"; meetingsNote = `${cal.note}. Meetings may be incomplete.`; staleSections.push("meetings"); }
  const { clusters, conflicts } = clusterMeetings(i.meetings);

  // replies (inbox) — never claim "no replies" when the inbox is not healthy
  const inbox = src.get("inbox");
  let repliesState: SectionState = "ok";
  let repliesNote: string | null = null;
  if (!inbox || inbox.state === "not_connected") { repliesState = "unavailable"; repliesNote = "Inbox not connected — replies were not checked (captured replies shown only)"; staleSections.push("replies"); }
  else if (inbox.state === "failed") { repliesState = "unavailable"; repliesNote = `Hot replies unavailable since ${inbox.lastSuccessAt ?? "first sync"} — inbox access failed${inbox.error ? ` (${inbox.error})` : ""}`; staleSections.push("replies"); }
  else if (inbox.state === "stale") { repliesState = "stale"; repliesNote = `Inbox stale — last successful sync ${inbox.lastSuccessAt}; newer replies not shown`; staleSections.push("replies"); }

  const dl = deadlineItems(i.radar, today);
  const content: Omit<BriefContent, "fallbackText"> = {
    schema: BRIEF_SCHEMA,
    kind: i.kind,
    date: today,
    mode: i.mode,
    modeNote: i.mode === "light" ? "Non-workday: light review — no client-contact targets assumed" : null,
    sources: i.sources,
    staleSections,
    actions: rankActions(i, overdueItems, dl.items, repliesState === "ok"),
    approaches: approachesBlock(i),
    overdue: { items: overdueItems.slice(0, 20), staleCount, snoozedCount },
    meetings: { state: meetingsState, note: meetingsNote, clusters, conflicts },
    deadlines: { items: dl.items.slice(0, 20), expiredNeedingConfirmation: dl.expired },
    replies: { state: repliesState, note: repliesNote, items: i.replies.slice(0, 10) },
    approvals: i.approvals,
    intel: pickIntel(i.intel, i.targets),
    pipeline: i.pipeline,
    targets: i.mode === "light" ? [] : i.targets,
    displaced: i.mode === "light" ? [] : i.displaced.slice(0, 5),
    capacity: i.capacity,
    planGeneratedAt: i.planGeneratedAt,
  };
  return { ...content, fallbackText: renderFallbackText(content, i.tz) };
}

/** One useful intelligence item WITH a source: prefer today's targets, then most recent, then strongest evidence. */
export function pickIntel(items: IntelLite[], targets: { orgId: string }[]): IntelLite | null {
  const sourced = items.filter((x) => !!x.sourceUrl);
  if (!sourced.length) return null;
  const targetIds = new Set(targets.map((t) => t.orgId));
  const order = ["documentary_current", "credible_reported", "corroborated_public", "single_unverified", "inference"];
  return [...sourced].sort((a, b) =>
    Number(targetIds.has(b.orgId)) - Number(targetIds.has(a.orgId)) ||
    (b.date ?? "").localeCompare(a.date ?? "") ||
    order.indexOf(a.evidenceTier ?? "inference") - order.indexOf(b.evidenceTier ?? "inference"))[0];
}

/** Turn a ScoreResult-like components record into the UI breakdown. */
export function componentRows(components: Record<string, Component> | null | undefined): TargetView["components"] {
  if (!components) return [];
  return (Object.keys(COMPONENT_LABEL) as ComponentKey[]).filter((k) => components[k]).map((k) => ({
    key: k, label: COMPONENT_LABEL[k], points: Number(components[k].points), max: Number(components[k].max), band: components[k].band, evidence: components[k].evidence ?? [],
  }));
}

/** Pipeline maths with decimal.js (S5): credited expected fee = Σ expected_fee × credit_share (share unknown → excluded, counted). */
export function pipelineSnapshot(opps: { stage: string; outcome: string | null; expected_fee: string | number | null; credit_share: string | number | null; expected_close: string | null; next_action: string | null; next_action_due: string | null }[],
  fees: { invoiced_amount: string | number | null; invoiced_on: string | null; collected_amount: string | number | null; collected_on: string | null }[], today: string): PipelineInput {
  const open = opps.filter((o) => (o.outcome ?? "open") === "open");
  const byStage: Record<string, number> = {};
  let fee = new Decimal(0);
  for (const o of open) {
    byStage[o.stage] = (byStage[o.stage] ?? 0) + 1;
    if (o.expected_fee != null && o.credit_share != null) fee = fee.plus(new Decimal(o.expected_fee).times(new Decimal(o.credit_share)));
  }
  const [y, m] = today.split("-").map(Number);
  const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const qStart = `${y}-${String(qStartMonth).padStart(2, "0")}-01`;
  const qEnd = addDays(`${qStartMonth + 3 > 12 ? y + 1 : y}-${String(((qStartMonth + 2) % 12) + 1).padStart(2, "0")}-01`, -1);
  const fyStart = m >= 4 ? `${y}-04-01` : `${y - 1}-04-01`; // Indian FY
  let inv = new Decimal(0), col = new Decimal(0);
  for (const f of fees) {
    if (f.invoiced_amount != null && f.invoiced_on && f.invoiced_on >= fyStart && f.invoiced_on <= today) inv = inv.plus(f.invoiced_amount);
    if (f.collected_amount != null && f.collected_on && f.collected_on >= fyStart && f.collected_on <= today) col = col.plus(f.collected_amount);
  }
  return {
    open: open.length, byStage, expectedFee: fee.toFixed(0),
    closingThisQuarter: open.filter((o) => o.expected_close && o.expected_close >= qStart && o.expected_close <= qEnd).length,
    missingNextAction: open.filter((o) => !o.next_action && !o.next_action_due).length,
    feesInvoicedFy: inv.toFixed(0), feesCollectedFy: col.toFixed(0),
  };
}

export function isWorkday(date: string, workdays: number[]): boolean {
  return workdays.includes(isoWeekday(date));
}
