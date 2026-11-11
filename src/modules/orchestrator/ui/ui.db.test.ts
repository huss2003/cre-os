// Automation UI service (backs pages, server actions and /api/v1/orchestrator/** routes) + assistant orchestrator tools.
// Local stack, seeded users (RLS), tagged fixtures.
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { userClient, WS1, USERS, tag } from "../../../../tests/helpers";
import { registerWorkflow, startExecution, markEntity, getExecution, PermanentError } from "../index";
import { AutomationError, dateForRequest, loadAttention, loadDashboard, loadRun, loadWorkflow, markControl, runControl, startableWorkflows, startWorkflow, workflowControl, workflowForRequest, type Actor } from "./service";
import { PREPARE_MEETINGS } from "./workflows";
import { triggerText, everyText } from "./labels";
import { workflowBody, runBody, markBody, startBody } from "./http";
import { getTool } from "@/modules/assistant/tools";
import { classifyIntent } from "@/modules/assistant/engine/router";
import { selectTools } from "@/modules/assistant/tools/select";
import type { ToolContext } from "@/modules/assistant/types";

type Row = Record<string, any>;
let owner: Actor, colleague: Actor;
const T = tag("orchui");
const tomorrow = dateForRequest("tomorrow", "Asia/Kolkata");

beforeAll(async () => {
  owner = { db: (await userClient("owner")) as never, ws: WS1, userId: USERS.owner.id, role: "owner", timezone: "Asia/Kolkata" };
  colleague = { db: (await userClient("colleague")) as never, ws: WS1, userId: USERS.colleague.id, role: "editor", timezone: "Asia/Kolkata" };
  registerWorkflow({ key: `test.ui.fail.${T}`, name: "UI fail", description: "test", module: "test", trigger: { type: "user" }, retry: { maxAttempts: 1, baseMs: 1000, maxMs: 1000 },
    steps: [{ key: "a", label: "Step A", module: "x", run: async () => ({ status: "done", reason: "ok" }) }, { key: "b", label: "Step B", module: "x", dependsOn: ["a"], run: async () => { throw new PermanentError("boom permanent"); } }] });
  registerWorkflow({ key: `test.ui.sched.${T}`, name: "UI sched", description: "test", module: "test", trigger: { type: "schedule", everyMinutes: 60 }, steps: [{ key: "a", label: "A", module: "x", run: async () => ({ status: "done", reason: "ok" }) }] });
});

describe("labels", () => {
  it("describe triggers in plain words", () => {
    expect(triggerText({ type: "event", events: ["commercial.quote_received"] })).toBe("Runs when a new rent quotation arrives");
    expect(triggerText({ type: "schedule", everyMinutes: 1440 })).toBe("Runs every day");
    expect(everyText(120)).toBe("every 2 hours");
  });
});

describe("route body schemas", () => {
  it("validate control bodies", () => {
    expect(workflowBody.safeParse({ action: "priority", priority: 101 }).success).toBe(false);
    expect(runBody.safeParse({ action: "cancel" }).success).toBe(true);
    expect(markBody.safeParse({ action: "delete" }).success).toBe(false);
    expect(startBody.safeParse({}).success).toBe(false);
  });
});

describe("controls", () => {
  it("workflow pause/resume/schedule/priority are admin-only and versioned", async () => {
    const key = `test.ui.sched.${T}`;
    await expect(workflowControl(colleague, key, { action: "pause" })).rejects.toMatchObject({ status: 403 });
    expect((await workflowControl(owner, key, { action: "pause" }) as Row).state.status).toBe("paused");
    expect((await workflowControl(owner, key, { action: "resume" }) as Row).state.status).toBe("active");
    expect((await workflowControl(owner, key, { action: "schedule", everyMinutes: 120 }) as Row).state.every_minutes).toBe(120);
    await expect(workflowControl(owner, key, { action: "schedule", everyMinutes: 1 })).rejects.toBeInstanceOf(AutomationError);
    expect((await workflowControl(owner, key, { action: "priority", priority: 90 }) as Row).state.priority).toBe(90);
    await expect(workflowControl(owner, key, { action: "start" })).rejects.toMatchObject({ status: 400 });
    const w = await loadWorkflow(owner, key);
    expect(w.versions.length).toBeGreaterThanOrEqual(4);
    await expect(loadWorkflow(owner, "nope.nope")).rejects.toMatchObject({ status: 404 });
  });

  it("failed run: failure report, retry keeps done steps, cancel needs admin", async () => {
    const r = await startWorkflow(owner, `test.ui.fail.${T}`);
    const run = await loadRun(owner, r.runId);
    expect(run!.failure?.whatFailed[0].step).toBe("Step B");
    expect(run!.failure?.earlierStepsSucceeded).toContain("Step A");
    expect(run!.completed.map((s: Row) => s.step_key)).toEqual(["a"]);
    const att = await loadAttention(owner);
    expect(att.some((a) => a.href === `/automation/runs/${r.runId}`)).toBe(true);
    await runControl(owner, r.runId, { action: "retry" });
    const x = await getExecution(owner.db, WS1, r.runId);
    expect(x!.steps.find((s) => s.step_key === "a")!.attempts).toBe(1);
    const q = await startExecution(colleague.db, WS1, `test.ui.fail.${T}`, { actor: colleague.userId });
    await expect(runControl(colleague, q.id, { action: "cancel" })).rejects.toMatchObject({ status: 403 });
    expect((await runControl(colleague, q.id, { action: "pause" })).run.status).toBe("paused");
    await expect(runControl(owner, randomUUID(), { action: "pause" })).rejects.toMatchObject({ status: 404 });
  });

  it("dashboard groups runs and lists scheduled workflows", async () => {
    const d = await loadDashboard(owner);
    expect(d.scheduled.some((s) => s.key === `test.ui.sched.${T}`)).toBe(true);
    expect(d.failed.length).toBeGreaterThan(0);
    expect(d.budgets.ok).toBe(true);
  });
});

