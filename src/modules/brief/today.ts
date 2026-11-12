/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
/**
 * Today screen on the NEW data (spec §3.1, §8.1, Workflow 8). Deterministic assembly, no LLM (S5/S6):
 *  1 meetings (today + next 3 days) with prep status — meeting_prep
 *  2 priority accounts — Module 3 score_result (lead model); legacy lead_score only when the workspace has none (labelled)
 *  3 new signals since the last working day — signal
 *  4 overdue/due outreach follow-ups (outreach_item) + overdue commitments (task)
 *  5 pending approvals — change_proposal + assistant_approval
 *  6 lease events in 12/6/3-month windows + lock-in/notice deadlines — lease_event
 *  7 transaction deadlines — deal_milestone
 *  8 recommended next actions — deterministic merge of 1–7 (top 5, each with a reason)
 * Each section query is time-boxed (reusing the assistant morning brief's helpers); a failed one is shown as
 * "Couldn't load — <section>" (S10), never as "nothing today". Works with ctx.db (RLS): every query filters workspace_id.
 */
import { addDays } from "date-fns";
import { atLocal, edate, fmt, localDate } from "@/lib/util/time";
import { LEASE_WINDOWS, sinceDate, timeboxed } from "@/modules/assistant/briefs/morning";
import { daysBetween } from "./dates";

export type Tone = "ok" | "warn" | "bad" | "neutral" | "accent" | "brand";
export type SectionKey = "meetings" | "accounts" | "signals" | "followups" | "approvals" | "leases" | "milestones";

export interface TodayItem {
  id: string;
  title: string;
  detail?: string;
  badges: { label: string; tone: Tone }[];
  href: string;
  actionLabel: string;
  /** Deterministic urgency used for ranking within a section and for "Recommended next actions". 0 = not recommended. */
  urgency: number;
  /** Why it is recommended (shown in section 8). */
  reason: string;
}

export interface TodaySection {
  key: SectionKey;
  title: string;
  state: "ok" | "failed";
  items: TodayItem[];
  empty: { text: string; href: string; label: string };
  note?: string;
}

export interface AccountsSection extends TodaySection { missing: TodayItem[]; source: "score_result" | "lead_score_legacy" | "none" }
export interface ApprovalsSection extends TodaySection { changes: number | null; assistant: number | null }

export interface TodayView {
  date: string;
  since: string;
  sections: { meetings: TodaySection; accounts: AccountsSection; signals: TodaySection; followups: TodaySection; approvals: ApprovalsSection; leases: TodaySection; milestones: TodaySection };
  recommended: TodayItem[];
  failed: string[];
}

export const SECTION_LABEL: Record<SectionKey, string> = {
  meetings: "Meetings", accounts: "Priority accounts", signals: "New signals", followups: "Follow-ups & commitments",
  approvals: "Approvals", leases: "Lease events", milestones: "Transaction deadlines",
};

const one = (v: any) => (Array.isArray(v) ? v[0] ?? null : v ?? null);
const must = <T>(r: { data: T | null; error: any }): T => { if (r.error) throw new Error(r.error.message ?? "query failed"); return (r.data ?? ([] as unknown as T)); };
const human = (s: string | null | undefined) => String(s ?? "unknown").replace(/_/g, " ");
const failedSection = <S extends TodaySection>(s: S): S => ({ ...s, state: "failed", items: [] });

// ------------------------------------------------------------------ pure section builders

const PREP_READY = new Set(["brief_ready", "reviewed", "completed"]);

