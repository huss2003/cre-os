/**
 * Priority Adviser day order (workflow 07). PURE and deterministic — this IS the non-AI fallback.
 *
 * One feasible schedule across every action type: meetings (fixed, with prep + travel buffers), promises due,
 * calls/follow-ups, replies, approvals waiting, lease windows, overdue/due tasks, research actions and relationship
 * follow-ups. Each item carries an explainable rule (`why`). Items are ranked by rule score, then placed greedily into
 * the free gaps of the user's working window. What does not fit is reported as a capacity conflict, never silently
 * dropped. A task whose `depends_on` task is not finished is BLOCKED (shown with what it waits on) and never scheduled.
 */
import type { RelSuggestion } from "./caretaker";
import { daysBetween } from "./dates";
import type { CapacitySettings } from "./settings";
import { minutesOf } from "./settings";

export type AgendaKind = "meeting" | "prep" | "travel" | "promise" | "reply" | "call" | "follow_up" | "approval" | "lease_window" | "task" | "research" | "relationship";

export interface AgendaItem {
  ref: string;
  kind: AgendaKind;
  title: string;
  why: string;
  minutes: number;
  score: number;
  start: string | null;   // local "HH:mm" once scheduled
  end: string | null;
  fixed: boolean;
  href: string;
  due: string | null;     // ISO date/time when the item has a deadline
  waitsOn?: string;       // blocked items: what they wait for
  rank?: number;
}

export interface AgendaConflict { kind: "overlap" | "buffer" | "deadline_unfit" | "over_capacity" | "blocked_deadline"; message: string; refs: string[] }

export interface DayAgenda {
  version: "agenda.v1";
  date: string;
  mode: "workday" | "light";
  window: { start: string; end: string; from: string };
  timeline: AgendaItem[];      // feasible order (fixed + scheduled), by start time
  unscheduled: AgendaItem[];   // ranked but did not fit (capacity)
  blocked: AgendaItem[];       // dependencies not met
  conflicts: AgendaConflict[];
  capacity: { windowMinutes: number; fixedMinutes: number; freeMinutes: number; plannedMinutes: number; demandMinutes: number; overflowMinutes: number };
  rules: string[];             // the ranking rules, for transparency
}

export interface AgendaMeeting { id: string; title: string | null; startAt: string; endAt: string; kind: string; status: string; location: string | null }
export interface AgendaTask {
  id: string; title: string; dueAt: string | null; priority: number; status: string; snoozedUntil: string | null;
  dependsOn: string | null; source: string | null; idempotencyKey: string | null; linkedEntityType: string | null; linkedEntityId: string | null;
}
export interface AgendaDep { id: string; title: string; status: string }
export interface AgendaDeadline { leaseId: string; tenant: string; kind: string; date: string; days: number; basisLabel: string; verified: boolean }
export interface AgendaTarget { orgId: string; name: string; effortMinutes: number; slot: string; why: string; total: number }
export interface AgendaReply { id: string; occurredAt: string; subject: string | null; orgId: string | null; orgName: string | null }

export interface AgendaInputs {
  date: string;
  now: string;                 // ISO instant
  tz: string;
  isWorkday: boolean;
  settings: CapacitySettings & { prepMinutes?: number; defaultTaskMinutes?: number };
  meetings: AgendaMeeting[];
  tasks: AgendaTask[];
  deps: AgendaDep[];           // dependency targets (any status) visible to the user
  approvals: { changes: number; drafts: number; oldestAt: string | null };
  replies: AgendaReply[];
  deadlines: AgendaDeadline[];
  targets: AgendaTarget[];
  relationship: RelSuggestion[];
}

