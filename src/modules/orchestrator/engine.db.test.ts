// Spec §18 tests 6, 10, 11, 12 (+ pause/cancel of an execution). Local stack, seeded owner (RLS), tagged fixtures.
import { describe, it, expect, beforeAll } from "vitest";
import { adminClient, userClient, WS1, USERS, tag } from "../../../tests/helpers";
import {
  registerWorkflow, startExecution, advanceExecution, runWorkflow, retryExecution, pauseExecution, resumeExecution, cancelExecution,
  getExecution, startDueScheduled, setWorkflowStatus, publishEvent, processEvents, registerConsumer, TemporaryError, PermanentError, getWorkflow,
} from "./index";

type Db = Awaited<ReturnType<typeof userClient>>;
type Row = Record<string, any>;
const ME = USERS.owner.id;
const steps = async (db: Db, runId: string): Promise<Record<string, Row>> => Object.fromEntries(((await db.from("workflow_step").select("*").eq("run_id", runId)).data ?? []).map((s: Row) => [s.step_key, s]));
const auditActions = async (db: Db, runId: string) => ((await db.from("workflow_audit_log").select("action").eq("run_id", runId).order("id")).data ?? []).map((a: Row) => a.action);

let db: Db;
beforeAll(async () => { db = await userClient("owner"); });

describe("Test 6 — temporary provider failure", () => {
  it("records failure, retries with backoff, keeps earlier steps, no duplicate signals", async () => {
    const t = tag("orch6"); const calls = { search: 0, news: 0 };
    const orgId = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `Research ${t}` }).select("id").single()).data!.id;
    registerWorkflow({
      key: `test.research.${t}`, name: "Research", description: "test", module: "test", trigger: { type: "user" }, retry: { maxAttempts: 3, baseMs: 60_000, maxMs: 600_000 },
      steps: [
        { key: "company_search", label: "Company search", module: "signals", run: async (c) => {
          calls.search++;
          const url = `https://example.com/${t}`;
          const ex = (await c.db.from("signal_claim").select("id").eq("workspace_id", c.ws).eq("source_url", url)).data ?? [];
          if (!ex.length) await c.db.from("signal_claim").insert({ workspace_id: c.ws, subject_type: "organisation", subject_id: orgId, claim_type: "expansion", source_url: url });
          return { status: "done", reason: "found", refs: [{ type: "organisation", id: orgId }] };
        } },
        { key: "news", label: "News retrieval", module: "signals", dependsOn: ["company_search"], run: async () => {
          calls.news++;
          if (calls.news === 1) throw new TemporaryError("503 research provider unavailable");
          return { status: "done", reason: "news ok" };
        } },
        { key: "enrich", label: "Contact enrichment", module: "contacts", dependsOn: ["news"], run: async () => ({ status: "done", reason: "ok" }) },
        { key: "score", label: "Scoring", module: "scoring", dependsOn: ["enrich"], run: async () => ({ status: "done", reason: "ok" }) },
      ],
    });
    const now = new Date();
    const r = await runWorkflow(db, WS1, `test.research.${t}`, { actor: ME, now });
    expect(r.status).toBe("partially_completed");
    let s = await steps(db, r.id);
    expect(s.company_search.status).toBe("done");
    expect(s.news.status).toBe("failed"); expect(s.news.error_class).toBe("temporary"); expect(s.news.error).toMatch(/503/);
    expect(Date.parse(s.news.next_attempt_at)).toBeGreaterThan(+now);
    expect(s.enrich.status).toBe("waiting_dependency");
    const x = await getExecution(db, WS1, r.id);
    expect(x!.failure!.willRetry).toBe(true); expect(x!.failure!.earlierStepsSucceeded).toContain("Company search");
    // Before backoff elapses: nothing re-runs.
    await advanceExecution(db, WS1, r.id, { now });
    expect(calls.news).toBe(1);
    // After backoff: resumes at the failed step only.
    const done = await advanceExecution(db, WS1, r.id, { now: new Date(+now + 5 * 60_000) });
    expect(done.status).toBe("completed");
    s = await steps(db, r.id);
    expect(s.news.attempts).toBe(2);
    expect(calls.search).toBe(1);
    expect((await db.from("signal_claim").select("id").eq("workspace_id", WS1).eq("source_url", `https://example.com/${t}`)).data).toHaveLength(1);
    expect(await auditActions(db, r.id)).toContain("retry_scheduled");
  });

  it("exhausted retries go to the dead letter; permanent errors are not retried", async () => {
    const t = tag("orch6b"); let n = 0;
    registerWorkflow({ key: `test.dead.${t}`, name: "Dead", description: "test", module: "test", trigger: { type: "user" }, retry: { maxAttempts: 2, baseMs: 1000, maxMs: 1000 },
      steps: [{ key: "a", label: "Flaky", module: "x", run: async () => { n++; throw new Error("ETIMEDOUT"); } }] });
    const now = new Date();
    const r = await runWorkflow(db, WS1, `test.dead.${t}`, { now });
    await advanceExecution(db, WS1, r.id, { now: new Date(+now + 5000) });
    const s = await steps(db, r.id);
    expect(n).toBe(2); expect(s.a.status).toBe("dead");
    expect((await getExecution(db, WS1, r.id))!.run.status).toBe("failed");
    expect(await auditActions(db, r.id)).toContain("dead_letter");
  });
});