export function buildMeetings(rows: any[], today: string, tz: string): TodaySection {
  const items = rows.map((r) => ({ ...r, meeting: one(r.meeting), org: one(r.org) }))
    .filter((r) => r.meeting?.start_at && r.status !== "cancelled")
    .sort((a, b) => String(a.meeting.start_at).localeCompare(String(b.meeting.start_at)))
    .map((r): TodayItem => {
      const day = localDate(new Date(r.meeting.start_at), tz);
      const isToday = day === today;
      const ready = PREP_READY.has(r.status) || (r.readiness ?? 0) >= 80;
      const prep = ready ? "prep ready" : r.readiness == null ? `prep ${human(r.status)}` : `prep ${r.readiness}% (${human(r.status)})`;
      const when = `${isToday ? "Today" : fmt(r.meeting.start_at, "EEE d MMM", tz)} ${fmt(r.meeting.start_at, "HH:mm", tz)}`;
      return {
        id: r.id, title: `${when} · ${r.meeting.title ?? "Meeting"}${r.org?.display_name ? ` · ${r.org.display_name}` : ""}`,
        badges: [{ label: prep, tone: ready ? "ok" : isToday ? "bad" : "warn" }],
        href: `/meetings/${r.id}`, actionLabel: ready ? "Review brief" : "Prepare",
        urgency: ready ? 0 : isToday ? 90 : 75 - Math.max(0, daysBetween(today, day)) * 5,
        reason: `${when}: preparation not ready (${prep}).`,
      };
    });
  return { key: "meetings", title: "Meetings — today and next 3 days", state: "ok", items,
    empty: { text: "No meetings in the next 4 days. Add one (or import an .ics) to get a prep brief and checklist.", href: "/meetings/new", label: "Add a meeting" } };
}

export interface AccountRow { entity_id: string; score: number; band: string; disqualified: boolean; confidence: string; completeness: number; factors: any[] | null; missing: string[] | null; recommended_action: string | null }

/** Why now = recommended action + the strongest known factors (stored explanations, no LLM). */
export function whyNow(r: AccountRow): string {
  const top = (r.factors ?? []).filter((f) => f.known && Number(f.points) > 0).sort((a, b) => Number(b.points) - Number(a.points)).slice(0, 2)
    .map((f) => `${f.label}: ${f.explanation}`);
  return [r.recommended_action, ...top].filter(Boolean).join(" · ") || "No supporting factor recorded yet.";
}

export function buildAccounts(rows: AccountRow[], names: Map<string, string>, legacy: { subject_id: string; total: number; tier: string }[] | null): AccountsSection {
  const empty = { text: "No scored companies yet. Import companies or leases, then run scoring — the lead model ranks who to call first.", href: "/scoring", label: "Open scoring" };
  if (!rows.length && legacy?.length) {
    const items = legacy.filter((l) => names.has(l.subject_id)).sort((a, b) => Number(b.total) - Number(a.total)).slice(0, 10).map((l): TodayItem => ({
      id: l.subject_id, title: names.get(l.subject_id)!, badges: [{ label: `${Number(l.total)}/100`, tone: "brand" }, { label: "legacy score", tone: "neutral" }],
      href: `/companies/${l.subject_id}`, actionLabel: "Open company", urgency: 0, reason: "",
      detail: `Legacy score tier: ${human(l.tier)}.`,
    }));
    return { key: "accounts", title: "Priority accounts", state: "ok", items, missing: [], source: "lead_score_legacy", empty,
      note: "Legacy lead_score shown — the current lead model (Module 3) has not scored this workspace yet. Run scoring to replace it." };
  }
  const visible = rows.filter((r) => names.has(r.entity_id));
  const unknown = (r: AccountRow) => r.confidence === "insufficient";
  const toItem = (r: AccountRow): TodayItem => {
    const name = names.get(r.entity_id)!;
    const gaps = r.missing ?? [];
    return {
      id: r.entity_id, title: name, detail: whyNow(r),
      badges: [{ label: `${r.score}/100 · ${r.band}`, tone: r.score >= 60 ? "ok" : r.score >= 40 ? "warn" : "neutral" },
        { label: `confidence ${r.confidence}`, tone: r.confidence === "high" ? "ok" : "neutral" },
        ...(gaps.length ? [{ label: `${gaps.length} missing`, tone: "warn" as Tone }] : [])],
      href: `/scoring/lead/${r.entity_id}`, actionLabel: "See why",
      urgency: r.score >= 60 ? 50 + Math.round(r.score / 10) : 0,
      reason: `${name} scores ${r.score}/100 on lead priority — ${whyNow(r)}`,
    };
  };
  const items = visible.filter((r) => !r.disqualified && !unknown(r)).sort((a, b) => b.score - a.score || a.entity_id.localeCompare(b.entity_id)).slice(0, 10).map(toItem);
  // unknown ≠ low score: incomplete scores are listed separately with what is missing, never ranked as "low"
  const missing = visible.filter((r) => !r.disqualified && (unknown(r) || r.completeness < 50)).sort((a, b) => a.completeness - b.completeness || b.score - a.score).slice(0, 10)
    .map((r): TodayItem => ({
      id: `m-${r.entity_id}`, title: names.get(r.entity_id)!, detail: (r.missing ?? []).length ? `Missing: ${(r.missing ?? []).slice(0, 4).join("; ")}` : `Only ${r.completeness}% of the model's inputs are known.`,
      badges: [{ label: `${r.completeness}% known`, tone: "warn" }, { label: unknown(r) ? "score unknown — not low" : `${r.score}/100 provisional`, tone: "neutral" }],
      href: `/scoring/lead/${r.entity_id}`, actionLabel: "Fill gaps", urgency: 0, reason: "",
    }));
  return { key: "accounts", title: "Priority accounts", state: "ok", items, missing, source: rows.length ? "score_result" : "none", empty };
}

