// Feature-audit gaps (docs/orchestrator/FEATURE-AUDIT.md): global pause/resume, job guard, dispatcher honouring the pause
// and priorities, routed-work tracking, delayed / failure notifications, workflow history, new-record events.
// Pause tests use WS2 (owner = "other") and always resume in `finally`.
import { afterAll, describe, expect, it } from "vitest";
import { adminClient, tag, userClient, USERS, WS1, WS2 } from "../../../../tests/helpers";
import { registerWorkflow, startExecution, runWorkflow, cancelExecution, publishEvent, processEvents, registerConsumer, PermanentError } from "../index";
import { dispatch } from "../jobs";
import { guardHandlers } from "../budget/service";
import { getAutomationState, listHistory, notifyDelayed, notifyFailures, setAutomationPaused, trackRouted } from "./service";

type Row = Record<string, any>;
const admin = adminClient() as any;
const T = tag("orchaut");
const jobIds: string[] = [];
afterAll(async () => {
  for (const id of jobIds) await admin.from("job").delete().eq("workspace_id", WS2).or(`id.eq.${id},payload->>_automationDeferredFrom.eq.${id}`);
  await admin.from("automation_control").update({ paused: false }).eq("workspace_id", WS2);
});

describe("global pause / resume (§2.13, UI A)", () => {
  it("only editors+ of the workspace can pause; state is shown as active/paused", async () => {
    const col = await userClient("colleague");
    await expect(setAutomationPaused(col, WS2, USERS.colleague.id, true)).rejects.toThrow();
    const other = await userClient("other");
    expect((await getAutomationState(other, WS2)).paused).toBe(false);
  });

  it("defers pausable background jobs (once), runs critical/user jobs, releases them on resume without duplicates", async () => {
    const other = await userClient("other");
    const calls: string[] = [];
    const h = guardHandlers({ "signals.scan": async () => { calls.push("scan"); return "ok"; }, "capture.process": async () => { calls.push("capture"); return "ok"; } }, () => admin, () => null);
    const job = { id: crypto.randomUUID(), workspace_id: WS2, job_type: "signals.scan", payload: { t: T }, attempts: 0, due_at: new Date().toISOString(), dedupe_key: null };
    jobIds.push(job.id);
    try {
      const p = await setAutomationPaused(other, WS2, USERS.other.id, true, "test");
      expect(p.changed).toBe(true);
      expect((await getAutomationState(other, WS2)).paused).toBe(true);
      expect(await h["signals.scan"](job)).toMatchObject({ paused: "automation_paused" });
      expect(await h["signals.scan"](job)).toMatchObject({ paused: "automation_paused" });
      expect(await h["signals.scan"]({ ...job, id: crypto.randomUUID(), payload: { userInitiated: true } })).toBe("ok");
      expect(await h["capture.process"]({ ...job, job_type: "capture.process" })).toBe("ok");
      expect(calls).toEqual(["scan", "capture"]);
      const deferred = (await admin.from("job").select("id, due_at, state").eq("workspace_id", WS2).eq("payload->>_automationDeferredFrom", job.id)).data as Row[];
      expect(deferred).toHaveLength(1);
      expect(Date.parse(deferred[0].due_at)).toBeGreaterThan(Date.now() + 20 * 60_000);
    } finally {
      const r = await setAutomationPaused(other, WS2, USERS.other.id, false);
      expect(r.changed).toBe(true);
      expect(r.released).toBeGreaterThanOrEqual(1);
    }
    const after = (await admin.from("job").select("id, due_at").eq("workspace_id", WS2).eq("payload->>_automationDeferredFrom", job.id)).data as Row[];
    expect(after).toHaveLength(1);
    expect(Date.parse(after[0].due_at)).toBeLessThanOrEqual(Date.now() + 5_000);
    await admin.from("job").update({ state: "cancelled" }).eq("id", after[0].id); // keep the real runner from picking it up
    expect((await admin.from("workflow_audit_log").select("action").eq("workspace_id", WS2).in("action", ["automation_paused", "automation_resumed"]).gte("occurred_at", new Date(Date.now() - 120_000).toISOString())).data!.length).toBeGreaterThanOrEqual(2);
  });

  it("dispatcher: while paused events wait and only user-started runs advance; resume continues without duplicates", async () => {
    const other = await userClient("other");
    let consumed = 0;
    registerConsumer(`test.pause.${T}`, "count", async () => { consumed++; return { status: "done", detail: "ok" }; });
    for (const k of ["user", "auto"]) registerWorkflow({ key: `test.${k}.${T}`, name: `T ${k}`, description: "test", module: "test", trigger: { type: k === "user" ? "user" : "event" }, steps: [{ key: "a", label: "A", module: "test", run: async () => ({ status: "done", reason: "ok" }) }] });
    const ev = await publishEvent(admin, WS2, { type: `test.pause.${T}` as never, subjectType: "test", dedupeKey: `${T}:ev` });
    const userRun = await startExecution(admin, WS2, `test.user.${T}`, { trigger: "user", dedupeKey: `${T}:u` });
    const autoRun = await startExecution(admin, WS2, `test.auto.${T}`, { trigger: "event", dedupeKey: `${T}:a` });
    try {
      await setAutomationPaused(other, WS2, USERS.other.id, true);
      const d = await dispatch(WS2, new Date(), Date.now() + 60_000, admin);
      expect(d.paused).toBe(true);
      expect(consumed).toBe(0);
      expect((await admin.from("event_outbox").select("status").eq("id", ev.id).single()).data.status).toBe("pending");
      expect((await admin.from("workflow_run").select("status").eq("id", userRun.id).single()).data.status).toBe("completed");
      expect((await admin.from("workflow_run").select("status").eq("id", autoRun.id).single()).data.status).toBe("queued");
    } finally { await setAutomationPaused(other, WS2, USERS.other.id, false); }
    await dispatch(WS2, new Date(), Date.now() + 60_000, admin);
    expect(consumed).toBe(1);
    expect((await admin.from("workflow_run").select("status").eq("id", autoRun.id).single()).data.status).toBe("completed");
    await dispatch(WS2, new Date(), Date.now() + 60_000, admin);
    expect(consumed).toBe(1);
    expect((await admin.from("workflow_step").select("id").eq("run_id", autoRun.id)).data).toHaveLength(1);
  });
});

