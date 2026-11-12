/**
 * DB integration (shared local Supabase, WS1, unique tag, far-future dates 2032 so nothing else collides).
 * Spec §18 Test 1 (daily plan), Test 2 (meeting brief) + Test 3 (cancel/reschedule), Test 7 (AI provider unavailable),
 * Workflow F (no duplicate task). Mock AI only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, tag, USERS, WS1 } from "../../../../tests/helpers";
import { AiUnavailableError } from "@/lib/ai/gateway";
import { enqueueSpecs, memberSlots, schedule } from "./jobs";
import { retryPlanAi, runDailyPlan } from "./daily-plan";
import { detectCompletedMeetings, prepKey, runMeetingPrep, runPostMeeting, scheduleMeetingPreps } from "./meetings";
import { runOverdueCommitments } from "./commitments";
import { resolveOrchSettings } from "./settings";

const admin = adminClient() as any;
const T = tag("orchsch");
const COL = USERS.colleague.id;
const mockAi = (async (c: any) => ({ data: c.schema.parse(c.mock()), mocked: true, model: "mock:test", usage: { input: 0, output: 0, usd: 0 } })) as any;
const downAi = (async () => { throw new AiUnavailableError("provider_error", "simulated outage"); }) as any;
const ids: Record<string, string> = {};
const jobKeys: string[] = [];

async function ins(table: string, row: Record<string, unknown>) {
  const { data, error } = await admin.from(table).insert({ workspace_id: WS1, ...row }).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data!.id as string;
}

beforeAll(async () => {
  ids.org = await ins("organisation", { display_name: `${T} Acme`, owner_user_id: COL });
  ids.meeting = await ins("meeting_visit", { title: `${T} Acme visit`, start_at: "2032-03-10T09:00:00Z", end_at: "2032-03-10T10:00:00Z", kind: "site_visit", location: "Baner", owner_user_id: COL, provider: "manual" });
  ids.prepToday = await ins("meeting_prep", { meeting_visit_id: ids.meeting, owner_user_id: COL, org_id: ids.org, meeting_type: "site_visit" });
  ids.task = await ins("task", { title: `${T} send floor plans`, due_at: "2032-03-10T11:00:00Z", priority: 60, assigned_user_id: COL, owner_user_id: COL, source: "manual" });
  ids.overdue = await ins("task", { title: `${T} deliver comparison`, due_at: "2032-03-08T11:00:00Z", priority: 80, assigned_user_id: COL, owner_user_id: COL, source: "meeting" });
  ids.int = await ins("interaction", { occurred_at: "2032-03-01T10:00:00Z", channel: "meeting", direction: "outbound", subject: `${T} call`, owner_user_id: COL, promises: [{ who: "us", what: `${T} share rent comps`, due: "2032-03-05", status: "open" }] });
  await ins("interaction_link", { interaction_id: ids.int, entity_type: "organisation", entity_id: ids.org, owner_user_id: COL });
});

afterAll(async () => {
  await admin.from("job").delete().eq("workspace_id", WS1).like("dedupe_key", "%2032-03-1%");
  for (const k of jobKeys) await admin.from("job").delete().eq("workspace_id", WS1).eq("dedupe_key", k);
  await admin.from("job").delete().eq("workspace_id", WS1).in("job_type", ["orchestrator.meeting_prep", "orchestrator.plan_ai", "orchestrator.post_meeting"]).filter("payload->>prepId", "in", `(${[ids.prepToday, ids.prep2].filter(Boolean).join(",")})`);
  await admin.from("orch_plan").delete().eq("workspace_id", WS1).eq("user_id", COL).in("period_key", ["2032-03-10", "2032-03-11"]);
  await admin.from("outbox").delete().eq("workspace_id", WS1).eq("user_id", COL).or(`dedupe_key.like.%2032-03-1%,dedupe_key.like.%${ids.prepToday}%,dedupe_key.like.%${ids.prep2}%,dedupe_key.like.%${ids.int}%`);
  await admin.from("brief").delete().eq("workspace_id", WS1).eq("user_id", COL).in("brief_date", ["2032-03-10", "2032-03-11"]);
  await admin.from("daily_plan").delete().eq("workspace_id", WS1).eq("user_id", COL).in("plan_date", ["2032-03-10", "2032-03-11"]).then(undefined, () => undefined);
  await admin.from("task").delete().eq("workspace_id", WS1).or(`title.like.${T}%,title.like.%${T}%,linked_entity_id.eq.${ids.int}`);
  await admin.from("meeting_note").delete().in("prep_id", [ids.prepToday, ids.prep2].filter(Boolean));
  await admin.from("meeting_brief_version").delete().in("prep_id", [ids.prepToday, ids.prep2].filter(Boolean));
  await admin.from("meeting_prep").delete().in("id", [ids.prepToday, ids.prep2].filter(Boolean));
  await admin.from("meeting_visit").delete().in("id", [ids.meeting, ids.meeting2].filter(Boolean));
  await admin.from("interaction_link").delete().eq("interaction_id", ids.int);
  await admin.from("interaction").delete().eq("id", ids.int);
  await admin.from("organisation").delete().eq("id", ids.org);
});

describe("Test 1 — Daily plan", () => {
  it("is scheduled at the correct local time, once", async () => {
    const now = new Date("2032-03-10T01:00:00Z"); // 06:30 IST
    const spec = memberSlots(now, WS1, COL, resolveOrchSettings({ workspaceTz: "Asia/Kolkata" })).filter((s) => s.type === "orchestrator.daily_plan");
    expect(await enqueueSpecs(admin, spec)).toBe(1);
    expect(await enqueueSpecs(admin, spec)).toBe(0);
    await schedule(now, admin, { workspaceIds: [WS1] }); // full scheduler: still one job for this key
    const { data } = await admin.from("job").select("due_at, state").eq("dedupe_key", spec[0].dedupeKey);
    expect(data).toHaveLength(1);
    expect(new Date(data[0].due_at).toISOString()).toBe("2032-03-10T02:30:00.000Z");
  });

  it("retrieves calendar + task data, generates the plan, no duplicate tasks or plans on re-run", async () => {
    const now = new Date("2032-03-10T02:30:00Z");
    const countTasks = async () => (await admin.from("task").select("id", { count: "exact", head: true }).eq("workspace_id", WS1).or(`title.like.%${T}%,linked_entity_id.eq.${ids.int},linked_entity_id.eq.${ids.prepToday}`)).count;
    const before = await countTasks();
    const r1: any = await runDailyPlan(admin, WS1, COL, { now, ai: mockAi });
    const r2: any = await runDailyPlan(admin, WS1, COL, { now, ai: mockAi });
    expect(r1.aiStatus).toBe("ok");
    expect(r2.planId).toBe(r1.planId);
    expect(r2.changed).toBe(false);
    expect(await countTasks()).toBe(before);
    const { data: plans } = await admin.from("orch_plan").select("*").eq("workspace_id", WS1).eq("user_id", COL).eq("kind", "daily").eq("period_key", "2032-03-10");
    expect(plans).toHaveLength(1);
    const s = plans[0].sections;
    expect(plans[0].brief_id).toBeTruthy(); // extends the brief module's daily brief
    expect(s.todays_meetings.items.map((m: any) => m.id)).toContain(ids.meeting);
    expect(s.meetings_needing_prep.items.map((m: any) => m.id)).toContain(ids.meeting);
    expect(s.followups_due_today.items.map((t: any) => t.id)).toContain(ids.task);
    expect(s.overdue_commitments.items.map((c: any) => c.title).join("|")).toContain(`${T} share rent comps`);
    expect(s.overdue_commitments.items.map((c: any) => c.id)).toContain(ids.overdue);
    for (const k of ["priority_accounts", "new_signals", "lease_alerts", "deals_attention", "pending_approvals", "recommended_actions"]) expect(s[k]).toBeTruthy();
    const { data: notes } = await admin.from("outbox").select("id").eq("workspace_id", WS1).eq("dedupe_key", `orch:daily_plan:${COL}:2032-03-10`);
    expect(notes).toHaveLength(1);
  });
});

describe("Test 7 — AI provider unavailable", () => {
  it("still produces the basic plan from tasks/meetings; AI part delayed + retried later", async () => {
    const now = new Date("2032-03-11T02:30:00Z");
    const r: any = await runDailyPlan(admin, WS1, COL, { now, ai: downAi, notify: false, mode: "on" });
    expect(r.aiStatus).toBe("delayed");
    const { data: plan } = await admin.from("orch_plan").select("*").eq("workspace_id", WS1).eq("user_id", COL).eq("kind", "daily").eq("period_key", "2032-03-11").single();
    expect(plan.ai_summary.delayed).toBe(true);
    expect(plan.sections.todays_meetings.state).toBe("ok");
    expect(plan.sections.overdue_commitments.items.length).toBeGreaterThan(0); // task data still accessible
    const { data: brief } = await admin.from("brief").select("synthesis_status").eq("id", plan.brief_id).single();
    expect(brief.synthesis_status).toBe("fallback_no_ai");
    const { data: retry } = await admin.from("job").select("id, due_at").eq("dedupe_key", `orchestrator.plan_ai:${WS1}:${COL}:2032-03-11`);
    expect(retry).toHaveLength(1);
    jobKeys.push(`orchestrator.plan_ai:${WS1}:${COL}:2032-03-11`);
    await expect(retryPlanAi(admin, WS1, COL, "2032-03-11", downAi, "on")).rejects.toThrow(); // still down → queue backs off
    await retryPlanAi(admin, WS1, COL, "2032-03-11", mockAi, "on");
    const { data: after } = await admin.from("orch_plan").select("ai_status").eq("id", plan.id).single();
    expect(after.ai_status).toBe("ok");
  });
});

describe("Test 2 / 3 — Meeting brief scheduling, reschedule, cancel", () => {
  it("schedules prep ~1 h before, links the brief to the meeting, notifies; reschedule moves it; cancel stops it", async () => {
    ids.meeting2 = await ins("meeting_visit", { title: `${T} Beta discovery`, start_at: "2032-03-12T06:00:00Z", end_at: "2032-03-12T07:00:00Z", kind: "meeting", owner_user_id: COL, provider: "manual" });
    ids.prep2 = await ins("meeting_prep", { meeting_visit_id: ids.meeting2, owner_user_id: COL, org_id: ids.org });
    const now = new Date("2032-03-12T03:00:00Z");
    expect((await scheduleMeetingPreps(admin, WS1, { now, prepId: ids.prep2 })).scheduled).toBe(1);
    expect((await scheduleMeetingPreps(admin, WS1, { now, prepId: ids.prep2 })).scheduled).toBe(0); // idempotent
    const key1 = prepKey(ids.prep2, "2032-03-12T06:00:00Z");
    const { data: j1 } = await admin.from("job").select("due_at, state, payload").eq("dedupe_key", key1).single();
    expect(new Date(j1.due_at).toISOString()).toBe("2032-03-12T05:00:00.000Z");
    expect(j1.payload.prepId).toBe(ids.prep2);

    const r: any = await runMeetingPrep(admin, WS1, j1.payload, { now: new Date("2032-03-12T05:00:00Z"), ai: mockAi });
    expect(r.generated).toBe(true);
    const { data: prep } = await admin.from("meeting_prep").select("brief, brief_version, status").eq("id", ids.prep2).single();
    expect(prep.brief.overview.title).toBe(`${T} Beta discovery`);
    expect(prep.brief_version).toBe(1);
    const { data: ob } = await admin.from("outbox").select("id, notification_state!notification_state_outbox_id_fkey(record_type, record_id, body)").eq("workspace_id", WS1).eq("dedupe_key", `orch:meeting_prep_ready:${ids.prep2}:2032-03-12T06:00:00.000Z`).single();
    expect(ob.notification_state[0] ?? ob.notification_state).toMatchObject({ record_type: "meeting_prep", record_id: ids.prep2 });
    // second run reuses the current brief
    expect(((await runMeetingPrep(admin, WS1, j1.payload, { ai: mockAi })) as any).reused).toBe(true);

    // reschedule → old queued job cancelled, new one 1 h before the new start
    await admin.from("job").update({ state: "queued" }).eq("dedupe_key", key1); // (it was not claimed by a runner in the test)
    await admin.from("meeting_visit").update({ start_at: "2032-03-12T08:00:00Z", end_at: "2032-03-12T09:00:00Z" }).eq("id", ids.meeting2);
    const rs = await scheduleMeetingPreps(admin, WS1, { now, prepId: ids.prep2 });
    expect(rs).toMatchObject({ scheduled: 1, cancelled: 1 });
    const key2 = prepKey(ids.prep2, "2032-03-12T08:00:00Z");
    const { data: j2 } = await admin.from("job").select("due_at, state").eq("dedupe_key", key2).single();
    expect(new Date(j2.due_at).toISOString()).toBe("2032-03-12T07:00:00.000Z");
    expect((await admin.from("job").select("state").eq("dedupe_key", key1).single()).data.state).toBe("cancelled");

    // cancel → queued prep job cancelled, prep notifications cancelled, meeting history kept, unrelated task untouched
    await admin.from("meeting_visit").update({ status: "cancelled" }).eq("id", ids.meeting2);
    const rc = await scheduleMeetingPreps(admin, WS1, { now, prepId: ids.prep2 });
    expect(rc.cancelled).toBe(1);
    expect((await admin.from("job").select("state").eq("dedupe_key", key2).single()).data.state).toBe("cancelled");
    const { data: st } = await admin.from("notification_state").select("status").eq("outbox_id", ob.id).single();
    expect(st.status).toBe("cancelled");
    expect((await admin.from("meeting_visit").select("id").eq("id", ids.meeting2)).data).toHaveLength(1);
    expect((await admin.from("task").select("status").eq("id", ids.task).single()).data.status).toBe("open");
    expect(((await runMeetingPrep(admin, WS1, { prepId: ids.prep2, startAt: "2032-03-12T08:00:00.000Z" })) as any).skipped).toMatch(/cancelled/);
  });
});

describe("Workflow F — overdue commitment", () => {
  it("creates one follow-up task with the caretaker's key; re-runs never duplicate", async () => {
    const now = new Date("2032-03-10T06:00:00Z");
    const a: any = await runOverdueCommitments(admin, WS1, { now });
    const b: any = await runOverdueCommitments(admin, WS1, { now });
    expect(a.overdue).toBeGreaterThan(0);
    expect(b.created).toBe(0);
    const { data: tasks } = await admin.from("task").select("id, idempotency_key, linked_entity_type, priority").eq("workspace_id", WS1).eq("linked_entity_id", ids.int);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].idempotency_key).toMatch(new RegExp(`^brief\\.caretaker:promise:${ids.int}:`));
    expect(tasks[0].linked_entity_type).toBe("interaction");
  });
});

describe("Post-meeting processing (§4.4)", () => {
  it("never triggers on end time alone; runs once the meeting is completed; notes become proposals for review", async () => {
    const now = new Date("2032-03-10T12:00:00Z"); // after the 09:00–10:00 meeting
    expect(await detectCompletedMeetings(admin, WS1, { now })).toBe(0);
    expect(((await runPostMeeting(admin, WS1, ids.prepToday, { now })) as any).skipped).toMatch(/not confirmed/);
    await admin.from("meeting_visit").update({ status: "completed" }).eq("id", ids.meeting);
    expect(await detectCompletedMeetings(admin, WS1, { now })).toBe(1);
    expect(await detectCompletedMeetings(admin, WS1, { now })).toBe(0); // once per meeting
    expect(((await runPostMeeting(admin, WS1, ids.prepToday, { now, ai: mockAi })) as any).waiting).toBe("notes");
    await ins("meeting_note", { prep_id: ids.prepToday, kind: "note", text: "They need 300 seats by Dec. We will send 3 options by 2032-03-15.", owner_user_id: COL });
    const r: any = await runPostMeeting(admin, WS1, ids.prepToday, { now, ai: mockAi });
    expect(r.proposed).toBe(true);
    const { data: prep } = await admin.from("meeting_prep").select("outcome").eq("id", ids.prepToday).single();
    expect(prep.outcome.proposed).toBeTruthy();
    expect(prep.outcome.applied).toBeNull(); // nothing applied without the user's approval
  });
});