export function buildSignals(rows: any[], sinceLabel: string): TodaySection {
  const items = [...rows].sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0) || String(b.detected_at).localeCompare(String(a.detected_at))).map((s): TodayItem => {
    const org = one(s.org)?.display_name ?? s.entity_name_raw ?? null;
    return {
      id: s.id, title: `${org ? `${org} — ` : ""}${s.title}`, detail: s.recommended_action ? `Suggested: ${s.recommended_action}` : undefined,
      badges: [{ label: human(s.status), tone: s.status === "approved" ? "ok" : "neutral" }, { label: human(s.verification), tone: s.verification === "fact" ? "ok" : "warn" },
        { label: `${s.priority_band ?? "low"} priority`, tone: s.priority_band === "high" ? "bad" : s.priority_band === "medium" ? "warn" : "neutral" }],
      href: `/signals/${s.id}`, actionLabel: s.status === "new" ? "Review" : "Open",
      urgency: s.priority_band === "high" ? 60 + Math.round(Number(s.priority ?? 0) / 10) : 0,
      reason: `New ${s.priority_band ?? "low"}-priority signal (${human(s.verification)})${s.recommended_action ? ` — ${s.recommended_action}` : ""}.`,
    };
  });
  return { key: "signals", title: `New signals since ${sinceLabel}`, state: "ok", items,
    empty: { text: "No new signals since the last working day. Add a watch or run research to surface expansion, lease and leadership news.", href: "/signals", label: "Open signals" } };
}

export function buildFollowups(outreach: any[] | null, tasks: any[] | null, today: string, tz: string): TodaySection {
  const items: TodayItem[] = [];
  for (const o of outreach ?? []) {
    const who = one(o.person)?.full_name ?? "contact";
    const org = one(o.org)?.display_name;
    const late = daysBetween(o.planned_on, today);
    items.push({ id: `o-${o.id}`, title: `Follow up ${who}${org ? ` · ${org}` : ""}`, detail: o.reason ?? undefined,
      badges: [{ label: late > 0 ? `${late} d overdue` : "due today", tone: late > 0 ? "bad" : "warn" }, { label: human(o.channel), tone: "neutral" }],
      href: `/outreach/${o.id}`, actionLabel: "Open draft", urgency: (late > 0 ? 80 : 65) + Math.min(late, 10),
      reason: `Follow-up with ${who}${late > 0 ? ` is ${late} day(s) overdue` : " is due today"}.` });
  }
  for (const t of tasks ?? []) {
    const due = localDate(new Date(t.due_at), tz);
    const late = daysBetween(due, today);
    items.push({ id: `t-${t.id}`, title: t.title, badges: [{ label: late > 0 ? `${late} d overdue` : "due today", tone: late > 0 ? "bad" : "warn" }, { label: "commitment", tone: "neutral" }],
      href: late > 0 ? "/tasks?state=overdue" : "/tasks", actionLabel: "Open task", urgency: (late > 0 ? 78 : 60) + Math.min(late, 10),
      reason: `Commitment "${t.title}"${late > 0 ? ` is ${late} day(s) overdue` : " is due today"}.` });
  }
  items.sort((a, b) => b.urgency - a.urgency || a.title.localeCompare(b.title));
  return { key: "followups", title: "Follow-ups & commitments due", state: "ok", items,
    empty: { text: "Nothing due or overdue. Plan outreach to the top accounts to keep the pipeline moving.", href: "/outreach/new", label: "Plan outreach" } };
}