describe("Test 10 — duplicate event", () => {
  it("one event, one execution, one downstream action; duplicate recorded", async () => {
    const t = tag("orch10"); const type = `test.dup.${t}`; const key = `test.dupwf.${t}`; const idem = `orch-test:${t}`;
    registerWorkflow({ key, name: "Dup", description: "test", module: "test", trigger: { type: "event", events: [type] },
      steps: [{ key: "task", label: "Create task", module: "brief", run: async (c) => {
        const ex = (await c.db.from("task").select("id").eq("workspace_id", c.ws).eq("idempotency_key", idem)).data ?? [];
        if (!ex.length) await c.db.from("task").insert({ workspace_id: c.ws, title: `Follow up ${t}`, idempotency_key: idem, source: "workflow" });
        return { status: "done", reason: "task" };
      } }] });
    registerConsumer(type, "test", async (d, ws, e) => { const r = await runWorkflow(d, ws, key, { dedupeKey: `evt:${e.dedupe_key}`, trigger: "event" }); return { status: "done", detail: r.status, runId: r.id }; });
    const a = await publishEvent(db, WS1, { type, subjectType: "test", dedupeKey: `dup:${t}` });
    const b = await publishEvent(db, WS1, { type, subjectType: "test", dedupeKey: `dup:${t}` });
    expect(a.duplicate).toBe(false); expect(b.duplicate).toBe(true); expect(b.id).toBe(a.id);
    await processEvents(db, WS1, { eventIds: [a.id] });
    await processEvents(db, WS1, { eventIds: [a.id] });
    const ev = (await db.from("event_outbox").select("status, duplicate_count").eq("id", a.id).single()).data!;
    expect(ev.status).toBe("processed"); expect(ev.duplicate_count).toBe(1);
    expect((await db.from("event_processing_log").select("id").eq("event_id", a.id)).data).toHaveLength(1);
    expect((await db.from("workflow_run").select("id").eq("workspace_id", WS1).eq("definition_key", key)).data).toHaveLength(1);
    expect((await db.from("task").select("id").eq("workspace_id", WS1).eq("idempotency_key", idem)).data).toHaveLength(1);
    // Direct duplicate trigger is recorded safely.
    const again = await startExecution(db, WS1, key, { dedupeKey: `evt:dup:${t}` });
    expect(again.duplicate).toBe(true);
    expect(await auditActions(db, again.id)).toContain("duplicate_trigger");
  });
});

