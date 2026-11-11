import "server-only";
/**
 * brief module jobs. Scheduler (`schedule`, called on every /api/cron/tick) enqueues tz-aware jobs with dedupe keys
 * (scheduler.ts#planSchedule) and cancels queued T-60 jobs whose meeting was cancelled/deleted/rescheduled.
 * Handlers run with the service-role client: every query filters workspace_id, and per-user content is filtered with
 * the member's access (visibility.ts) so a brief never shows what RLS would hide from that user (S1/S2).
 */
import type { Job, JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Db } from "@/lib/supabase/server";
import { atLocal, localDate } from "@/lib/util/time";
import { componentRows, effectiveTaskState } from "./builder";
import { deliverBrief, generateDailyBrief, latestBrief, noAiCaller, saveBriefVersion } from "./brief-service";
import { stableHash } from "@/lib/util/crypto";
import { addDays, isoWeekKey } from "./dates";
import { loadMemberAccess, loadSettings, loadWorkspace, notify } from "./db";
import { chunkKeys, rowsByKeys } from "./keys";
import { loadApproaches, loadMeetings, loadOpenTasks, loadPipeline, loadSources, toTaskLite, type LoadCtx } from "./data";
import { buildPreMeetingBrief, buildReconciliation, buildWeekly } from "./other-briefs";
import { buildDailyPlan, loadCurrentScoresWithSource, scoreResultToRow, type ScoreResultRow } from "./plan";
import { loadRadar, persistCalculatedEvents, raiseRadarAlerts, raiseRadarTasks } from "./radar-data";
import { runCaretaker } from "./caretaker-data";
import { meetingVersionKey, planSchedule, staleMeetingJobs, type MeetingCtx, type WorkspaceCtx } from "./scheduler";
import { computeScores, persistScores } from "./scoring-data";
import { explain } from "./scoring";
import { resolveSettings, type BriefSettings } from "./settings";
import { canRead } from "./visibility";
import { housekeepTasks } from "./tasks-service";