describe("refresh banner", () => {
  it("refresh on a requirement mark runs the refresh workflow; dismiss closes", async () => {
    const org = (await owner.db.from("organisation").insert({ workspace_id: WS1, display_name: `Org ${T}` }).select("id").single()).data!;
    const req = (await owner.db.from("requirement").insert({ workspace_id: WS1, org_id: org.id, title: `Req ${T}` }).select("id").single()).data!;
    const id = await markEntity(owner.db, WS1, { entityType: "requirement", entityId: req.id, mark: "needs_refresh", reason: "test", dedupeKey: `ui:${T}:1` });
    const r = await markControl(owner, id!, { action: "refresh" });
    expect(r.runId).toBeTruthy();
    expect(r.state).toBe("resolved"); // client scores recalculated → warning cleared
    expect((await loadRun(owner, r.runId!))!.steps.every((st: Row) => st.status === "done")).toBe(true);
    const id2 = await markEntity(owner.db, WS1, { entityType: "requirement", entityId: req.id, mark: "review", reason: "test2", dedupeKey: `ui:${T}:2` });
    expect((await markControl(owner, id2!, { action: "dismiss" })).state).toBe("dismissed");
  });
});

describe("assistant", () => {
  let t: ToolContext;
  beforeAll(() => {
    t = { ctx: { db: owner.db, userId: owner.userId, email: USERS.owner.email, workspaceId: WS1, workspaceName: "WS1", timezone: "Asia/Kolkata", role: "owner", allowedClassifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"], isPlatformAdmin: false, workspaces: [] },
      runId: randomUUID(), conversationId: null, focus: null };
  });
  const req = "prepare tomorrow's meetings and list pending client commitments";

  it("routes the example request to the automation intent and tools", () => {
    expect(classifyIntent(req)).toBe("automation");
    expect(workflowForRequest(req)).toBe(PREPARE_MEETINGS);
    expect(selectTools({ intent: "automation", request: req, available: ["start_workflow", "get_commitments"] }).ids).toContain("start_workflow");
    expect(startableWorkflows({ role: "viewer" }).length).toBe(0);
  });

  it("start_workflow runs prepare-meetings once per assistant run and reports results", async () => {
    const vis = (await owner.db.from("meeting_visit").insert({ workspace_id: WS1, title: `Mtg ${T}`, start_at: `${tomorrow}T05:00:00Z`, end_at: `${tomorrow}T06:00:00Z` }).select("id").single()).data!;
    const tool = getTool("start_workflow")!;
    const a = await tool.run(tool.input.parse({ request: req }), t);
    expect(a.ok).toBe(true);
    const data = a.data as Row;
    expect(data.date).toBe(tomorrow);
    expect(data.steps.length).toBe(3);
    const b = await tool.run(tool.input.parse({ request: req }), t);
    expect((b.data as Row).runId).toBe(data.runId);
    expect((b.data as Row).duplicate).toBe(true);
    const ex = await getExecution(owner.db, WS1, data.runId);
    expect(JSON.stringify(ex!.steps.find((s) => s.step_key === "meetings")!.output)).toContain(vis.id);

    const list = await getTool("list_workflow_runs")!.run({ status: "all" } as never, t);
    expect((list.data as Row).runs.some((r: Row) => r.runId === data.runId)).toBe(true);
    const got = await getTool("get_workflow_run")!.run({ runId: data.runId } as never, t);
    expect(got.ok).toBe(true);
    const appr = await getTool("list_pending_approvals")!.run({} as never, t);
    expect(appr.ok).toBe(true);
    const none = await tool.run(tool.input.parse({ request: "sing a song please" }), t);
    expect(none.ok).toBe(false);
  });

  it("cancel_workflow_run is category C with a plan; pause works", async () => {
    const cancel = getTool("cancel_workflow_run")!;
    expect(cancel.category).toBe("C");
    const q = await startExecution(owner.db, WS1, `test.ui.fail.${T}`, { actor: owner.userId });
    const plan = await cancel.plan!({ runId: q.id } as never, t);
    expect(plan.diff[0].after).toBe("Cancelled");
    expect((await getTool("pause_workflow_run")!.run({ runId: q.id } as never, t)).ok).toBe(true);
    expect((await cancel.run({ runId: q.id } as never, t)).ok).toBe(true);
  });
});