describe("Test 11 — partial failure", () => {
  it("keeps successful steps, identifies the failed one, resumes from it, partial until resolved", async () => {
    const t = tag("orch11"); const calls: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 }; let broken = true;
    const step = (k: string, deps: string[] = []) => ({ key: k, label: `Step ${k}`, module: "test", dependsOn: deps, run: async () => {
      calls[k]++;
      if (k === "b" && broken) throw new PermanentError("Required input missing");
      return { status: "done" as const, reason: "ok", refs: [{ type: "test", id: crypto.randomUUID(), label: k }] };
    } });
    registerWorkflow({ key: `test.partial.${t}`, name: "Partial", description: "test", module: "test", trigger: { type: "user" }, steps: [step("a"), step("b", ["a"]), step("c", ["b"]), step("d", ["a"])] });
    const r = await runWorkflow(db, WS1, `test.partial.${t}`, { actor: ME });
    expect(r.status).toBe("partially_completed");
    let s = await steps(db, r.id);
    expect(s.a.status).toBe("done"); expect(s.d.status).toBe("done"); // independent step ran in parallel wave
    expect(s.b.status).toBe("failed"); expect(s.b.error_class).toBe("permanent"); expect(s.c.status).toBe("waiting_dependency");
    const x = await getExecution(db, WS1, r.id);
    expect(x!.failure!.whatFailed[0].step).toBe("Step b"); expect(x!.failure!.willRetry).toBe(false);
    broken = false;
    await retryExecution(db, WS1, r.id, ME);
    const fin = await advanceExecution(db, WS1, r.id);
    expect(fin.status).toBe("completed");
    expect(calls).toEqual({ a: 1, b: 2, c: 1, d: 1 });
    s = await steps(db, r.id);
    expect(Object.values(s).every((v: Row) => v.status === "done")).toBe(true);
  });
});

describe("Test 12 — pause and resume a recurring workflow", () => {
  it("no new execution while paused; history kept; scheduling resumes", async () => {
    const t = tag("orch12"); const key = `test.recurring.${t}`;
    registerWorkflow({ key, name: "Recurring", description: "test", module: "test", trigger: { type: "schedule", everyMinutes: 60 }, steps: [{ key: "a", label: "A", module: "x", run: async () => ({ status: "done", reason: "ok" }) }] });
    const t0 = new Date();
    const first = await startDueScheduled(db, WS1, t0);
    const mine = async () => ((await db.from("workflow_run").select("id").eq("workspace_id", WS1).eq("definition_key", key)).data ?? []).length;
    expect(await mine()).toBe(1);
    expect(first.length).toBeGreaterThanOrEqual(1);
    await setWorkflowStatus(db, WS1, key, "paused", ME, t0);
    await startDueScheduled(db, WS1, new Date(+t0 + 2 * 3600e3));
    expect(await mine()).toBe(1);
    const resumeAt = new Date(+t0 + 3 * 3600e3);
    await setWorkflowStatus(db, WS1, key, "active", ME, resumeAt);
    await startDueScheduled(db, WS1, resumeAt);
    expect(await mine()).toBe(2);
    await startDueScheduled(db, WS1, new Date(+resumeAt + 10 * 60e3)); // not yet due again
    expect(await mine()).toBe(2);
    const wf = await getWorkflow(db, WS1, key);
    expect(wf.versions.map((v: Row) => v.note)).toEqual(expect.arrayContaining(["paused", "activated", "created"]));
    // Cleanup: the second run is dated 3 h ahead; left behind it would crowd "newest runs" lists in other tests.
    await adminClient().from("workflow_run").delete().eq("workspace_id", WS1).eq("definition_key", key);
    await setWorkflowStatus(db, WS1, key, "paused", ME);
  });

  it("execution pause / resume / cancel", async () => {
    const t = tag("orch12b"); let ran = 0;
    registerWorkflow({ key: `test.ctl.${t}`, name: "Ctl", description: "test", module: "test", trigger: { type: "user" },
      steps: [{ key: "a", label: "A", module: "x", run: async () => { ran++; return { status: "done", reason: "ok" }; } }, { key: "b", label: "B", module: "x", dependsOn: ["a"], run: async () => { ran++; return { status: "done", reason: "ok" }; } }] });
    const s = await startExecution(db, WS1, `test.ctl.${t}`, { actor: ME });
    await pauseExecution(db, WS1, s.id, ME);
    expect((await advanceExecution(db, WS1, s.id)).status).toBe("paused");
    expect(ran).toBe(0);
    await resumeExecution(db, WS1, s.id, ME);
    expect((await advanceExecution(db, WS1, s.id)).status).toBe("completed");
    expect(ran).toBe(2);
    const c = await startExecution(db, WS1, `test.ctl.${t}`, { actor: ME });
    await cancelExecution(db, WS1, c.id, ME);
    expect((await advanceExecution(db, WS1, c.id)).status).toBe("cancelled");
    expect(Object.values(await steps(db, c.id)).every((v: Row) => v.status === "cancelled")).toBe(true);
    expect(await auditActions(db, c.id)).toEqual(expect.arrayContaining(["started", "cancelled"]));
  });
});
