// Spec §18 tests 3, 4, 5, 8 — reassessment driven by DB-trigger events (transactional outbox) → consumers → workflows.
// Local stack, seeded owner (RLS), tagged fixtures in WS1, mock AI. Only this file's events are processed.
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, adminClient, WS1, USERS, tag } from "../../../tests/helpers";
import { processEvents, getExecution, listMarks, publishEvent, listIntegrationHealth, isStale } from "./index";
import { runComparison } from "@/modules/toolkit/comparison";
import { approveAnalysis } from "@/modules/toolkit/store";
import { createMeeting, cancelMeeting } from "@/modules/meetings/service";
import { proposeChange } from "@/lib/services/changes";
import { approveAndApply } from "@/modules/changes/service";

type Db = Awaited<ReturnType<typeof userClient>>;
type Row = Record<string, any>;
const ME = USERS.owner.id;
const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString();
let db: Db;
beforeAll(async () => { db = await userClient("owner"); });

async function eventFor(type: string, subjectId: string) {
  const { data } = await db.from("event_outbox").select("id, dedupe_key, payload").eq("workspace_id", WS1).eq("event_type", type).eq("subject_id", subjectId).order("occurred_at", { ascending: false }).limit(1);
  expect(data?.length).toBe(1);
  return data![0] as Row;
}
async function runOf(eventId: string) {
  const { data } = await db.from("event_processing_log").select("run_id, status, consumer").eq("event_id", eventId);
  const r = (data ?? []).find((x: Row) => x.run_id);
  expect(r).toBeTruthy();
  return (await getExecution(db, WS1, r!.run_id))!;
}
const stepMap = (x: { steps: Row[] }) => Object.fromEntries(x.steps.map((s) => [s.step_key, s]));

async function dealFixture(t: string) {
  const org = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `Occupier ${t}` }).select("id").single()).data!.id as string;
  const req = (await db.from("requirement").insert({ workspace_id: WS1, org_id: org, title: `Req ${t}`, area_target_sf: 25000, area_basis: "chargeable", owner_user_id: ME }).select("id").single()).data!.id as string;
  const mk = async (n: string, rent: number) => {
    const a = (await db.from("asset").insert({ workspace_id: WS1, name: `${n} ${t}`, grade: "A", specs: {} }).select("id").single()).data!.id as string;
    const sp = (await db.from("space").insert({ workspace_id: WS1, asset_id: a, chargeable_sf: 30000 }).select("id").single()).data!.id as string;
    await db.from("availability").insert({ workspace_id: WS1, space_id: sp, as_of: new Date().toISOString().slice(0, 10), status: "available", asking_rent_min: rent, rent_basis: "chargeable", fact_status: "currently_confirmed" });
    return { a, sp };
  };
  const p1 = await mk("Alpha", 90); const p2 = await mk("Beta", 80);
  const draftCmp = (await runComparison(db, WS1, ME, { title: `Cmp draft ${t}`, requirementId: req, assetIds: [p1.a, p2.a], manual: [] })).id;
  const approvedCmp = (await runComparison(db, WS1, ME, { title: `Cmp approved ${t}`, requirementId: req, assetIds: [p1.a, p2.a], manual: [] })).id;
  await approveAnalysis(db, WS1, ME, approvedCmp);
  const proposal = (await db.from("deal_analysis").insert({ workspace_id: WS1, kind: "deliverable", title: `Proposal ${t}`, requirement_id: req, inputs: { analyses: [{ id: draftCmp, version: 1 }] }, outputs: {}, status: "ready", current_version: 1, owner_user_id: ME }).select("id").single()).data!.id as string;
  return { org, req, p1, p2, draftCmp, approvedCmp, proposal };
}