describe("routed work, delays, failures, history", () => {
  it("tracks whether the receiving module completed routed work (required → delayed, optional → untracked)", async () => {
    const meeting = await publishEvent(admin, WS1, { type: "meeting.completed", subjectType: "meeting_visit", subjectId: crypto.randomUUID(), dedupeKey: `${T}:mc` });
    const signal = await publishEvent(admin, WS1, { type: "research.signal_detected", subjectType: "organisation", subjectId: crypto.randomUUID(), dedupeKey: `${T}:sig` });
    await processEvents(admin, WS1, { eventIds: [meeting.id, signal.id] });
    const logs = async () => Object.fromEntries(((await admin.from("event_processing_log").select("event_id, status, routed_kind, routed_status").in("event_id", [meeting.id, signal.id])).data as Row[]).map((l) => [l.event_id, l]));
    let l = await logs();
    expect(l[meeting.id]).toMatchObject({ status: "routed", routed_kind: "meeting_chain", routed_status: "pending" });
    expect(l[signal.id]).toMatchObject({ status: "routed", routed_kind: "signal_chain", routed_status: "pending" });
    await trackRouted(admin, WS1, new Date(Date.now() + 3 * 3600_000));
    l = await logs();
    expect(l[meeting.id].routed_status).toBe("delayed");
    expect(l[signal.id].routed_status).toBe("untracked");
  });

  it("notifies once about a delayed run and once about a run that cannot recover", async () => {
    registerWorkflow({ key: `test.slow.${T}`, name: "Slow", description: "test", module: "test", trigger: { type: "event" }, steps: [{ key: "a", label: "A", module: "test", run: async () => ({ status: "done", reason: "ok" }) }] });
    registerWorkflow({ key: `test.broken.${T}`, name: "Broken", description: "test", module: "test", trigger: { type: "user" }, steps: [
      { key: "ok", label: "Fetch", module: "test", run: async () => ({ status: "done", reason: "ok" }) },
      { key: "bad", label: "Save", module: "test", dependsOn: ["ok"], run: async () => { throw new PermanentError("validation failed"); } },
    ] });
    const slow = await startExecution(admin, WS1, `test.slow.${T}`, { trigger: "event", dedupeKey: `${T}:slow`, now: new Date(Date.now() - 2 * 3600_000) });
    const broken = await runWorkflow(admin, WS1, `test.broken.${T}`, { trigger: "user", dedupeKey: `${T}:broken` });
    expect(broken.status).toBe("partially_completed"); // Fetch kept, Save failed permanently — no retry scheduled
    try {
      await notifyDelayed(admin, WS1); await notifyDelayed(admin, WS1);
      await notifyFailures(admin, WS1); await notifyFailures(admin, WS1);
      const owner = USERS.owner.id;
      expect((await admin.from("outbox").select("id").eq("workspace_id", WS1).eq("dedupe_key", `orch:delayed:${slow.id}:${owner}`)).data).toHaveLength(1);
      expect((await admin.from("outbox").select("id").eq("workspace_id", WS1).eq("dedupe_key", `orch:wf_failed:${broken.id}:${owner}`)).data).toHaveLength(1);
      const h = (await listHistory(admin, WS1, { status: "partially_completed", limit: 50 })).find((r) => r.id === broken.id)!;
      expect(h).toMatchObject({ trigger: "Started by a person", executed: ["Fetch"], failed: ["Save"] });
      expect(h.errors[0]).toMatch(/validation failed/);
      // (the slow run itself may be claimed by a parallel test's dispatcher, so only check the filter's contract)
      expect((await listHistory(admin, WS1, { status: "delayed", limit: 200 })).every((r) => typeof r.delayed === "string")).toBe(true);
    } finally {
      await cancelExecution(admin, WS1, slow.id);
      await admin.from("outbox").delete().eq("workspace_id", WS1).in("dedupe_key", [`orch:delayed:${slow.id}:${USERS.owner.id}`, `orch:wf_failed:${broken.id}:${USERS.owner.id}`]);
    }
  });
});

