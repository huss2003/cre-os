/**
 * DB integration (shared local Supabase). Fixtures live in WS1 under a unique tag and far-future dates; the colleague
 * (editor, no see-all) is the brief user so other agents' WS1 rows stay invisible and assertions are stable.
 * Covers: Brief delivery (one version + one notification per user/date, model outage fallback), 07:55/08:05 watchdog,
 * visibility filtering in job mode, Calendar reschedule (T-60), task complete/snooze with RLS + optimistic concurrency.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, tag, userClient, USERS, WS1 } from "../../../../tests/helpers";
import { deliverBrief, generateDailyBrief, latestBrief, saveBriefVersion } from "../brief-service";
import { cancelStalePreMeetingJobs, memberCtx, runPreMeeting } from "../jobs";
import { loadSettings } from "../db";
import { meetingVersionKey } from "../scheduler";
import type { StructuredCaller } from "../synthesis";
import { completeTask, listTasks, reopenTask, snoozeTask } from "../tasks-service";
import { postBriefCheck, preBriefCheck } from "../watchdog";

const admin = adminClient();
const T = tag("brief");
const D1 = "2031-01-15"; // Wednesday
const D2 = "2031-01-16";
const D3 = "2031-01-17";
const NOW = new Date("2031-01-15T02:10:00Z"); // 07:40 IST
const COL = USERS.colleague.id;
const OWN = USERS.owner.id;
const mockCaller: StructuredCaller = async (c) => ({ data: c.mock(), mocked: true, model: "mock:test" });

const ids: Record<string, string> = {};

async function ins(table: string, row: Record<string, unknown>) {
  const { data, error } = await admin.from(table).insert({ workspace_id: WS1, ...row }).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data!.id as string;
}

async function jobCtx(userId: string, date: string) {
  const m = await memberCtx({ id: "x", workspace_id: WS1, job_type: "brief.generate", payload: { userId, date }, attempts: 1, due_at: "", dedupe_key: null }, admin as never);
  if ("skipped" in m) throw new Error(m.skipped);
  return m;
}

beforeAll(async () => {
  ids.org = await ins("organisation", { display_name: `${T} Acme`, owner_user_id: COL });
  ids.hiddenOrg = await ins("organisation", { display_name: `${T} Hidden`, owner_user_id: OWN });
  ids.lease = await ins("lease", { tenant_org_id: ids.org, area_sf: 20000, contractual_expiry: "2031-06-30", owner_user_id: COL });
  ids.ev = await ins("lease_event", { lease_id: ids.lease, event_type: "notice_deadline", event_date: "2031-01-25", date_basis: "contractual", owner_user_id: COL });
  ids.hiddenLease = await ins("lease", { tenant_org_id: ids.hiddenOrg, area_sf: 9000, contractual_expiry: "2031-02-28", owner_user_id: OWN });
  ids.task = await ins("task", { title: `${T} send proposal`, due_at: "2031-01-12T12:30:00Z", priority: 80, assigned_user_id: COL, owner_user_id: COL, source: "manual" });
  ids.meeting = await ins("meeting_visit", { title: `${T} site visit`, start_at: "2031-01-15T05:00:00Z", end_at: "2031-01-15T06:00:00Z", kind: "site_visit", location: "Baner, Pune", owner_user_id: COL, provider: "manual", external_calendar_id: `${T}-ext`, linked_entity_type: "organisation", linked_entity_id: ids.org });
  ids.reply = await ins("interaction", { occurred_at: "2031-01-14T12:00:00Z", channel: "email", direction: "inbound", subject: `${T} Re: options`, summary: "Can we visit Thursday?", is_meaningful: true, owner_user_id: COL });
  await ins("interaction_link", { interaction_id: ids.reply, entity_type: "organisation", entity_id: ids.org, owner_user_id: COL });
});

afterAll(async () => {
  const W = (t: string) => admin.from(t).delete().eq("workspace_id", WS1);
  await W("outbox").like("dedupe_key", `brief_ready:${COL}:2031-01-1%`);
  await W("outbox").like("dedupe_key", `brief_alert:${COL}:2031-01-1%`);
  await W("outbox").like("dedupe_key", `pre_meeting:${ids.meeting}:%`);
  await W("brief").eq("user_id", COL).in("brief_date", [D1, D2, D3]);
  await W("daily_plan").eq("user_id", COL).in("plan_date", [D1, D2, D3]);
  await W("brief_health_run").eq("user_id", COL).in("run_date", [D1, D2, D3]);
  await W("job").like("dedupe_key", `%${T}%`);
  await W("interaction_link").eq("interaction_id", ids.reply);
  await W("interaction").eq("id", ids.reply);
  await W("task").or(`id.eq.${ids.task},idempotency_key.like.brief.radar:${ids.lease}%`);
  await W("meeting_visit").eq("id", ids.meeting);
  await W("lease_event").eq("lease_id", ids.lease);
  await W("lease").in("id", [ids.lease, ids.hiddenLease]);
  await W("lead_score").in("subject_id", [ids.org, ids.hiddenOrg]);
  await W("organisation").in("id", [ids.org, ids.hiddenOrg]);
});

describe("brief generation (user client, RLS)", () => {
  it("builds the deterministic brief from RLS-visible data, with mock synthesis, one version per unchanged content", async () => {
    const db = await userClient("colleague");
    const settings = await loadSettings(db as never, WS1, COL);
    const c = { db: db as never, workspaceId: WS1, userId: COL, tz: "Asia/Kolkata", access: null };
    const r1 = await generateDailyBrief(c, settings, { date: D1, now: NOW, caller: mockCaller });
    expect(r1.created).toBe(true);
    const b = r1.brief.content;
    expect(b.deadlines.items.find((d) => d.leaseId === ids.lease)).toMatchObject({ kind: "notice", date: "2031-01-25", days: 10, verified: true });
    expect(b.deadlines.items.some((d) => d.leaseId === ids.hiddenLease)).toBe(false); // owner-only lease invisible
    expect(b.overdue.items.map((t) => t.id)).toContain(ids.task);
    expect(b.meetings.clusters.flatMap((x) => x.meetings).map((m) => m.id)).toContain(ids.meeting);
    expect(b.actions[0].title).toMatch(/Notice deadline 2031-01-25/);
    // no connector for the colleague => replies were not checked (never "no replies")
    expect(b.replies.state).toBe("unavailable");
    expect(b.fallbackText).not.toMatch(/No new meaningful replies/);
    expect(r1.brief.synthesis_status).toBe("ok");
    const again = await generateDailyBrief(c, settings, { date: D1, now: NOW, caller: mockCaller });
    expect(again.created).toBe(false);
    expect(again.brief.id).toBe(r1.brief.id);
  });

  it("another tenant cannot read the brief; the owner (admin) can", async () => {
    const other = await userClient("other");
    const { data } = await other.from("brief").select("id").eq("user_id", COL).eq("brief_date", D1);
    expect(data ?? []).toHaveLength(0);
    const owner = await userClient("owner");
    const { data: od } = await owner.from("brief").select("id").eq("user_id", COL).eq("brief_date", D1);
    expect((od ?? []).length).toBeGreaterThan(0);
  });
});

describe("Brief delivery (job mode, admin client + member access)", () => {
  it("model outage => fallback_no_ai brief with notice; access filter hides owner-only rows; one notification per user/date", async () => {
    const m = await jobCtx(COL, D1);
    const outage: StructuredCaller = async () => { throw Object.assign(new Error("down"), { reason: "provider_error" }); };
    const r = await generateDailyBrief(m.c, m.settings, { date: D1, now: NOW, caller: outage, mode: "on" });
    // same deterministic content as the user-generated version => reused (better synthesis kept)
    expect(r.created).toBe(false);
    expect(r.brief.content.deadlines.items.some((d) => d.leaseId === ids.hiddenLease)).toBe(false);

    const fresh = await saveBriefVersion(admin as never, { workspaceId: WS1, userId: COL }, { date: D1, kind: "daily", content: { ...r.brief.content, content_hash: "changed-" + T }, synthesisStatus: "fallback_no_ai", sourceHealth: {} });
    expect(fresh.created).toBe(true);
    expect(fresh.brief.version).toBe(r.brief.version + 1);

    await deliverBrief(admin as never, WS1, fresh.brief);
    await deliverBrief(admin as never, WS1, fresh.brief);
    const { data: ob } = await admin.from("outbox").select("id, kind, payload").eq("workspace_id", WS1).eq("dedupe_key", `brief_ready:${COL}:${D1}`);
    expect(ob).toHaveLength(1);
    expect((await latestBrief(admin as never, WS1, COL, D1))!.delivered_at).not.toBeNull();
  });

  it("07:55 watchdog generates a deterministic brief without AI when missing", async () => {
    const m = await jobCtx(COL, D3);
    const r = await preBriefCheck(admin as never, m.c, m.settings, D3, new Date("2031-01-17T02:25:00Z"));
    expect(r.action).toBe("fallback_generated");
    const b = await latestBrief(admin as never, WS1, COL, D3);
    // AI policy off (default): the code summary is the real synthesis — no "missing AI" notice
    expect(b!.synthesis_status).toBe("ok");
    expect((b!.content as any).synthesis.source).toBe("code");
    expect((b!.content as any).synthesis.notice).toBeNull();
    const { data: hr } = await admin.from("brief_health_run").select("check_kind, action_taken, brief_present").eq("workspace_id", WS1).eq("user_id", COL).eq("run_date", D3);
    expect(hr).toEqual([{ check_kind: "pre_brief", action_taken: "fallback_generated", brief_present: true }]);
    const again = await preBriefCheck(admin as never, m.c, m.settings, D3, new Date("2031-01-17T02:25:00Z"));
    expect(again.action).toBe("none");
  });

  it("08:05 watchdog delivers the fallback and alerts user + owners once", async () => {
    const m = await jobCtx(COL, D2);
    const r = await postBriefCheck(admin as never, m.c, m.settings, D2, new Date("2031-01-16T02:35:00Z"));
    expect(r).toMatchObject({ action: "owner_alerted", wasMissing: true });
    const delivered = await latestBrief(admin as never, WS1, COL, D2);
    expect(delivered!.delivered_at).not.toBeNull();
    const again = await postBriefCheck(admin as never, m.c, m.settings, D2, new Date("2031-01-16T02:40:00Z"));
    expect(again.action).toBe("none");
    const { data: alerts } = await admin.from("outbox").select("user_id").eq("workspace_id", WS1).like("dedupe_key", `brief_alert:${COL}:${D2}:%`);
    expect((alerts ?? []).map((a: { user_id: string }) => a.user_id).sort()).toEqual([OWN, COL].sort());
    const { data: ready } = await admin.from("outbox").select("id").eq("workspace_id", WS1).eq("dedupe_key", `brief_ready:${COL}:${D2}`);
    expect(ready).toHaveLength(1);
  });
});

describe("Calendar reschedule (T-60 pre-meeting brief)", () => {
  it("builds for the current version; a rescheduled/cancelled meeting gets no stale brief and its queued job is cancelled", async () => {
    const { data: mt } = await admin.from("meeting_visit").select("id, external_calendar_id, start_at").eq("id", ids.meeting).single();
    const v1 = meetingVersionKey({ id: mt!.id, externalId: mt!.external_calendar_id, startAt: mt!.start_at });
    const r = await runPreMeeting(admin as never, { workspace_id: WS1, payload: { meetingId: ids.meeting, versionKey: v1, userId: COL } });
    expect(r).toHaveProperty("briefId");
    const pm = await latestBrief(admin as never, WS1, COL, D1, "pre_meeting", v1);
    expect((pm!.content as any).org.name).toBe(`${T} Acme`);
    expect((pm!.content as any).leases[0].notice).toBe("2031-01-25");

    // queued job for v1, then the meeting moves by two hours
    const { error } = await admin.from("job").insert({ workspace_id: WS1, job_type: "brief.pre_meeting", payload: { meetingId: ids.meeting, versionKey: v1, userId: COL }, due_at: "2031-01-15T04:00:00Z", dedupe_key: `brief.pre_meeting:${WS1}:${ids.meeting}:${v1}:${T}` });
    expect(error).toBeNull();
    await admin.from("meeting_visit").update({ start_at: "2031-01-15T07:00:00Z", end_at: "2031-01-15T08:00:00Z" }).eq("id", ids.meeting);
    expect(await runPreMeeting(admin as never, { workspace_id: WS1, payload: { meetingId: ids.meeting, versionKey: v1, userId: COL } })).toEqual({ skipped: "meeting rescheduled (stale job)" });
    expect(await cancelStalePreMeetingJobs(admin as never, [WS1])).toBeGreaterThanOrEqual(1);
    const { data: j } = await admin.from("job").select("state, last_error").eq("dedupe_key", `brief.pre_meeting:${WS1}:${ids.meeting}:${v1}:${T}`).single();
    expect(j).toEqual({ state: "cancelled", last_error: "cancelled: meeting rescheduled" });

    await admin.from("meeting_visit").update({ status: "cancelled" }).eq("id", ids.meeting);
    const v2 = meetingVersionKey({ id: ids.meeting, externalId: mt!.external_calendar_id, startAt: "2031-01-15T07:00:00Z" });
    expect(await runPreMeeting(admin as never, { workspace_id: WS1, payload: { meetingId: ids.meeting, versionKey: v2, userId: COL } })).toEqual({ skipped: "meeting cancelled" });
    expect(await latestBrief(admin as never, WS1, COL, D1, "pre_meeting", v2)).toBeNull();
  });
});

describe("tasks: complete with evidence, snooze, reopen (RLS + row_version)", () => {
  it("enforces evidence and optimistic concurrency; states stay distinct", async () => {
    const db = (await userClient("colleague")) as never;
    const now = new Date("2031-01-15T02:10:00Z");
    const [t] = (await listTasks(db, WS1, COL, { state: "overdue", scope: "mine", q: T }, { now }));
    expect(t).toMatchObject({ id: ids.task, state: "overdue" });
    await expect(completeTask(db, WS1, ids.task, { expectedVersion: t.rowVersion, evidence: "" }, now)).rejects.toThrow();
    await expect(completeTask(db, WS1, ids.task, { expectedVersion: t.rowVersion + 5, evidence: "sent it" }, now)).rejects.toMatchObject({ status: 409 });

    const snoozed = await snoozeTask(db, WS1, ids.task, { expectedVersion: t.rowVersion, until: "2031-01-18T03:30:00Z" }, now);
    expect(snoozed.state).toBe("snoozed");
    expect((await listTasks(db, WS1, COL, { state: "snoozed", scope: "mine", q: T }, { now })).map((x) => x.id)).toEqual([ids.task]);
    expect(await listTasks(db, WS1, COL, { state: "overdue", scope: "mine", q: T }, { now })).toHaveLength(0);

    const reopened = await reopenTask(db, WS1, ids.task, { expectedVersion: snoozed.rowVersion }, now);
    const done = await completeTask(db, WS1, ids.task, { expectedVersion: reopened.rowVersion, evidence: "Proposal emailed 15 Jan; client acknowledged" }, now);
    expect(done).toMatchObject({ state: "done", completionEvidence: "Proposal emailed 15 Jan; client acknowledged" });
    const retry = await completeTask(db, WS1, ids.task, { expectedVersion: reopened.rowVersion, evidence: "dup" }, now);
    expect(retry.completionEvidence).toBe("Proposal emailed 15 Jan; client acknowledged"); // idempotent retry

    const other = (await userClient("other")) as never;
    await expect(completeTask(other, WS1, ids.task, { expectedVersion: done.rowVersion, evidence: "nope" }, now)).rejects.toMatchObject({ status: 404 });
  });
});