export const AGENDA_RULES = [
  "Meetings are fixed; external meetings get prep time, located meetings a travel buffer before them",
  "Lease windows ≤ 7 days and overdue promises outrank everything else flexible",
  "Then: deadline-call targets, overdue tasks, tasks due today, replies, approvals (sooner if the oldest waits > 24 h)",
  "Then: tasks due within 48 h, promises due soon, scored call targets (score/effort), relationship follow-ups, research",
  "A task waiting on an unfinished dependency is blocked, never scheduled",
  "Items are placed into the earliest free gap that fits; anything left over is a capacity conflict",
];

const PREP_DEFAULT = 15;
const TASK_DEFAULT = 20;

function localMinutes(iso: string, tz: string): { date: string; min: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const h = Number(g("hour")) % 24;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, min: h * 60 + Number(g("minute")) };
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function taskKind(t: AgendaTask): AgendaKind {
  const k = t.idempotencyKey ?? "";
  if (/:(missing_expiry|fractional_tenure|expired_status)$|:review:/.test(k) || /^(find|research|confirm|enrich|verify|check)\b/i.test(t.title)) return "research";
  if (/^(call|phone|ring|speak)\b/i.test(t.title)) return "call";
  if (/^(follow[\s-]?up|chase|reply|respond|deliver|send)\b/i.test(t.title) || /^brief\.caretaker:/.test(k)) return "follow_up";
  return "task";
}

