/**
 * MASTER-SPEC Part 5 — remaining end-to-end business workflows (W2, W3, W4, W6, W8, W11, W12, W13, W14) chained through
 * the real services (WS1, RLS user clients / admin only for jobs, mock AI). W1/W5/W7/W9/W10 + W11 hand-off are in golden-path.test.ts.
 * Results go to /tmp/e2e-workflows.json for docs/integration/E2E-RESULTS.md.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { userClient, adminClient, WS1, USERS, tag } from "../helpers";
import type { DealsCtx } from "@/modules/deals/ctx";
import { createCapture, processCapture, submitReview } from "@/modules/capture/service";
import { likelyDuplicates, setRole } from "@/modules/contacts/service";
import { scoreEntity } from "@/modules/scoring/service";
import * as Out from "@/modules/outreach/service";
import * as Meet from "@/modules/meetings/service";
import { saveFeedback } from "@/modules/meetings/more";
import { createQuote, reviseQuote, listQuotes } from "@/modules/deals/quotes/service";
import { runShortlist } from "@/modules/deals/matching/service";
import { runComparison } from "@/modules/toolkit/comparison";
import * as Tx from "@/modules/transactions/service";
import { runLeaseChain } from "@/modules/workflows/service";
import { runEmployerChain, runFeedbackChain } from "@/modules/workflows/events";
import { proposePersonMove, approveAndApply } from "@/modules/changes/service";
import { scheduleMeetingPreps, runMeetingPrep, prepKey } from "@/modules/orchestrator/schedule/meetings";
import { runDailyPlan } from "@/modules/orchestrator/schedule/daily-plan";
import { registerWorkflow, runWorkflow, advanceExecution, getExecution, retryExecution, pauseExecution, resumeExecution, processEvents, listMarks, TemporaryError, PermanentError } from "@/modules/orchestrator";
import { localDate, edate } from "@/lib/util/time";

type Row = Record<string, any>;
const noAi = (async (c: { mock: () => unknown }) => ({ data: c.mock(), mocked: true, model: "mock:test", usage: { input: 0, output: 0, usd: 0 } })) as never;
const mockAi = (async (c: any) => ({ data: c.schema ? c.schema.parse(c.mock()) : c.mock(), mocked: true, model: "mock:test", usage: { input: 0, output: 0, usd: 0 } })) as never;
const T = tag("wf");
const ME = USERS.owner.id;
const today = localDate();
const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString();
let db: any; let admin: any; let dctx: DealsCtx;
const R: Record<string, Row> = {};
const rec = (k: string, v: Row) => { R[k] = { ...(R[k] ?? {}), ...v }; };
const ins = async (table: string, row: Row) => {
  const { data, error } = await db.from(table).insert({ workspace_id: WS1, owner_user_id: ME, ...row }).select("*").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data as Row;
};
const org = (n: string) => ins("organisation", { display_name: `${n} ${T}` });
const person = async (name: string, orgId: string, email?: string, title = "Head of Admin") => {
  const p = await ins("person", { full_name: name });
  await ins("employment", { person_id: p.id, org_id: orgId, title, is_current: true });
  if (email) await ins("contact_method", { person_id: p.id, method_type: "email", value: email, verify_status: "verified" });
  return p;
};
const outboxExternal = async (since: string) => (await admin.from("outbox").select("kind").eq("workspace_id", WS1).gte("created_at", since).neq("kind", "notification")).data as Row[];

beforeAll(async () => {
  db = await userClient("owner"); admin = adminClient();
  dctx = { db, workspaceId: WS1, userId: ME, role: "owner" };
});
afterAll(() => { fs.writeFileSync("/tmp/e2e-workflows.json", JSON.stringify({ T, R }, null, 2)); });

describe("Part 5 workflows", () => {
  it("W2 new contact discovery: duplicate detection → correct company → role → score → draft (not sent)", async () => {
    const o = await org("Nexa Pharma");
    const p1 = await person(`Sanjay Iyer ${T}`, o.id, `sanjay@nexa-${T}.example`, "Director Facilities");
    const p2 = await person(`Sanjay  Iyer ${T}`, o.id, `sanjay@nexa-${T}.example`, "Director Facilities"); // re-discovered
    const dups = await likelyDuplicates(db, WS1, p2.id);
    await setRole(db, WS1, ME, p1.id, "decision_maker", "high", "Owns facilities budget");
    const s = await scoreEntity(db, WS1, "lead", o.id, "w2");
    const out = await Out.createOutreach(db, WS1, ME, { personId: p1.id, channels: ["email"], ai: noAi });
    const it0 = (await db.from("outreach_item").select("org_id, status, sent_at, draft_id").eq("id", out.ids[0]).single()).data;
    rec("W2", { duplicatesFound: dups.map((d: Row) => ({ id: d.id === p1.id, reason: d.reasons ?? d.reason ?? d.score })), score: s.score, outreach: it0 });
    expect(dups.some((d: Row) => d.id === p1.id)).toBe(true);
    expect(it0.org_id).toBe(o.id);
    expect(it0.sent_at).toBeNull();
  });

  it("W3 information capture: source preserved, nothing written before Review, reviewed capture updates records once (idempotent)", async () => {
    const o = await org("Zenith Logistics");
    const since = new Date().toISOString();
    const text = `Call with Zenith Logistics ${T} today. They want 40,000 sq ft in Hinjewadi by March. Send floor plans tomorrow.`;
    const { capture } = await createCapture(db, WS1, ME, { kind: "text", text, sourceAt: new Date().toISOString() }, `w3-${T}`);
    const dup = await createCapture(db, WS1, ME, { kind: "text", text, sourceAt: new Date().toISOString() }, `w3-${T}`);
    const first = await processCapture(admin, WS1, capture.id);
    const before = (await admin.from("interaction").select("id").eq("workspace_id", WS1).eq("source_message_id", `capture:${capture.id}`)).data;
    const c1 = (await admin.from("capture").select("*").eq("id", capture.id).single()).data;
    const answers: Record<string, string> = {};
    ((c1.extraction?.ambiguities ?? []) as Row[]).forEach((a, i) => { if (a.options?.[0]) answers[String(i)] = a.options[0].value; });
    await submitReview(db, admin, WS1, ME, capture.id, { answers, done: true });
    const after = (await admin.from("interaction").select("id").eq("workspace_id", WS1).eq("source_message_id", `capture:${capture.id}`)).data;
    const c2 = (await admin.from("capture").select("*").eq("id", capture.id).single()).data;
    const reqs = (await db.from("requirement").select("id, area_target_sf, status").eq("org_id", o.id)).data as Row[];
    const props = (await db.from("change_proposal").select("id, state").eq("workspace_id", WS1).gte("created_at", since).in("target_id", [o.id, ...reqs.map((r) => r.id)])).data as Row[];
    rec("W3", { sameCaptureOnRetry: dup.capture.id === capture.id, firstStatus: first.status, writesBeforeReview: before?.length, mentionsOrg: JSON.stringify(c1.extraction ?? {}).includes(o.id), status: c2.status, interactions: after?.length, requirements: reqs, proposals: props.length, receipt: { status: c2.status, error: c2.error, extractionSummary: JSON.stringify(c2.extraction ?? {}).slice(0, 300) }, external: await outboxExternal(since) });
    expect(dup.capture.id).toBe(capture.id);
    expect(first.status).toBe("needs_review");
    expect(before ?? []).toHaveLength(0);
    expect(c2.status).toBe("reviewed");
    expect(after ?? []).toHaveLength(1);
    expect(reqs.length + props.length).toBeGreaterThan(0); // the stated requirement reaches Database or Review
  });

  it("W4 meeting prep: orchestrator schedules prep ~1 h before; brief has company, requirement, signal, commercial context; idempotent", async () => {
    const o = await org("Orbit Fintech");
    const p = await person(`Neha Joshi ${T}`, o.id, `neha@orbit-${T}.example`);
    const req = await ins("requirement", { org_id: o.id, title: `Orbit ${T} HQ`, area_target_sf: 30000, area_basis: "chargeable", status: "estimated" });
    await ins("signal", { category: "expansion", kind: "expansion", title: `Orbit ${T} raises Series C, plans Pune hub`, org_id: o.id, verification: "fact", confidence: "high", dedupe_key: `w4:${T}`, latest_evidence_on: today }).catch(() => null);
    const start = new Date(Date.now() + 3 * 3600_000); start.setUTCMinutes(0, 0, 0);
    const m = await Meet.createMeeting(db, WS1, ME, { title: `Orbit ${T} discovery`, start: start.toISOString(), type: "requirement", orgId: o.id, requirementId: req.id, personIds: [p.id] });
    const now = new Date(start.getTime() - 2 * 3600_000);
    const s1 = await scheduleMeetingPreps(admin, WS1, { now, prepId: m.id });
    const s2 = await scheduleMeetingPreps(admin, WS1, { now, prepId: m.id });
    const visit = (await db.from("meeting_prep").select("meeting_visit_id").eq("id", m.id).single()).data;
    const mv = visit?.meeting_visit_id ? (await db.from("meeting_visit").select("start_at").eq("id", visit.meeting_visit_id).single()).data : null;
    const key = prepKey(m.id, mv?.start_at ?? start.toISOString());
    const job = (await admin.from("job").select("due_at, payload").eq("dedupe_key", key).maybeSingle()).data;
    const r = job ? await runMeetingPrep(admin, WS1, job.payload, { now: new Date(job.due_at), ai: mockAi }) : null;
    const prep = (await db.from("meeting_prep").select("brief, brief_version").eq("id", m.id).single()).data;
    const bj = JSON.stringify(prep.brief ?? {});
    rec("W4", { scheduled: [s1, s2], jobDue: job?.due_at, start: mv?.start_at, run: r, briefVersion: prep.brief_version, has: { org: bj.includes(`Orbit Fintech ${T}`), requirement: bj.includes(`Orbit ${T} HQ`) || bj.includes("30000") || bj.includes("30,000"), signal: /Series C|Pune hub/.test(bj), attendee: bj.includes(`Neha Joshi ${T}`) } });
    await admin.from("job").delete().eq("dedupe_key", key);
    expect(s1.scheduled).toBe(1);
    expect(s2.scheduled).toBe(0);
    expect(new Date(job!.due_at).getTime()).toBe(new Date(mv!.start_at).getTime() - 3600_000);
    expect(prep.brief_version).toBeGreaterThan(0);
    expect(bj).toContain(`Neha Joshi ${T}`);
    expect(/Series C|Pune hub/.test(bj)).toBe(true); // Signal Engine context in the brief
  });

  it("W6 revised quotation: both versions preserved, conflict visible, dependants reassessed, affected transaction flagged", async () => {
    const o = await org("Vertex Retail");
    const req = await ins("requirement", { org_id: o.id, title: `Vertex ${T} store office`, area_target_sf: 12000, area_basis: "chargeable", status: "estimated" });
    const a = await ins("asset", { name: `Quote Tower ${T}`, asset_kind: "building", grade: "A" });
    const sp = await ins("space", { asset_id: a.id, chargeable_sf: 12000 });
    const t = await Tx.createTransaction({ db, workspaceId: WS1, userId: ME }, { name: `Vertex ${T}`, txType: "conventional_leasing", clientOrgId: o.id, requirementId: req.id, spaceIds: [sp.id] });
    const an0: Row = await runComparison(db, WS1, ME, { title: `Vertex cmp ${T}`, requirementId: req.id, assetIds: [a.id], manual: [] } as never);
    const q1: Row = await createQuote(dctx, { requirementId: req.id, spaceId: sp.id, validUntil: "2099-12-31", evidence: `landlord email ${T}`, terms: { rent: 90, rent_basis: "chargeable", cam_per_sf: 12, tenure_months: 60 } as never });
    const q2: Row = await reviseQuote(dctx, q1.id, { terms: { rent: 96, cam_per_sf: 14 } as never, evidence: `revised landlord email ${T}` });
    const all = await listQuotes(dctx, req.id);
    const evs = (await admin.from("event_outbox").select("id, event_type").eq("workspace_id", WS1).in("subject_id", [q1.id, q2.id])).data as Row[];
    await processEvents(db, WS1, { eventIds: evs.map((e) => e.id) } as never).catch(() => null);
    const marks = await listMarks(db, WS1, {}).catch(() => [] as Row[]);
    const txMarks = (marks as Row[]).filter((m) => m.entity_id === t.id);
    const reqMarks = (marks as Row[]).filter((m) => [req.id, an0.id, sp.id, a.id].includes(m.entity_id));
    const txEvents = (await db.from("tx_event").select("kind, summary").eq("transaction_id", t.id)).data as Row[];
    rec("W6", { versions: all.map((q: Row) => ({ v: q.version, superseded: !!q.superseded_by, rent: q.terms_json?.rent })), events: evs.map((e) => e.event_type), reqMarks: reqMarks.map((m) => m.mark), txMarks: txMarks.map((m) => m.mark), txTimeline: txEvents.map((e) => e.kind) });
    expect(all.length).toBe(2);
    expect(all.find((q: Row) => q.id === q1.id)?.superseded_by).toBeTruthy();
    expect(evs.map((e) => e.event_type)).toContain("commercial.quote_received");
    expect(reqMarks.length + txMarks.length).toBeGreaterThan(0);
    expect(txMarks.length + txEvents.filter((e) => /quote/.test(e.kind)).length).toBeGreaterThan(0); // W6 step 10/11: affected transaction identified
  });

  it("W8 property rejection: reason captured, option rejected, comparison re-versioned without it, next action created", async () => {
    const o = await org("Kite Media");
    const req = await ins("requirement", { org_id: o.id, title: `Kite ${T}`, area_target_sf: 10000, area_basis: "chargeable" });
    const mk = async (n: string, rent: number) => {
      const a = await ins("asset", { name: `${n} ${T}`, grade: "A", specs: {} });
      const sp = await ins("space", { asset_id: a.id, chargeable_sf: 10000 });
      await ins("availability", { space_id: sp.id, as_of: today, status: "available", asking_rent_min: rent, rent_basis: "chargeable", fact_status: "currently_confirmed" });
      return a.id as string;
    };
    const a1 = await mk("Ridge", 90); const a2 = await mk("Lake", 80);
    const opts: Record<string, string> = {};
    for (const a of [a1, a2]) opts[a] = (await ins("shortlist_option", { requirement_id: req.id, asset_id: a, version: 1, eligible: true, rubric_version: "match-v1", option_status: "shortlisted" })).id;
    const analysis = (await runComparison(db, WS1, ME, { title: `Kite cmp ${T}`, requirementId: req.id, assetIds: [a1, a2], manual: [] } as never)).id;
    const prep = (await Meet.createMeeting(db, WS1, ME, { title: `Kite visit ${T}`, start: future(-1), type: "site_visit", orgId: o.id, requirementId: req.id, assetIds: [a1, a2] })).id;
    await saveFeedback(db, WS1, ME, prep, a2, { interest: "rejected", explicit_rejection: true, location: "Too far from metro" });
    const fb = (await db.from("meeting_property_feedback").select("id").eq("prep_id", prep).eq("asset_id", a2).single()).data!.id;
    const r = await runFeedbackChain(db, WS1, fb);
    const st = (await db.from("shortlist_option").select("option_status").eq("id", opts[a2]).single()).data;
    const an = (await db.from("deal_analysis").select("current_version, asset_ids").eq("id", analysis).single()).data;
    const tasks = (await db.from("task").select("title").eq("linked_entity_id", req.id).eq("source", "workflow")).data as Row[];
    rec("W8", { run: r?.status, option: st.option_status, analysisVersion: an.current_version, assets: an.asset_ids.length, tasks: tasks.map((x) => x.title) });
    expect(st.option_status).toBe("rejected");
    expect(an.asset_ids).not.toContain(a2);
    expect(tasks.length).toBeGreaterThan(0);
  }, 60_000);

  it("W11 lease expiry → renewal chain: proposes (not creates) a renewal/relocation requirement; unknowns stay null; idempotent", async () => {
    const o = (await ins("organisation", { display_name: `Atlas Health ${T}` }));
    const asset = await ins("asset", { name: `Atlas Current ${T}`, specs: {} });
    const lease = await ins("lease", { tenant_org_id: o.id, asset_id: asset.id, area_sf: 15000, area_basis: "chargeable", rent_per_sf: 80, rent_basis: "chargeable", contractual_expiry: edate(today, 8), status: "active" });
    const r1 = await runLeaseChain(db, WS1, lease.id, { ai: noAi });
    const s1 = r1 ? Object.fromEntries(((await db.from("workflow_step").select("step_key, status, reason, output_refs").eq("run_id", r1.runId)).data as Row[]).map((s) => [s.step_key, s])) : {};
    const reqsBefore = (await db.from("requirement").select("id").eq("org_id", o.id)).data as Row[];
    const pid = s1.requirement?.output_refs?.[0]?.id;
    if (pid) await approveAndApply(db, pid);
    const r2 = await runLeaseChain(db, WS1, lease.id, { ai: noAi });
    const req = (await db.from("requirement").select("*").eq("org_id", o.id).maybeSingle()).data;
    const r3 = await runLeaseChain(db, WS1, lease.id, { ai: noAi });
    rec("W11", { run1: r1?.status, requirementStep: s1.requirement?.status, requirementsBeforeApproval: reqsBefore.length, run2: r2?.status, requirement: req ? { title: req.title, seats_target: req.seats_target, budget_max: req.budget_max } : null, run3: r3 });
    expect(r1?.status).toBe("waiting_approval");
    expect(reqsBefore).toHaveLength(0);
    expect(req?.seats_target ?? null).toBeNull();
    expect(r3).toBeNull();
  }, 120_000);

  it("W12 contact employment change: previous employer kept, opportunity stays with original company, review task, draft not sent", async () => {
    const oldOrg = await org("OldCo Systems"); const newOrg = await org("NewCo Cloud");
    const p = await person(`Kabir Shah ${T}`, oldOrg.id, `kabir@oldco-${T}.example`);
    const opp = await ins("opportunity", { org_id: oldOrg.id, name: `OldCo ${T} deal`, stage: "engaged" });
    await ins("interaction", { occurred_at: future(-30), channel: "meeting", direction: "outbound", subject: `Met Kabir ${T}` }).then(async (i) => ins("interaction_link", { interaction_id: i.id, entity_type: "person", entity_id: p.id }));
    for (const pr of await proposePersonMove(db, WS1, { personId: p.id, newOrgId: newOrg.id, title: "VP Workplace", reason: "LinkedIn update", actorUserId: ME } as never)) await approveAndApply(db, pr.id);
    const emps = (await db.from("employment").select("org_id, is_current").eq("person_id", p.id)).data as Row[];
    const emp = (await db.from("employment").select("id").eq("person_id", p.id).eq("org_id", newOrg.id).single()).data!.id;
    const evs = (await admin.from("event_outbox").select("id, event_type").eq("workspace_id", WS1).eq("subject_id", p.id).eq("event_type", "contact.employment_changed")).data as Row[];
    if (evs.length) await processEvents(db, WS1, { eventIds: evs.map((e) => e.id) } as never).catch(() => null);
    const r = await runEmployerChain(db, WS1, emp, { ai: noAi });
    const oppAfter = (await db.from("opportunity").select("org_id").eq("id", opp.id).single()).data;
    const tasks = (await db.from("task").select("title, source").eq("workspace_id", WS1).or(`linked_entity_id.eq.${p.id},title.ilike.%Kabir Shah ${T}%`)).data as Row[];
    const drafts = (await db.from("draft").select("state, marked_sent_at").eq("recipient_person_id", p.id)).data as Row[];
    rec("W12", { employments: emps, event: evs.length, chain: r?.status, oppOrgUnchanged: oppAfter.org_id === oldOrg.id, reviewTasks: tasks, drafts });
    expect(emps.find((e) => e.org_id === oldOrg.id)?.is_current).toBe(false);
    expect(emps.find((e) => e.org_id === newOrg.id)?.is_current).toBe(true);
    expect(oppAfter.org_id).toBe(oldOrg.id);
    expect(evs.length).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThan(0); // Orchestrator creates a review task
    expect(drafts.every((d) => !d.marked_sent_at)).toBe(true);
  }, 60_000);

  it("W13 daily plan at 08:00: one consolidated plan with calendar, tasks, priorities, signals, follow-ups, prep, transaction blockers, lease deadlines", async () => {
    const now = new Date("2033-04-05T02:30:00Z"); // 08:00 IST
    const r: any = await runDailyPlan(admin, WS1, ME, { now, ai: mockAi, notify: false });
    const plan = (await admin.from("orch_plan").select("sections").eq("workspace_id", WS1).eq("user_id", ME).eq("kind", "daily").eq("period_key", "2033-04-05").single()).data;
    const keys = Object.keys(plan?.sections ?? {});
    const states = Object.fromEntries(keys.map((k) => [k, plan.sections[k]?.state]));
    rec("W13", { aiStatus: r.aiStatus, sections: states });
    await admin.from("orch_plan").delete().eq("workspace_id", WS1).eq("user_id", ME).eq("period_key", "2033-04-05");
    for (const k of ["todays_meetings", "priority_accounts", "new_signals", "lease_alerts", "deals_attention", "pending_approvals", "recommended_actions"]) expect(keys).toContain(k);
    expect(keys.some((k) => /transaction|blocker/.test(k))).toBe(true); // W13 step 7: Transaction Execution blockers
    expect(keys.some((k) => /followup|outreach/.test(k))).toBe(true); // W13 step 5
  });

  it("W14 failed background process: classify, retry temporary safely, keep done steps, no duplicates, permanent → review with explanation; pause/resume", async () => {
    const key = `it.w14.${T}`; let calls = 0; let created = 0;
    registerWorkflow({ key, name: "W14", description: "test", module: "test", trigger: { type: "user" }, retry: { maxAttempts: 3, baseMs: 60_000, maxMs: 600_000 },
      steps: [
        { key: "write", label: "Write record", module: "brief", run: async (c) => {
          const idem = `w14:${T}`;
          const ex = (await c.db.from("task").select("id").eq("workspace_id", c.ws).eq("idempotency_key", idem)).data ?? [];
          if (!ex.length) { await c.db.from("task").insert({ workspace_id: c.ws, title: `W14 ${T}`, idempotency_key: idem, source: "workflow" }); created++; }
          return { status: "done", reason: "ok" };
        } },
        { key: "provider", label: "Research provider", module: "signals", dependsOn: ["write"], run: async () => { calls++; if (calls === 1) throw new TemporaryError("503 provider unavailable"); return { status: "done", reason: "ok" }; } },
      ] });
    const now = new Date();
    const r = await runWorkflow(db, WS1, key, { actor: ME, now });
    const x1 = await getExecution(db, WS1, r.id);
    const done = await advanceExecution(db, WS1, r.id, { now: new Date(+now + 10 * 60_000) });
    const tasks = (await db.from("task").select("id").eq("idempotency_key", `w14:${T}`)).data as Row[];
    const pkey = `it.w14p.${T}`;
    registerWorkflow({ key: pkey, name: "W14p", description: "test", module: "test", trigger: { type: "user" }, retry: { maxAttempts: 3, baseMs: 1000, maxMs: 1000 },
      steps: [{ key: "a", label: "Import", module: "imports", run: async () => { throw new PermanentError("schema mismatch in uploaded sheet"); } }] });
    const pr = await runWorkflow(db, WS1, pkey, { actor: ME });
    const px = await getExecution(db, WS1, pr.id);
    const paused = await pauseExecution(db, WS1, pr.id, ME).then(() => "ok", (e) => e.message);
    const resumed = await resumeExecution(db, WS1, pr.id, ME).then(() => "ok", (e) => e.message);
    const retried = await retryExecution(db, WS1, pr.id, ME).then(() => "ok", (e) => e.message);
    rec("W14", { first: r.status, failure: x1?.failure, final: done.status, providerCalls: calls, created, tasks: tasks.length, permanent: { status: px?.run.status, failure: px?.failure }, controls: { paused, resumed, retried } });
    expect(r.status).toBe("partially_completed");
    expect(x1?.failure?.willRetry).toBe(true);
    expect(done.status).toBe("completed");
    expect(created).toBe(1); expect(tasks).toHaveLength(1);
    expect(px?.run.status).toBe("failed");
    expect(px?.failure?.willRetry).toBe(false);
    expect(String(px?.failure?.userAction ?? "")).not.toBe("");
  });
});