describe("Test 4 — new rent quotation", () => {
  it("identifies comparisons, recalculates via Module 8, preserves old versions, flags proposals, warns on approved", async () => {
    const t = tag("orch4"); const f = await dealFixture(t);
    const q1 = (await db.from("quote").insert({ workspace_id: WS1, space_id: f.p1.sp, requirement_id: f.req, version: 1, terms_json: { rent: 95, rent_basis: "chargeable" } }).select("id").single()).data!.id;
    const q2 = (await db.from("quote").insert({ workspace_id: WS1, space_id: f.p1.sp, requirement_id: f.req, version: 2, terms_json: { rent: 85, rent_basis: "chargeable" } }).select("id").single()).data!.id;
    await db.from("quote").update({ superseded_by: q2 }).eq("id", q1);
    const e1 = await eventFor("commercial.quote_received", q1); const e2 = await eventFor("commercial.quote_received", q2);
    await processEvents(db, WS1, { eventIds: [e1.id] });
    await processEvents(db, WS1, { eventIds: [e2.id] });
    const x = await runOf(e2.id);
    expect(x.run.status).toBe("completed");
    const s = stepMap(x);
    expect(s.identify.output.analyses.map((a: Row) => a.id)).toEqual(expect.arrayContaining([f.draftCmp, f.approvedCmp]));
    // Both quotes already existed when the first run recalculated, so the second run sees the same inputs and skips
    // (no piling versions); the first run did the recalculation.
    expect(stepMap(await runOf(e1.id)).recalculate.output.recalculated).toContain(f.draftCmp);
    expect(s.recalculate.output.unchanged).toContain(f.draftCmp);
    expect(s.recalculate.output.warned).toContain(f.approvedCmp);
    // Old versions preserved; draft comparison has a newer version; approved one untouched.
    const versions = ((await db.from("deal_analysis_version").select("version").eq("analysis_id", f.draftCmp)).data ?? []).map((v: Row) => v.version).sort();
    expect(versions[0]).toBe(1); expect(versions.length).toBe(2);
    const appr = (await db.from("deal_analysis").select("status, current_version").eq("id", f.approvedCmp).single()).data!;
    expect(appr).toEqual({ status: "approved", current_version: 1 });
    expect((await listMarks(db, WS1, { entityId: f.approvedCmp }))[0].mark).toBe("outdated_warning");
    expect((await isStale(db, WS1, "deal_analysis", f.proposal))?.mark).toBe("needs_refresh");
    // Old quote kept.
    expect((await db.from("quote").select("id").in("id", [q1, q2])).data).toHaveLength(2);
    expect(s.warn.status).toBe("done");
    expect((await db.from("outbox").select("id").eq("workspace_id", WS1).eq("dedupe_key", `orch:evt:${e2.id}:reassess.quote:warn`)).data).toHaveLength(1);
  }, 60_000);
});