export function buildApprovals(changes: number | null, assistant: number | null): ApprovalsSection {
  const total = (changes ?? 0) + (assistant ?? 0);
  const items: TodayItem[] = total ? [{ id: "approvals", title: `${total} pending approval${total === 1 ? "" : "s"}`,
    detail: [changes != null ? `${changes} record change(s)` : null, assistant != null ? `${assistant} assistant action(s)` : null].filter(Boolean).join(" · "),
    badges: [], href: "/approvals", actionLabel: "Review", urgency: 40 + Math.min(total, 10), reason: `${total} change(s) wait for your approval before they reach the records.` }] : [];
  return { key: "approvals", title: "Pending approvals", state: "ok", items, changes, assistant,
    note: changes == null || assistant == null ? `Partial count — ${changes == null ? "record changes" : "assistant approvals"} could not be read.` : undefined,
    empty: { text: "No approvals waiting. Captures and imports that change records will queue here.", href: "/approvals", label: "Open approvals" } };
}

const DEADLINE_EVENTS = new Set(["notice_deadline", "lockin_end"]);

/** Which window an event falls in: deadline (notice / lock-in) or 3/6/12 months (edate arithmetic, S5). */
export function leaseWindow(eventType: string, eventDate: string, today: string): string | null {
  if (eventDate < today) return null;
  if (DEADLINE_EVENTS.has(eventType)) return eventDate <= edate(today, 12) ? "deadline" : null;
  for (const m of [...LEASE_WINDOWS].sort((a, b) => a - b)) if (eventDate <= edate(today, m)) return `${m} months`;
  return null;
}

export function buildLeaseEvents(rows: any[], today: string): TodaySection {
  const items = rows.filter((e) => e.event_date).map((e) => ({ e, w: leaseWindow(e.event_type, e.event_date, today) })).filter((x) => x.w)
    .map(({ e, w }): TodayItem => {
      const lease = one(e.lease);
      const tenant = one(lease?.tenant)?.display_name ?? lease?.tenant_name_raw ?? "Tenant unknown";
      const days = daysBetween(today, e.event_date);
      const deadline = w === "deadline";
      return {
        id: e.id, title: `${tenant} — ${human(e.event_type)} ${e.event_date} (${days} d)`,
        badges: [{ label: deadline ? human(e.event_type) : `≤ ${w}`, tone: deadline ? "bad" : days <= 92 ? "warn" : "neutral" },
          { label: e.confirmed ? `${human(e.date_basis)} · confirmed` : `${human(e.date_basis)} · unconfirmed`, tone: e.confirmed ? "ok" : "neutral" },
          ...(e.needs_review ? [{ label: "needs review", tone: "warn" as Tone }] : [])],
        href: "/leases", actionLabel: deadline ? "Plan notice" : "Open Leases",
        urgency: deadline && days <= 30 ? 100 - days : deadline && days <= 90 ? 55 : !deadline && days <= 92 ? 45 : 0,
        reason: `${tenant}: ${human(e.event_type)} on ${e.event_date} (${days} days, ${human(e.date_basis)}${e.confirmed ? "" : ", unconfirmed"}).`,
      };
    }).sort((a, b) => b.urgency - a.urgency || a.title.localeCompare(b.title));
  return { key: "leases", title: "Lease events — 12/6/3-month windows, lock-in & notice deadlines", state: "ok", items,
    empty: { text: "No lease events in the next 12 months. Import a lease schedule so expiries, lock-ins and notice dates are tracked.", href: "/imports", label: "Import leases" } };
}