describe("new records / lease details trigger dependent workflows (rule 5, §2.5)", () => {
  it("lease change → event → re-score tenant; unrelated column change emits nothing", async () => {
    const db = await userClient("owner");
    const org = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `Tenant ${T}` }).select("id").single()).data!;
    const lease = (await db.from("lease").insert({ workspace_id: WS1, tenant_org_id: org.id, area_sf: 10000, rent_per_sf: 90 }).select("id, row_version").single()).data!;
    const created = (await admin.from("event_outbox").select("id, event_type").eq("workspace_id", WS1).in("subject_id", [org.id, lease.id])).data as Row[];
    expect(created.map((e) => e.event_type).sort()).toEqual(["company.created", "lease.created"]);
    await db.from("lease").update({ registration_ref: `R-${T}` }).eq("id", lease.id);
    // Material lease fields change through approved change proposals (S4 guard) — applied here with the service role.
    await admin.from("lease").update({ rent_per_sf: 95 }).eq("id", lease.id);
    const changed = (await admin.from("event_outbox").select("id, payload").eq("workspace_id", WS1).eq("subject_id", lease.id).eq("event_type", "lease.changed")).data as Row[];
    expect(changed).toHaveLength(1);
    expect(changed[0].payload.changed.rent_per_sf).toEqual([90, 95]);
    await processEvents(db, WS1, { eventIds: changed.map((e) => e.id) });
    const { data: run } = await db.from("workflow_run").select("id, status").eq("workspace_id", WS1).eq("definition_key", "reassess.record_changed").eq("subject_id", lease.id).single();
    expect(run!.status).toBe("completed");
    const steps = Object.fromEntries(((await db.from("workflow_step").select("step_key, status, reason").eq("run_id", run!.id)).data as Row[]).map((s) => [s.step_key, s]));
    expect(steps.identify.status).toBe("done");
    expect(steps.rescore.status).toBe("done");
    expect(steps.flag).toMatchObject({ status: "skipped" });
    const routed = (await db.from("event_processing_log").select("consumer, status, routed_kind").eq("event_id", changed[0].id)).data as Row[];
    expect(routed.find((r) => r.consumer === "renewal")).toMatchObject({ status: "routed", routed_kind: "lease_chain" });
  });

  it("new contact detail → event; person with no current employer → workflow skips (no unnecessary work)", async () => {
    const db = await userClient("owner");
    const p = (await db.from("person").insert({ workspace_id: WS1, full_name: `Contact ${T}` }).select("id").single()).data!;
    await db.from("contact_method").insert({ workspace_id: WS1, person_id: p.id, method_type: "email", value: `${T}@example.com` });
    const evs = (await admin.from("event_outbox").select("id, event_type").eq("workspace_id", WS1).eq("subject_id", p.id)).data as Row[];
    expect(evs.map((e) => e.event_type).sort()).toEqual(["contact.created", "contact.info_added"]);
    await processEvents(db, WS1, { eventIds: evs.map((e) => e.id) });
    const runs = (await db.from("workflow_run").select("id, status").eq("workspace_id", WS1).eq("definition_key", "reassess.record_changed").eq("subject_id", p.id)).data as Row[];
    expect(runs).toHaveLength(1); // both events within 10 min → one run
    const st = (await db.from("workflow_step").select("step_key, status").eq("run_id", runs[0].id)).data as Row[];
    expect(st.every((s) => s.status === "skipped")).toBe(true);
  });
});