describe("Test 5 — requirement change 25,000 → 30,000 SF", () => {
  it("through approval; comparisons identified, scores reassessed, history kept, user notified", async () => {
    const t = tag("orch5"); const f = await dealFixture(t);
    const p = await proposeChange(db, WS1, { targetType: "requirement", targetId: f.req, patch: [{ op: "replace", path: "/area_target_sf", value: 30000 }], reason: `Client said 30k ${t}`, idempotencyKey: `orch5:${t}` });
    await approveAndApply(db, (p as Row).id ?? (p as Row).proposal_id ?? p, {});
    expect((await db.from("requirement").select("area_target_sf").eq("id", f.req).single()).data!.area_target_sf).toBe(30000);
    const e = await eventFor("commercial.requirement_changed", f.req);
    expect(e.payload.changed.area_target_sf).toEqual([25000, 30000]);
    await processEvents(db, WS1, { eventIds: [e.id] });
    const x = await runOf(e.id); const s = stepMap(x);
    expect(x.run.status).toBe("completed");
    expect(s.identify.output.analyses.map((a: Row) => a.id)).toEqual(expect.arrayContaining([f.draftCmp, f.approvedCmp]));
    expect(s.recalculate.output.recalculated).toContain(f.draftCmp);
    expect(s.rescore.status).toBe("done");
    expect(s.flag_proposals.output.flagged).toBeGreaterThanOrEqual(1);
    expect(s.notify.status).toBe("done");
    expect((await db.from("outbox").select("user_id").eq("workspace_id", WS1).eq("dedupe_key", `orch:evt:${e.id}:reassess.requirement:notify`).single()).data!.user_id).toBe(ME);
    // One grouped notice per requirement, in plain words; a second change updates it (count 2) instead of adding a row.
    const open = async () => (await db.from("notification_state").select("title, body, group_count").eq("workspace_id", WS1).eq("group_key", `reassess:requirement:${f.req}`).is("group_parent", null).eq("status", "pending")).data ?? [];
    expect((await open())[0].body).toContain("Target area 25,000 → 30,000 sq ft");
    const p2 = await proposeChange(db, WS1, { targetType: "requirement", targetId: f.req, patch: [{ op: "replace", path: "/area_target_sf", value: 32000 }], reason: `Client said 32k ${t}`, idempotencyKey: `orch5b:${t}` });
    await approveAndApply(db, (p2 as Row).id ?? (p2 as Row).proposal_id ?? p2, {});
    const e2 = await eventFor("commercial.requirement_changed", f.req);
    await processEvents(db, WS1, { eventIds: [e2.id] });
    const g = await open();
    expect(g).toHaveLength(1);
    expect(g[0].group_count).toBe(2);
    expect(g[0].body).toContain("30,000 → 32,000 sq ft");
    expect(g[0].body).not.toContain("area_target_sf");
    // Historical value accessible in the audit trail.
    const hist = (await db.from("audit_event").select("before").eq("workspace_id", WS1).eq("entity_type", "requirement").eq("entity_id", f.req).eq("action", "update")).data ?? [];
    expect(hist.some((h: Row) => Number(h.before?.area_target_sf) === 25000)).toBe(true);
  }, 60_000);
});

describe("Test 3 — cancelled meeting", () => {
  it("cancels reminders and queued jobs; keeps meeting history and unrelated commitments", async () => {
    const t = tag("orch3");
    const org = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `Meetco ${t}` }).select("id").single()).data!.id;
    const prep = (await createMeeting(db, WS1, ME, { title: `Pitch ${t}`, start: future(2), orgId: org })).id as string;
    const mv = (await db.from("meeting_prep").select("meeting_visit_id").eq("id", prep).single()).data!.meeting_visit_id as string;
    const ins = async (title: string, key: string, link: string | null) => (await db.from("task").insert({ workspace_id: WS1, title, idempotency_key: key, linked_entity_type: link ? "meeting_prep" : null, linked_entity_id: link, source: "meeting", owner_user_id: ME }).select("id").single()).data!.id as string;
    const reminder = await ins(`Prepare for "Pitch ${t}"`, `meeting-remind:${prep}:x`, prep);
    const commitment = await ins(`Send floor plans ${t}`, `meeting:${prep}:1`, prep);
    const unrelated = await ins(`Unrelated ${t}`, `orch3-unrelated:${t}`, null);
    const admin = adminClient();
    const job = (await admin.from("job").insert({ workspace_id: WS1, job_type: "meetings.brief", payload: { prepId: prep }, due_at: future(1), dedupe_key: `orch3:${t}` }).select("id").single()).data!.id;
    await cancelMeeting(db, WS1, prep);
    const e = await eventFor("meeting.cancelled", mv);
    // As in production: the orchestrator.dispatch job processes events with the service-role client (S2, explicit ws).
    await processEvents(admin, WS1, { eventIds: [e.id] });
    const x = await runOf(e.id);
    expect(x.run.status).toBe("completed");
    const st = async (id: string) => (await db.from("task").select("status").eq("id", id).single()).data!.status;
    expect(await st(reminder)).toBe("cancelled");
    expect(await st(commitment)).toBe("open");
    expect(await st(unrelated)).toBe("open");
    expect((await admin.from("job").select("state").eq("id", job).single()).data!.state).toBe("cancelled");
    expect((await db.from("meeting_visit").select("status").eq("id", mv).single()).data!.status).toBe("cancelled");
    expect((await db.from("meeting_prep").select("id").eq("id", prep)).data).toHaveLength(1);
    expect(stepMap(x).commitments.status).toBe("done"); // one commitment remains → user told
  }, 60_000);
});