/** Build the day order. Deterministic for the same inputs. */
export function buildAgenda(i: AgendaInputs): DayAgenda {
  const s = i.settings;
  const prep = s.prepMinutes ?? PREP_DEFAULT;
  const taskMin = s.defaultTaskMinutes ?? TASK_DEFAULT;
  const winStart = minutesOf(s.workdayStart);
  const winEnd = minutesOf(s.workdayEnd);
  const nowLocal = localMinutes(i.now, i.tz);
  const from = nowLocal.date === i.date ? Math.min(winEnd, Math.max(winStart, Math.ceil(nowLocal.min / 15) * 15)) : nowLocal.date > i.date ? winEnd : winStart;
  const conflicts: AgendaConflict[] = [];
  const nowIso = i.now;
  const todayEnd = `${i.date}T23:59:59`;

  // ---------------------------------------------------------------- fixed blocks: meetings + prep + travel
  const fixed: AgendaItem[] = [];
  const active = i.meetings.filter((m) => m.status !== "cancelled").sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
  for (const m of active) {
    const st = localMinutes(m.startAt, i.tz);
    const en = localMinutes(m.endAt, i.tz);
    if (st.date !== i.date) continue;
    const startMin = st.min;
    const endMin = en.date === i.date ? Math.max(en.min, startMin) : 24 * 60 - 1;
    const external = m.kind === "meeting" || m.kind === "site_visit";
    fixed.push({ ref: `meeting:${m.id}`, kind: "meeting", title: m.title ?? "Meeting", why: `Calendar ${m.kind.replace(/_/g, " ")}${m.location ? ` at ${m.location}` : ""}`,
      minutes: endMin - startMin, score: 1000, start: hhmm(startMin), end: hhmm(endMin), fixed: true, href: `/today?meeting=${m.id}`, due: m.startAt });
    let cursor = startMin;
    if (external && m.location && s.travelBufferMinutes > 0) {
      fixed.push({ ref: `travel:${m.id}`, kind: "travel", title: `Travel to ${m.location}`, why: `Travel buffer ${s.travelBufferMinutes} min before a located ${m.kind.replace(/_/g, " ")}`,
        minutes: s.travelBufferMinutes, score: 1000, start: hhmm(Math.max(0, cursor - s.travelBufferMinutes)), end: hhmm(cursor), fixed: true, href: `/today?meeting=${m.id}`, due: m.startAt });
      cursor -= s.travelBufferMinutes;
    }
    if (external && prep > 0) {
      fixed.push({ ref: `prep:${m.id}`, kind: "prep", title: `Prepare: ${m.title ?? "meeting"}`, why: `Prep ${prep} min before an external ${m.kind.replace(/_/g, " ")} (pre-meeting brief)`,
        minutes: prep, score: 1000, start: hhmm(Math.max(0, cursor - prep)), end: hhmm(cursor), fixed: true, href: `/today?meeting=${m.id}`, due: m.startAt });
    }
  }
  const span = (x: AgendaItem) => [minutesOf(x.start!), minutesOf(x.end!)] as const;
  // overlaps: meeting vs meeting, buffer vs another meeting
  const meetings = fixed.filter((x) => x.kind === "meeting");
  for (let a = 0; a < meetings.length; a++) for (let b = a + 1; b < meetings.length; b++) {
    const [s1, e1] = span(meetings[a]); const [s2, e2] = span(meetings[b]);
    if (s2 < e1 && s1 < e2) conflicts.push({ kind: "overlap", message: `“${meetings[a].title}” overlaps “${meetings[b].title}”`, refs: [meetings[a].ref, meetings[b].ref] });
  }
  for (const buf of fixed.filter((x) => x.kind !== "meeting")) {
    const [bs, be] = span(buf);
    const hit = meetings.find((m) => m.ref.split(":")[1] !== buf.ref.split(":")[1] && bs < span(m)[1] && span(m)[0] < be);
    if (hit) conflicts.push({ kind: "buffer", message: `No time for ${buf.kind === "prep" ? "prep" : "travel"} before “${buf.title.replace(/^(Prepare: |Travel to )/, "")}” — “${hit.title}” runs into it`, refs: [buf.ref, hit.ref] });
  }

  // ---------------------------------------------------------------- flexible candidates
  const cand: AgendaItem[] = [];
  const blocked: AgendaItem[] = [];
  const mk = (x: Omit<AgendaItem, "start" | "end" | "fixed">): AgendaItem => ({ ...x, start: null, end: null, fixed: false });

  for (const d of i.deadlines) {
    if (d.days < 0 || d.days > 30) continue;
    const near = d.days <= 7;
    cand.push(mk({ ref: `lease:${d.leaseId}:${d.kind}:${d.date}`, kind: "lease_window", title: `${d.kind === "escalation" ? "Rent escalation" : d.kind === "option" ? "Lease option" : d.kind === "break" ? "Break option" : d.kind === "notice" ? "Notice deadline" : "Lease expiry"} ${d.date} — ${d.tenant}`,
      why: `Rule: lease window ${near ? "≤ 7" : "≤ 30"} days — ${d.days} day${d.days === 1 ? "" : "s"} left (${d.basisLabel}${d.verified ? "" : ", not verified"})`,
      minutes: 20, score: near ? 950 - d.days * 5 : 420 - d.days, href: `/leases?lease=${d.leaseId}`, due: d.date }));
  }

  const depById = new Map(i.deps.map((d) => [d.id, d]));
  for (const t of i.tasks) {
    if (t.status === "done" || t.status === "cancelled") continue;
    if (t.status === "snoozed" && t.snoozedUntil && t.snoozedUntil > todayEnd) continue;
    const kind = taskKind(t);
    const due = t.dueAt;
    const dueDate = due ? due.slice(0, 10) : null;
    const overdue = !!due && due < nowIso;
    const dueToday = !!dueDate && dueDate === i.date;
    const within48 = !!due && Date.parse(due) - Date.parse(nowIso) <= 48 * 3_600_000;
    let score: number; let rule: string;
    if (overdue) { score = 780 + Math.min(t.priority, 100) / 10; rule = `overdue since ${dueDate}`; }
    else if (dueToday) { score = 720 + Math.min(t.priority, 100) / 10; rule = "due today"; }
    else if (within48) { score = 560 + Math.min(t.priority, 100) / 10; rule = `due within 48 h (${dueDate})`; }
    else { score = (kind === "research" ? 150 : 200) + Math.min(t.priority, 100); rule = dueDate ? `due ${dueDate}` : "no due date"; }
    const item = mk({ ref: `task:${t.id}`, kind, title: t.title, why: `Rule: ${kind.replace("_", "-")} ${rule}; priority ${t.priority}`, minutes: kind === "research" ? 30 : taskMin, score, href: `/tasks?focus=${t.id}`, due });
    if (t.dependsOn) {
      const dep = depById.get(t.dependsOn);
      if (!dep || (dep.status !== "done" && dep.status !== "cancelled")) {
        item.waitsOn = dep ? `“${dep.title}” (${dep.status})` : "a prerequisite task you cannot see";
        item.why = `Blocked: waits on ${item.waitsOn}. ${item.why}`;
        blocked.push(item);
        if (overdue || dueToday) conflicts.push({ kind: "blocked_deadline", message: `“${t.title}” is ${overdue ? "overdue" : "due today"} but waits on ${item.waitsOn}`, refs: [item.ref] });
        continue;
      }
    }
    cand.push(item);
  }

  for (const r of i.relationship) {
    const isPromise = r.kind === "promise_overdue" || r.kind === "promise_due";
    // a promise that already has its follow-up task is represented by that task
    if (r.createTask && i.tasks.some((t) => t.idempotencyKey === `brief.${r.key}`)) continue;
    cand.push(mk({ ref: `rel:${r.key}`, kind: isPromise ? "promise" : "relationship", title: r.title, why: `Rule: ${r.kind.replace(/_/g, " ")} — ${r.why}`,
      minutes: 15, score: r.kind === "promise_overdue" ? 900 : r.kind === "promise_due" ? 540 : r.kind === "visit_concern" ? 470 : r.kind === "renewal" ? 330 : 260, href: r.href, due: r.due }));
  }

  for (const r of i.replies.slice(0, 10)) {
    cand.push(mk({ ref: `reply:${r.id}`, kind: "reply", title: `Reply: ${r.orgName ?? "contact"} — ${r.subject ?? "inbound message"}`,
      why: `Rule: new inbound reply ${r.occurredAt.slice(0, 16).replace("T", " ")} UTC — respond while warm (draft only, you send)`, minutes: 10, score: 700, href: r.orgId ? `/companies/${r.orgId}` : "/today#replies", due: null }));
  }

  const pending = i.approvals.changes + i.approvals.drafts;
  if (pending > 0) {
    const old = i.approvals.oldestAt ? (Date.parse(nowIso) - Date.parse(i.approvals.oldestAt)) / 3_600_000 : 0;
    cand.push(mk({ ref: "approvals", kind: "approval", title: `Review ${pending} pending approval${pending === 1 ? "" : "s"}`,
      why: `Rule: approvals waiting (${i.approvals.changes} change${i.approvals.changes === 1 ? "" : "s"}, ${i.approvals.drafts} draft${i.approvals.drafts === 1 ? "" : "s"})${old > 24 ? `; oldest waiting ${Math.floor(old)} h` : ""}`,
      minutes: Math.min(60, Math.max(10, pending * 3)), score: old > 24 ? 680 : 500, href: "/approvals", due: null }));
  }

  if (i.isWorkday) {
    for (const t of i.targets) {
      cand.push(mk({ ref: `org:${t.orgId}`, kind: "call", title: `Call ${t.name}${t.slot === "deadline" ? " (deadline)" : ""}`, why: `Rule: ${t.why}`,
        minutes: t.effortMinutes, score: t.slot === "deadline" ? 820 : 300 + t.total, href: `/today#target-${t.orgId}`, due: null }));
    }
  }

  // de-duplicate refs (first wins), rank
  const seen = new Set<string>();
  const ranked = cand.filter((c) => (seen.has(c.ref) ? false : (seen.add(c.ref), true)))
    .sort((a, b) => b.score - a.score || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.title.localeCompare(b.title));

  // ---------------------------------------------------------------- place into free gaps
  const busy = fixed.map(span).map(([a, b]) => [Math.max(a, winStart), Math.min(b, winEnd)] as [number, number]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const gaps: [number, number][] = [];
  let cur = from;
  for (const [a, b] of busy) {
    if (a > cur) gaps.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (winEnd > cur) gaps.push([cur, winEnd]);
  const fixedMinutes = busy.reduce((n, [a, b]) => n + (b - a), 0);
  const freeMinutes = gaps.reduce((n, [a, b]) => n + (b - a), 0);

  const scheduled: AgendaItem[] = [];
  const unscheduled: AgendaItem[] = [];
  const light = !i.isWorkday;
  for (const c of ranked) {
    if (light && c.score < 700) { unscheduled.push({ ...c, why: `${c.why}. Non-workday: only urgent items are planned` }); continue; }
    const g = gaps.findIndex(([a, b]) => b - a >= c.minutes);
    if (g === -1) { unscheduled.push(c); continue; }
    const [a, b] = gaps[g];
    scheduled.push({ ...c, start: hhmm(a), end: hhmm(a + c.minutes) });
    if (a + c.minutes >= b) gaps.splice(g, 1); else gaps[g] = [a + c.minutes, b];
  }
  const plannedMinutes = scheduled.reduce((n, x) => n + x.minutes, 0);
  const demandMinutes = ranked.reduce((n, x) => n + x.minutes, 0);
  for (const u of unscheduled) {
    const hard = (!!u.due && u.due.slice(0, 10) <= i.date) || (u.kind === "promise" && u.score >= 900) || (u.kind === "lease_window" && u.score >= 900);
    if (hard) conflicts.push({ kind: "deadline_unfit", message: `“${u.title}” is due ${u.due ? (u.due.slice(0, 10) < i.date ? `since ${u.due.slice(0, 10)}` : "today") : "now"} but there is no ${u.minutes}-min slot left — move a meeting or delegate`, refs: [u.ref] });
  }
  if (unscheduled.length && !light) {
    conflicts.push({ kind: "over_capacity", message: `Planned work needs ${demandMinutes} min but only ${freeMinutes} min are free between ${hhmm(from)} and ${s.workdayEnd} — ${unscheduled.length} item${unscheduled.length === 1 ? "" : "s"} deferred`, refs: unscheduled.map((u) => u.ref) });
  }

  const timeline = [...fixed, ...scheduled].sort((a, b) => minutesOf(a.start!) - minutesOf(b.start!) || Number(b.fixed) - Number(a.fixed) || b.score - a.score);
  let rank = 0;
  for (const t of timeline) if (!t.fixed) t.rank = ++rank;

  return {
    version: "agenda.v1", date: i.date, mode: i.isWorkday ? "workday" : "light",
    window: { start: s.workdayStart, end: s.workdayEnd, from: hhmm(from) },
    timeline, unscheduled, blocked, conflicts,
    capacity: { windowMinutes: Math.max(0, winEnd - winStart), fixedMinutes, freeMinutes, plannedMinutes, demandMinutes, overflowMinutes: Math.max(0, demandMinutes - plannedMinutes) },
    rules: AGENDA_RULES,
  };
}

/** Plain-text rendering (brief fallback / plan export). */
export function renderAgendaText(a: DayAgenda): string[] {
  const L: string[] = [];
  for (const t of a.timeline) L.push(`${t.start}–${t.end} ${t.fixed ? "" : `#${t.rank} `}${t.title} — ${t.why}`);
  for (const b of a.blocked) L.push(`BLOCKED ${b.title} — waits on ${b.waitsOn}`);
  for (const u of a.unscheduled.slice(0, 10)) L.push(`NOT SCHEDULED ${u.title} (${u.minutes} min)`);
  for (const c of a.conflicts) L.push(`! ${c.message}`);
  return L;
}

export function daysUntil(today: string, iso: string): number {
  return daysBetween(today, iso.slice(0, 10));
}