export function buildMilestones(rows: any[], today: string): TodaySection {
  const items = rows.filter((m) => m.due_date).map((m): TodayItem => {
    const opp = one(m.opportunity);
    const days = daysBetween(today, m.due_date);
    return {
      id: m.id, title: `${m.title}${opp?.name ? ` · ${opp.name}` : ""}`, detail: `Due ${m.due_date}${m.proof_required ? " · proof required" : ""}`,
      badges: [{ label: days < 0 ? `${-days} d overdue` : days === 0 ? "due today" : `in ${days} d`, tone: days < 0 ? "bad" : days <= 3 ? "warn" : "neutral" },
        { label: human(m.status), tone: m.status === "blocked" ? "bad" : "neutral" }],
      href: `/deals/${m.opportunity_id}`, actionLabel: "Open deal",
      urgency: days < 0 ? 85 + Math.min(-days, 10) : days <= 7 ? 70 - days : 0,
      reason: `Deal milestone "${m.title}" ${days < 0 ? `is ${-days} day(s) overdue` : `is due in ${days} day(s)`}.`,
    };
  }).sort((a, b) => b.urgency - a.urgency || a.title.localeCompare(b.title));
  return { key: "milestones", title: "Transaction deadlines", state: "ok", items,
    empty: { text: "No deal milestones due in the next 14 days. Add a checklist to an active deal to track approvals, documents and possession.", href: "/deals", label: "Open deals" } };
}