describe("Test 8 — contact employment change", () => {
  it("history preserved, opportunities not moved, review triggered once", async () => {
    const t = tag("orch8");
    const oldOrg = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `OldCo ${t}` }).select("id").single()).data!.id;
    const newOrg = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `NewCo ${t}` }).select("id").single()).data!.id;
    const person = (await db.from("person").insert({ workspace_id: WS1, full_name: `Asha Rao ${t}` }).select("id").single()).data!.id;
    const oldEmp = (await db.from("employment").insert({ workspace_id: WS1, person_id: person, org_id: oldOrg, title: "Admin head", is_current: true }).select("id").single()).data!.id;
    const req = (await db.from("requirement").insert({ workspace_id: WS1, org_id: oldOrg, title: `Req ${t}` }).select("id").single()).data!.id;
    const sh = (await db.from("stakeholder").insert({ workspace_id: WS1, requirement_id: req, person_id: person, employment_id: oldEmp, role: "approver" }).select("id").single()).data!.id;
    const opp = (await db.from("opportunity").insert({ workspace_id: WS1, org_id: oldOrg, name: `Opp ${t}`, requirement_id: req }).select("id").single()).data!.id;
    await db.from("employment").update({ is_current: false }).eq("id", oldEmp);
    const newEmp = (await db.from("employment").insert({ workspace_id: WS1, person_id: person, org_id: newOrg, title: "VP Admin", is_current: true }).select("id").single()).data!.id;
    const e = await eventFor("contact.employment_changed", person);
    expect(e.payload.employment_id).toBe(newEmp);
    await processEvents(db, WS1, { eventIds: [e.id] });
    await processEvents(db, WS1, { eventIds: [e.id] });
    const x = await runOf(e.id);
    expect(x.run.status).toBe("completed");
    expect((await db.from("employment").select("id").eq("person_id", person)).data).toHaveLength(2);
    expect((await db.from("opportunity").select("org_id").eq("id", opp).single()).data!.org_id).toBe(oldOrg);
    expect((await isStale(db, WS1, "opportunity", opp))?.mark).toBe("review");
    expect((await isStale(db, WS1, "stakeholder", sh))?.mark).toBe("review");
    expect((await db.from("task").select("id").eq("workspace_id", WS1).eq("idempotency_key", `orch:employment:${newEmp}:review`)).data).toHaveLength(1);
  }, 60_000);
});

describe("Source outage (§7 ex.5)", () => {
  it("records failure, keeps last success, marks dependents stale, resolves on recovery", async () => {
    const t = tag("orch-src"); const source = `test-source:${t}`; const subject = crypto.randomUUID();
    const ok = await publishEvent(db, WS1, { type: "integration.recovered", payload: { source }, dedupeKey: `${t}:ok` });
    await processEvents(db, WS1, { eventIds: [ok.id] });
    const ev = await publishEvent(db, WS1, { type: "integration.failed", subjectType: "connector_account", subjectId: subject, payload: { source, error: "503 unavailable", important: true }, dedupeKey: `${t}:f1` });
    await processEvents(db, WS1, { eventIds: [ev.id] });
    const h = (await listIntegrationHealth(db, WS1)).find((r) => r.source_key === source)!;
    expect(h.status).toBe("degraded"); expect(h.last_success_at).toBeTruthy(); expect(h.next_retry_at).toBeTruthy();
    expect((await isStale(db, WS1, "connector_account", subject))?.mark).toBe("stale");
    const back = await publishEvent(db, WS1, { type: "integration.recovered", payload: { source }, dedupeKey: `${t}:ok2` });
    await processEvents(db, WS1, { eventIds: [back.id] });
    expect(await isStale(db, WS1, "connector_account", subject)).toBeNull();
  });
});