function chunk<T>(a: T[], n = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

// ------------------------------------------------------------------ scheduler

export async function schedule(now: Date, admin: Db = createAdminClient()): Promise<{ enqueued: number; cancelled: number }> {
  const { data: wss, error } = await admin.from("workspace").select("id, timezone, status").eq("status", "active");
  if (error) throw error;
  if (!wss?.length) return { enqueued: 0, cancelled: 0 };
  const ids = wss.map((w: { id: string }) => w.id);
  const [{ data: members }, { data: settingRows }, { data: prefs }, { data: meetings }] = await Promise.all([
    admin.from("membership").select("workspace_id, user_id, role").in("workspace_id", ids),
    admin.from("workspace_setting").select("workspace_id, key, value").in("workspace_id", ids).in("key", ["brief", "brief_time", "cohort_targets", "size_rules"]),
    admin.from("user_preference").select("workspace_id, user_id, prefs").in("workspace_id", ids),
    admin.from("meeting_visit").select("id, workspace_id, owner_user_id, external_calendar_id, start_at, status, archived_at")
      .in("workspace_id", ids).is("archived_at", null).gt("start_at", now.toISOString()).lte("start_at", new Date(now.getTime() + 26 * 3_600_000).toISOString()).limit(5000),
  ]);
  const wsCtx: WorkspaceCtx[] = wss.map((w: { id: string; timezone: string; status: string }) => {
    const map = Object.fromEntries((settingRows ?? []).filter((r: any) => r.workspace_id === w.id).map((r: any) => [r.key, r.value]));
    const base = resolveSettings(map.brief, null, map);
    return {
      id: w.id, timezone: w.timezone, status: w.status, settings: base,
      members: (members ?? []).filter((m: any) => m.workspace_id === w.id).map((m: any) => ({
        userId: m.user_id, role: m.role,
        settings: resolveSettings(map.brief, (prefs ?? []).find((p: any) => p.workspace_id === w.id && p.user_id === m.user_id)?.prefs, map),
      })),
    };
  });
  const mts: MeetingCtx[] = (meetings ?? []).map((m: any) => ({ id: m.id, workspaceId: m.workspace_id, ownerUserId: m.owner_user_id, externalId: m.external_calendar_id, startAt: m.start_at, status: m.status, archivedAt: m.archived_at }));
  const specs = planSchedule(now, wsCtx, mts);

  // skip keys that already exist in ANY state (a dead/cancelled job is not silently re-created every tick)
  const existing = new Set<string>();
  for (const part of chunkKeys(specs.map((s) => s.dedupeKey))) { // long dedupe keys: length-bounded (see keys.ts)
    const { data, error } = await admin.from("job").select("dedupe_key").in("workspace_id", ids).in("dedupe_key", part);
    if (error) throw new Error(`job dedupe lookup failed: ${error.message}`);
    for (const r of data ?? []) existing.add(r.dedupe_key);
  }
  let enqueued = 0;
  for (const s of specs) {
    if (existing.has(s.dedupeKey)) continue;
    await enqueue({ workspaceId: s.workspaceId, type: s.type, payload: s.payload, dueAt: s.dueAt, dedupeKey: s.dedupeKey, maxAttempts: s.type === "brief.recalc" ? 3 : 4 });
    enqueued++;
  }
  // hourly "deadline enters 48 h" watch per workspace (dedupe = workspace + UTC hour)
  const hour = now.toISOString().slice(0, 13);
  const watchKeys = ids.map((id: string) => `brief.deadline_watch:${id}:${hour}`);
  const { data: haveWatch } = await admin.from("job").select("dedupe_key").in("workspace_id", ids).in("dedupe_key", watchKeys);
  const hw = new Set((haveWatch ?? []).map((r: { dedupe_key: string }) => r.dedupe_key));
  for (const id of ids) {
    const key = `brief.deadline_watch:${id}:${hour}`;
    if (hw.has(key)) continue;
    await enqueue({ workspaceId: id, type: "brief.deadline_watch", payload: { hour }, dueAt: now, dedupeKey: key, maxAttempts: 2 });
    enqueued++;
  }
  const cancelled = await cancelStalePreMeetingJobs(admin, ids);
  return { enqueued, cancelled };
}

/** Calendar reschedule test: queued T-60 jobs for cancelled/deleted/rescheduled meetings are cancelled. */
export async function cancelStalePreMeetingJobs(admin: Db, workspaceIds: string[]): Promise<number> {
  const { data: jobs } = await admin.from("job").select("id, workspace_id, payload").in("workspace_id", workspaceIds)
    .eq("job_type", "brief.pre_meeting").eq("state", "queued").limit(2000);
  if (!jobs?.length) return 0;
  const meetingIds = [...new Set(jobs.map((j: any) => j.payload?.meetingId).filter(Boolean))] as string[];
  const ms: MeetingCtx[] = [];
  for (const part of chunk(meetingIds)) {
    const { data } = await admin.from("meeting_visit").select("id, workspace_id, owner_user_id, external_calendar_id, start_at, status, archived_at").in("workspace_id", workspaceIds).in("id", part);
    for (const m of data ?? []) ms.push({ id: m.id, workspaceId: m.workspace_id, ownerUserId: m.owner_user_id, externalId: m.external_calendar_id, startAt: m.start_at, status: m.status, archivedAt: m.archived_at });
  }
  const stale = staleMeetingJobs(jobs.map((j: any) => ({ id: j.id, workspaceId: j.workspace_id, payload: j.payload ?? {} })), ms);
  for (const s of stale) {
    await admin.from("job").update({ state: "cancelled", last_error: `cancelled: ${s.reason}`, updated_at: new Date().toISOString() }).eq("id", s.id).eq("state", "queued");
  }
  return stale.length;
}

// ------------------------------------------------------------------ handler context

interface MemberJobCtx { admin: Db; c: LoadCtx; settings: BriefSettings; date: string }

async function memberCtx(job: Job, admin: Db): Promise<MemberJobCtx | { skipped: string }> {
  const workspaceId = job.workspace_id;
  const p = job.payload as { userId?: string; date?: string };
  if (!workspaceId || !p.userId) return { skipped: "missing workspace/user" };
  const ws = await loadWorkspace(admin, workspaceId);
  if (ws.status !== "active") return { skipped: `workspace ${ws.status}` };
  const access = await loadMemberAccess(admin, workspaceId, p.userId);
  if (!access) return { skipped: "user is no longer a member" };
  const settings = await loadSettings(admin, workspaceId, p.userId);
  const date = p.date ?? localDate(new Date(), ws.timezone);
  return { admin, settings, date, c: { db: admin, workspaceId, userId: p.userId, tz: ws.timezone || "Asia/Kolkata", access } };
}

function withMember(fn: (m: MemberJobCtx, job: Job) => Promise<unknown>, adminFactory: () => Db = createAdminClient): JobHandler {
  return async (job) => {
    const admin = adminFactory();
    const m = await memberCtx(job, admin);
    if ("skipped" in m) return m;
    return fn(m, job);
  };
}

// ------------------------------------------------------------------ handlers

async function workspaceOwner(admin: Db, workspaceId: string): Promise<string | null> {
  const { data: owner } = await admin.from("membership").select("user_id").eq("workspace_id", workspaceId).eq("role", "owner").limit(1).maybeSingle();
  return owner?.user_id ?? null;
}

/**
 * Lease radar refresh (daily at 07:00 inside recalc, and on lease / lease_event / lease-document changes via
 * brief.radar): persist calculated events, raise review / reverse-plan / notice tasks, raise event alerts.
 */
export async function runRadarRefresh(admin: Db, workspaceId: string, date: string) {
  const ws = await loadWorkspace(admin, workspaceId);
  if (ws.status !== "active") return { skipped: `workspace ${ws.status}` };
  const settings = await loadSettings(admin, workspaceId, null);
  const radar = await loadRadar(admin, workspaceId, date, settings);
  const owner = await workspaceOwner(admin, workspaceId);
  const events = await persistCalculatedEvents(admin, workspaceId, radar);
  const tasks = await raiseRadarTasks(admin, workspaceId, radar, date, owner);
  const alerts = await raiseRadarAlerts(admin, workspaceId, radar, date, owner);
  return { radar, settings, owner, result: { leases: radar.items.length, events, tasks, alerts } };
}

export async function runRecalc(admin: Db, workspaceId: string, date: string) {
  const r = await runRadarRefresh(admin, workspaceId, date);
  if ("skipped" in r) return r;
  const { radar, settings, owner } = r;
  const caretaker = await runCaretaker(admin, workspaceId, date, radar.items, owner);
  const scores = await computeScores(admin, workspaceId, date, settings, radar.items);
  const persisted = await persistScores(admin, workspaceId, scores);
  return { leases: radar.items.length, tasks: r.result.tasks, events: r.result.events, alerts: r.result.alerts, caretaker, scored: scores.length, ...persisted };
}

/** Event-driven re-plan (debounced by mudar_app.brief_enqueue): rebuild today's plan/day order for every member. */
export async function runReplan(admin: Db, workspaceId: string, reason: string, now = new Date()) {
  const ws = await loadWorkspace(admin, workspaceId);
  if (ws.status !== "active") return { skipped: `workspace ${ws.status}` };
  const tz = ws.timezone || "Asia/Kolkata";
  const date = localDate(now, tz);
  const { data: members } = await admin.from("membership").select("user_id").eq("workspace_id", workspaceId);
  const out: { userId: string; planId: string | null; conflicts: number; blocked: number }[] = [];
  for (const m of members ?? []) {
    const access = await loadMemberAccess(admin, workspaceId, m.user_id);
    if (!access) continue;
    const settings = await loadSettings(admin, workspaceId, m.user_id);
    if (!settings.workdays.includes(isoWeekdayOf(date)) && !settings.weekendBrief) continue;
    const plan = await buildDailyPlan({ db: admin, workspaceId, userId: m.user_id, tz, access }, settings, date, { now, reason });
    out.push({ userId: m.user_id, planId: plan.id, conflicts: plan.agenda?.conflicts.length ?? 0, blocked: plan.agenda?.blocked.length ?? 0 });
  }
  return { date, reason, plans: out };
}

function isoWeekdayOf(date: string): number {
  const d = new Date(date + "T00:00:00Z").getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * Hourly: anything whose deadline is now within 48 h (open tasks, lease events incl. calculated ones, deal milestones)
 * gets one private alert (dedupe by item + due) and, if anything newly entered the window, a debounced re-plan.
 */
export async function runDeadlineWatch(admin: Db, workspaceId: string, now = new Date()) {
  const ws = await loadWorkspace(admin, workspaceId);
  if (ws.status !== "active") return { skipped: `workspace ${ws.status}` };
  const tz = ws.timezone || "Asia/Kolkata";
  const today = localDate(now, tz);
  const horizon = new Date(now.getTime() + 48 * 3_600_000);
  const horizonDate = localDate(horizon, tz);
  const owner = await workspaceOwner(admin, workspaceId);
  const items: { key: string; user: string | null; title: string; due: string; href: string }[] = [];
  const { data: tasks } = await admin.from("task").select("id, title, due_at, assigned_user_id, owner_user_id").eq("workspace_id", workspaceId).is("archived_at", null)
    .eq("status", "open").gt("due_at", now.toISOString()).lte("due_at", horizon.toISOString()).limit(2000);
  for (const t of tasks ?? []) items.push({ key: `deadline48:task:${t.id}:${t.due_at}`, user: t.assigned_user_id ?? t.owner_user_id ?? owner, title: t.title, due: t.due_at, href: `/tasks?focus=${t.id}` });
  const { data: evs } = await admin.from("lease_event").select("id, lease_id, event_type, event_date, date_basis, owner_user_id").eq("workspace_id", workspaceId).is("archived_at", null)
    .in("event_type", ["notice_deadline", "break", "escalation", "option", "expiry", "lockin_end"]).gte("event_date", today).lte("event_date", horizonDate).limit(2000);
  for (const e of evs ?? []) items.push({ key: `deadline48:lease_event:${e.id}:${e.event_date}`, user: e.owner_user_id ?? owner, title: `${e.event_type.replace(/_/g, " ")} ${e.event_date} (${e.date_basis.replace(/_/g, " ")})`, due: e.event_date, href: `/leases?lease=${e.lease_id}` });
  const { data: ms } = await admin.from("deal_milestone").select("id, title, due_date, status, opportunity_id, owner_user_id").eq("workspace_id", workspaceId).is("archived_at", null)
    .not("status", "in", "(done,waived,not_applicable)").gte("due_date", today).lte("due_date", horizonDate).limit(2000);
  for (const m of ms ?? []) items.push({ key: `deadline48:milestone:${m.id}:${m.due_date}`, user: m.owner_user_id ?? owner, title: m.title, due: m.due_date, href: `/deals/${m.opportunity_id}` });
  if (!items.length) return { entered: 0 };
  const have = new Set<string>((await rowsByKeys<{ dedupe_key: string }>(admin, "outbox", workspaceId, "dedupe_key", items.map((i) => i.key), "dedupe_key")).map((r) => r.dedupe_key));
  let entered = 0;
  for (const it of items) {
    if (have.has(it.key) || !it.user) continue;
    await notify(admin, workspaceId, it.user, "deadline_48h", it.key, { title: `Due within 48 h: ${it.title}`, due: it.due, href: it.href });
    entered++;
  }
  if (entered) await admin.schema("mudar_app").rpc("brief_enqueue", { p_ws: workspaceId, p_type: "brief.replan", p_reason: "deadline entered 48 h", p_debounce_sec: 120 });
  return { entered };
}

export async function runReconcile(m: MemberJobCtx, now = new Date()) {
  const { admin, c, settings, date } = m;
  const hk = await housekeepTasks(admin, c.workspaceId, c.userId, now, settings.staleTaskAfterDays);
  const tasks = await loadOpenTasks(c);
  const dayStart = atLocal(date, "00:00", c.tz).toISOString();
  const { data: done } = await admin.from("task").select("id, title, due_at, priority, status, snoozed_until, linked_entity_type, linked_entity_id, source, completed_at, updated_at, classification, owner_user_id, archived_at, assigned_user_id")
    .eq("workspace_id", c.workspaceId).eq("status", "done").gte("completed_at", dayStart)
    .or(`assigned_user_id.eq.${c.userId},and(assigned_user_id.is.null,owner_user_id.eq.${c.userId})`).limit(200);
  const tomorrow = addDays(date, 1);
  const [tMeetings, tPlan] = await Promise.all([loadMeetings(c, tomorrow), buildDailyPlan(c, settings, tomorrow)]);
  const content = buildReconciliation({
    date, now: now.toISOString(), tasks, doneToday: (done ?? []).filter((t: any) => !c.access || canRead(c.access, t, "task")).map(toTaskLite), housekeeping: hk,
    tomorrowMeetings: tMeetings, tomorrowTargets: tPlan.targets.map((t) => ({ name: t.name, total: t.total })), staleAfterDays: settings.staleTaskAfterDays,
  });
  const res = await saveBriefVersion(admin, c, { date, kind: "reconciliation", content: { ...content, content_hash: stableHash(content) }, synthesisStatus: "fallback_no_ai", sourceHealth: {} });
  return { briefId: res.brief.id, created: res.created, ...hk };
}

export async function runWeekly(m: MemberJobCtx, week: string, now = new Date()) {
  const { admin, c, settings, date } = m;
  const [approaches, pipeline, tasks, sources] = await Promise.all([loadApproaches(c, date), loadPipeline(c, date), loadOpenTasks(c), loadSources(c, settings, now)]);
  const weekStart = addDays(date, -6);
  const { count: doneThisWeek } = await admin.from("task").select("id", { count: "exact", head: true }).eq("workspace_id", c.workspaceId).eq("status", "done")
    .gte("completed_at", atLocal(weekStart, "00:00", c.tz).toISOString()).or(`assigned_user_id.eq.${c.userId},and(assigned_user_id.is.null,owner_user_id.eq.${c.userId})`);
  const { rows: scores } = await loadCurrentScoresWithSource(c); // score_result (lead model); legacy lead_score only if none
  const nowIso = now.toISOString();
  const content = buildWeekly({
    week, date, approachesThisMonth: approaches.thisMonth, cohortTarget: settings.cohortTarget, doneThisWeek: doneThisWeek ?? 0,
    overdue: tasks.filter((t) => effectiveTaskState(t, nowIso, settings.staleTaskAfterDays) === "overdue").length,
    stale: tasks.filter((t) => effectiveTaskState(t, nowIso, settings.staleTaskAfterDays) === "stale").length,
    pipeline, sources, scoredAccounts: scores.length, actThisWeek: scores.filter((s) => s.tier === "act_this_week").length,
  });
  const res = await saveBriefVersion(admin, c, { date, kind: "weekly", subjectKey: week, content: { ...content, content_hash: stableHash(content) }, synthesisStatus: "fallback_no_ai", sourceHealth: {} });
  return { briefId: res.brief.id, created: res.created };
}

/** T-60 brief. Re-validates the meeting at run time: cancelled / deleted / rescheduled => no (stale) brief. */
export async function runPreMeeting(admin: Db, job: Pick<Job, "workspace_id" | "payload">) {
  const p = job.payload as { meetingId?: string; versionKey?: string; userId?: string };
  const workspaceId = job.workspace_id;
  if (!workspaceId || !p.meetingId || !p.userId) return { skipped: "bad payload" };
  const { data: mt } = await admin.from("meeting_visit").select("id, title, start_at, end_at, kind, status, location, route_group, external_calendar_id, opportunity_id, linked_entity_type, linked_entity_id, classification, owner_user_id, archived_at")
    .eq("workspace_id", workspaceId).eq("id", p.meetingId).maybeSingle();
  if (!mt || mt.archived_at) return { skipped: "meeting deleted" };
  if (mt.status === "cancelled") return { skipped: "meeting cancelled" };
  const version = meetingVersionKey({ id: mt.id, externalId: mt.external_calendar_id, startAt: mt.start_at });
  if (version !== p.versionKey) return { skipped: "meeting rescheduled (stale job)" };
  const ws = await loadWorkspace(admin, workspaceId);
  if (ws.status !== "active") return { skipped: `workspace ${ws.status}` };
  const access = await loadMemberAccess(admin, workspaceId, p.userId);
  if (!access || !canRead(access, mt, "meeting_visit")) return { skipped: "user cannot read meeting" };
  const tz = ws.timezone || "Asia/Kolkata";
  const date = localDate(new Date(mt.start_at), tz);
  const settings = await loadSettings(admin, workspaceId, p.userId);
  const c: LoadCtx = { db: admin, workspaceId, userId: p.userId, tz, access };

  let opportunity: any = null;
  if (mt.opportunity_id) {
    const { data } = await admin.from("opportunity").select("id, name, stage, next_action, next_action_due, org_id, classification, owner_user_id, archived_at").eq("workspace_id", workspaceId).eq("id", mt.opportunity_id).maybeSingle();
    if (data && canRead(access, data, "opportunity")) opportunity = data;
  }
  const orgId: string | null = mt.linked_entity_type === "organisation" ? mt.linked_entity_id : opportunity?.org_id ?? null;
  let org: { id: string; name: string } | null = null;
  if (orgId) {
    const { data } = await admin.from("organisation").select("id, display_name, classification, owner_user_id, archived_at").eq("workspace_id", workspaceId).eq("id", orgId).maybeSingle();
    if (data && canRead(access, data, "organisation")) org = { id: data.id, name: data.display_name };
  }
  let score = null;
  let openTasks: ReturnType<typeof toTaskLite>[] = [];
  let recent: any[] = [];
  let radarItems: Awaited<ReturnType<typeof loadRadar>>["items"] = [];
  if (org) {
    const { data: sr } = await admin.from("score_result").select("entity_id, score, band, disqualified, confidence, completeness, factors, missing, recommended_action, calculated_at")
      .eq("workspace_id", workspaceId).eq("model_key", "lead").eq("entity_type", "organisation").eq("entity_id", org.id).eq("is_current", true).is("archived_at", null).limit(1).maybeSingle();
    // legacy lead_score only when Module 3 has not scored this company
    const s: any = sr ? scoreResultToRow(sr as ScoreResultRow) : (await admin.from("lead_score").select("total, tier, overrides, components, evidence_confidence, warmth").eq("workspace_id", workspaceId)
      .eq("subject_type", "organisation").eq("subject_id", org.id).eq("is_current", true).limit(1).maybeSingle()).data;
    if (s) {
      const rows = componentRows(s.components);
      score = { total: Number(s.total), tier: s.tier, why: explain({ total: Number(s.total), components: s.components, overrides: s.overrides ?? [] } as never), components: rows.map(({ label, points, max, band }) => ({ label, points, max, band })) };
    }
    const { data: ts } = await admin.from("task").select("id, title, due_at, priority, status, snoozed_until, linked_entity_type, linked_entity_id, source, completed_at, updated_at, classification, owner_user_id, archived_at")
      .eq("workspace_id", workspaceId).eq("linked_entity_type", "organisation").eq("linked_entity_id", org.id).in("status", ["open", "snoozed", "stale"]).is("archived_at", null).limit(50);
    openTasks = (ts ?? []).filter((t: any) => canRead(access, t, "task")).map(toTaskLite);
    const { data: links } = await admin.from("interaction_link").select("interaction_id").eq("workspace_id", workspaceId).eq("entity_type", "organisation").eq("entity_id", org.id).limit(200);
    const iids = (links ?? []).map((l: any) => l.interaction_id);
    if (iids.length) {
      const { data: its } = await admin.from("interaction").select("id, occurred_at, channel, direction, subject, summary, classification, owner_user_id, archived_at")
        .eq("workspace_id", workspaceId).in("id", iids.slice(0, 200)).order("occurred_at", { ascending: false }).limit(20);
      recent = (its ?? []).filter((i: any) => canRead(access, i, "interaction")).map((i: any) => ({ occurredAt: i.occurred_at, channel: i.channel, direction: i.direction, subject: i.subject, summary: i.summary }));
    }
    radarItems = (await loadRadar(admin, workspaceId, date, settings, access)).items.filter((r) => r.tenantOrgId === org!.id);
  }
  const content = buildPreMeetingBrief({
    meeting: { id: mt.id, title: mt.title, startAt: mt.start_at, endAt: mt.end_at, kind: mt.kind, status: mt.status, location: mt.location, routeGroup: mt.route_group, versionKey: version },
    org, score, openTasks, recent, radar: radarItems,
    opportunity: opportunity ? { name: opportunity.name, stage: opportunity.stage, nextAction: opportunity.next_action, nextActionDue: opportunity.next_action_due } : null,
  });
  const res = await saveBriefVersion(admin, c, { date, kind: "pre_meeting", subjectKey: version, content: { ...content, content_hash: stableHash(content) }, synthesisStatus: "fallback_no_ai", sourceHealth: {} });
  if (!res.brief.delivered_at) await admin.from("brief").update({ delivered_at: new Date().toISOString() }).eq("workspace_id", workspaceId).eq("id", res.brief.id);
  await notify(admin, workspaceId, p.userId, "pre_meeting_brief", `pre_meeting:${mt.id}:${version}`, { brief_id: res.brief.id, meeting_id: mt.id, start_at: mt.start_at, title: mt.title, href: `/today?meeting=${mt.id}` });
  return { briefId: res.brief.id, created: res.created };
}

export async function runDeliver(m: MemberJobCtx, now = new Date()) {
  const { admin, c, settings, date } = m;
  let brief = await latestBrief(admin, c.workspaceId, c.userId, date, "daily");
  let fallback = false;
  if (!brief) { // delivery never waits on the AI job
    brief = (await generateDailyBrief(c, settings, { date, now, caller: noAiCaller, generatedBy: "deliver_fallback" })).brief;
    fallback = true;
  }
  await deliverBrief(admin, c.workspaceId, brief, now);
  return { briefId: brief.id, version: brief.version, fallback };
}

export const handlers: Record<string, JobHandler> = {
  "brief.recalc": async (job) => {
    if (!job.workspace_id) return { skipped: "no workspace" };
    const date = (job.payload as { date?: string }).date;
    const admin = createAdminClient();
    const ws = await loadWorkspace(admin, job.workspace_id);
    return runRecalc(admin, job.workspace_id, date ?? localDate(new Date(), ws.timezone));
  },
  "brief.replan": async (job) => {
    if (!job.workspace_id) return { skipped: "no workspace" };
    return runReplan(createAdminClient(), job.workspace_id, String((job.payload as { reason?: string }).reason ?? "event"));
  },
  "brief.radar": async (job) => {
    if (!job.workspace_id) return { skipped: "no workspace" };
    const admin = createAdminClient();
    const ws = await loadWorkspace(admin, job.workspace_id);
    const r = await runRadarRefresh(admin, job.workspace_id, localDate(new Date(), ws.timezone));
    return "skipped" in r ? r : r.result;
  },
  "brief.caretaker": async (job) => {
    if (!job.workspace_id) return { skipped: "no workspace" };
    const admin = createAdminClient();
    const ws = await loadWorkspace(admin, job.workspace_id);
    if (ws.status !== "active") return { skipped: `workspace ${ws.status}` };
    const date = localDate(new Date(), ws.timezone);
    const settings = await loadSettings(admin, job.workspace_id, null);
    const radar = await loadRadar(admin, job.workspace_id, date, settings);
    return runCaretaker(admin, job.workspace_id, date, radar.items, await workspaceOwner(admin, job.workspace_id));
  },
  "brief.deadline_watch": async (job) => {
    if (!job.workspace_id) return { skipped: "no workspace" };
    return runDeadlineWatch(createAdminClient(), job.workspace_id);
  },
  "brief.plan": withMember(async (m) => {
    const hk = await housekeepTasks(m.admin, m.c.workspaceId, m.c.userId, new Date(), m.settings.staleTaskAfterDays);
    const plan = await buildDailyPlan(m.c, m.settings, m.date, { reason: "scheduled 07:20" });
    return { planId: plan.id, targets: plan.targets.length, mode: plan.mode, ...hk };
  }),
  "brief.generate": withMember(async (m) => {
    const r = await generateDailyBrief(m.c, m.settings, { date: m.date, generatedBy: "job" });
    return { briefId: r.brief.id, version: r.brief.version, created: r.created, synthesis: r.brief.synthesis_status };
  }),
  "brief.health_check": withMember(async (m) => (await import("./watchdog")).preBriefCheck(m.admin, m.c, m.settings, m.date)),
  "brief.deliver": withMember((m) => runDeliver(m)),
  "brief.health_alert": withMember(async (m) => (await import("./watchdog")).postBriefCheck(m.admin, m.c, m.settings, m.date)),
  "brief.reconcile": withMember((m) => runReconcile(m)),
  "brief.weekly": withMember((m, job) => runWeekly(m, (job.payload as { week?: string }).week ?? isoWeekKey(m.date))),
  "brief.pre_meeting": (job) => runPreMeeting(createAdminClient(), job),
};

export { memberCtx };