/** Deterministic merge (no LLM): highest urgency first, ties by section order then title; one per link; top 5. */
export function recommendActions(sections: TodaySection[], n = 5): TodayItem[] {
  const order: SectionKey[] = ["leases", "meetings", "milestones", "followups", "signals", "accounts", "approvals"];
  const all = sections.filter((s) => s.state === "ok").flatMap((s) => s.items.map((i) => ({ i, o: order.indexOf(s.key) }))).filter((x) => x.i.urgency > 0)
    .sort((a, b) => b.i.urgency - a.i.urgency || a.o - b.o || a.i.title.localeCompare(b.i.title));
  const seen = new Set<string>();
  const out: TodayItem[] = [];
  for (const { i } of all) {
    const k = `${i.href}|${i.id}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(i);
    if (out.length >= n) break;
  }
  return out;
}

// ------------------------------------------------------------------ loader

export interface TodayCtx { db: any; workspaceId: string; userId: string; timezone?: string }

export async function loadToday(c: TodayCtx, now = new Date(), opts: { timeoutMs?: number } = {}): Promise<TodayView> {
  const tz = c.timezone || "Asia/Kolkata";
  const today = localDate(now, tz);
  const since = sinceDate(today);
  const start = atLocal(today, "00:00", tz);
  const endToday = new Date(start.getTime() + 86_400_000);
  const end4 = new Date(start.getTime() + 4 * 86_400_000);
  const sinceStart = atLocal(since, "00:00", tz);
  const { db, workspaceId: ws, userId: me } = c;
  const mine = `assigned_user_id.eq.${me},and(assigned_user_id.is.null,owner_user_id.eq.${me})`;
  const failed: string[] = [];
  const tb = <T>(label: SectionKey | string, p: () => Promise<T>) => timeboxed(label, p, failed, opts.timeoutMs);

  const [meetings, scores, signals, outreach, tasks, changes, assistant, leaseEvents, milestones] = await Promise.all([
    tb("meetings", async () => must(await db.from("meeting_prep").select("id, status, readiness, meeting:meeting_visit_id!inner(title, start_at, owner_user_id), org:org_id(display_name)")
      .eq("workspace_id", ws).is("archived_at", null).eq("meeting.owner_user_id", me).gte("meeting.start_at", start.toISOString()).lt("meeting.start_at", end4.toISOString()).limit(50)) as any[]),
    tb("accounts", async () => {
      const rows = must(await db.from("score_result").select("entity_id, score, band, disqualified, confidence, completeness, factors, missing, recommended_action")
        .eq("workspace_id", ws).eq("model_key", "lead").eq("entity_type", "organisation").eq("is_current", true).is("archived_at", null)
        .order("score", { ascending: false }).limit(200)) as AccountRow[];
      const legacy = rows.length ? null : must(await db.from("lead_score").select("subject_id, total, tier").eq("workspace_id", ws).eq("subject_type", "organisation")
        .eq("is_current", true).is("archived_at", null).order("total", { ascending: false }).limit(50)) as any[];
      const ids = [...new Set([...rows.map((r) => r.entity_id), ...(legacy ?? []).map((l) => l.subject_id)])];
      const names = new Map<string, string>();
      for (let k = 0; k < ids.length; k += 200) {
        for (const o of must(await db.from("organisation").select("id, display_name").eq("workspace_id", ws).is("archived_at", null).in("id", ids.slice(k, k + 200))) as any[]) names.set(o.id, o.display_name);
      }
      return { rows, legacy, names };
    }),
    tb("signals", async () => must(await db.from("signal").select("id, title, status, verification, priority, priority_band, recommended_action, detected_at, entity_name_raw, org:org_id(display_name)")
      .eq("workspace_id", ws).is("archived_at", null).in("status", ["new", "reviewing", "approved"]).gte("detected_at", sinceStart.toISOString())
      .order("priority", { ascending: false }).limit(20)) as any[]),
    tb("followups", async () => must(await db.from("outreach_item").select("id, planned_on, channel, reason, person:person_id(full_name), org:org_id(display_name)")
      .eq("workspace_id", ws).is("archived_at", null).in("status", ["planned", "draft", "approved"]).not("planned_on", "is", null).lte("planned_on", today)
      .or(mine).order("planned_on").limit(30)) as any[]),
    tb("commitments", async () => must(await db.from("task").select("id, title, due_at, status")
      .eq("workspace_id", ws).is("archived_at", null).in("status", ["open", "stale"]).not("due_at", "is", null).lt("due_at", endToday.toISOString())
      .or(mine).order("due_at").limit(30)) as any[]),
    tb("approvals", async () => { const r = await db.from("change_proposal").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("state", "proposed").is("archived_at", null); if (r.error) throw new Error(r.error.message); return (r.count ?? 0) as number; }),
    tb("assistant approvals", async () => { const r = await db.from("assistant_approval").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("owner_user_id", me).eq("status", "pending").is("archived_at", null); if (r.error) throw new Error(r.error.message); return (r.count ?? 0) as number; }),
    tb("leases", async () => must(await db.from("lease_event").select("id, event_type, event_date, date_basis, confirmed, needs_review, lease:lease_id(id, tenant_name_raw, tenant:tenant_org_id(display_name))")
      .eq("workspace_id", ws).is("archived_at", null).gte("event_date", today).lte("event_date", edate(today, 12)).order("event_date").limit(300)) as any[]),
    tb("milestones", async () => must(await db.from("deal_milestone").select("id, title, due_date, status, proof_required, opportunity_id, opportunity:opportunity_id(name)")
      .eq("workspace_id", ws).is("archived_at", null).in("status", ["open", "in_progress", "blocked"]).not("due_date", "is", null)
      .lte("due_date", addDays(new Date(`${today}T00:00:00Z`), 14).toISOString().slice(0, 10)).order("due_date").limit(50)) as any[]),
  ]);

  const accountsBase = buildAccounts([], new Map(), null);
  const followBase = buildFollowups([], [], today, tz);
  const sections: TodayView["sections"] = {
    meetings: meetings === null ? failedSection(buildMeetings([], today, tz)) : buildMeetings(meetings, today, tz),
    accounts: scores === null ? failedSection(accountsBase) : buildAccounts(scores.rows, scores.names, scores.legacy),
    signals: signals === null ? failedSection(buildSignals([], fmt(sinceStart, "EEE d MMM", tz))) : buildSignals(signals, fmt(sinceStart, "EEE d MMM", tz)),
    followups: outreach === null && tasks === null ? failedSection(followBase) : {
      ...buildFollowups(outreach, tasks, today, tz),
      note: outreach === null ? "Couldn't load — outreach follow-ups (commitments shown)." : tasks === null ? "Couldn't load — tasks and commitments (follow-ups shown)." : undefined,
    },
    approvals: changes === null && assistant === null ? failedSection(buildApprovals(null, null)) : buildApprovals(changes, assistant),
    leases: leaseEvents === null ? failedSection(buildLeaseEvents([], today)) : buildLeaseEvents(leaseEvents, today),
    milestones: milestones === null ? failedSection(buildMilestones([], today)) : buildMilestones(milestones, today),
  };
  const recommended = recommendActions(Object.values(sections));
  return { date: today, since, sections, recommended, failed };
}
