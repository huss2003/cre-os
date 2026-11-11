/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { z } from "zod";
import { listExecutions, getExecution, definition } from "@/modules/orchestrator";
import {
  AutomationError, dateForRequest, runControl, startWorkflow, startableWorkflows, workflowForRequest, type Actor,
} from "@/modules/orchestrator/ui/service";
import { RUN_STATUS, STEP_STATUS } from "@/modules/orchestrator/ui/labels";
import type { ApprovalPlan, Block, ToolContext } from "../types";
import { db, defineTool, failed, ws, type Row } from "./shared";

/**
 * Module 12 ↔ orchestrator: start an authorised background workflow from a request, list/inspect runs, pause, cancel
 * (category C), and show what is waiting for approval. Everything runs through the orchestrator service with the
 * user's RLS client and role checks; nothing is sent (S3).
 */
const actor = (t: ToolContext): Actor => ({ db: t.ctx.db, ws: ws(t), userId: t.ctx.userId, role: t.ctx.role, timezone: t.ctx.timezone });
const runHref = (id: string) => `/automation/runs/${id}`;
const nameOf = (key: string | null, fallback?: string | null) => { try { return definition(key ?? "").name; } catch { return fallback ?? key ?? "Background job"; } };
const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
const err = (e: unknown, what: string) => (e instanceof AutomationError ? { ok: false, summary: `${what}: ${e.message}`, error: e.message } : failed(what, e));

async function runReport(t: ToolContext, runId: string) {
  const x = await getExecution(db(t), ws(t), runId);
  if (!x || x.run.kind !== "orchestrated") return null;
  const steps = x.steps.map((s: Row) => ({ step: s.label, status: STEP_STATUS[s.status]?.label ?? s.status, result: s.reason ?? null, error: s.error ?? null, output: s.output ?? null }));
  const blocks: Block[] = [
    { kind: "status", done: x.steps.filter((s: Row) => s.status === "done" || s.status === "skipped").map((s: Row) => `${s.label}: ${s.reason ?? "done"}`),
      pending: x.steps.filter((s: Row) => ["queued", "running", "waiting_dependency", "waiting_approval"].includes(s.status)).map((s: Row) => s.label),
      blocked: x.steps.filter((s: Row) => s.status === "failed" || s.status === "dead" || s.status === "cancelled").map((s: Row) => `${s.label}: ${s.error ?? STEP_STATUS[s.status]?.label ?? s.status}`) },
  ];
  // Results the user asked for (meeting list, commitments) as tasks blocks.
  const out = Object.fromEntries(x.steps.map((s: Row) => [s.step_key, s.output ?? {}]));
  if (out.meetings?.meetings?.length) blocks.push({ kind: "tasks", title: "Meetings", items: (out.meetings.meetings as Row[]).map((m) => ({ title: `${m.title}${m.hasBrief || (out.prepare?.prepared ?? []).includes(m.prepId) ? " — brief ready" : m.prepId ? " — no brief yet" : " — no preparation record"}`, due: m.startAt, href: m.prepId ? `/meetings/${m.prepId}` : "/meetings" })) });
  if (out.commitments?.items?.length) blocks.push({ kind: "tasks", title: "Open commitments", items: (out.commitments.items as Row[]).map((c) => ({ title: `${c.title}${c.overdue ? " (overdue)" : ""}`, due: c.due, href: "/tasks" })) });
  blocks.push({ kind: "download", label: "Open the run", href: runHref(runId) });
  return {
    data: { runId, workflow: nameOf(x.run.definition_key, x.run.summary), status: RUN_STATUS[x.run.status]?.label ?? x.run.status, progress: x.run.progress, steps, failure: x.failure, href: runHref(runId) },
    blocks, summary: `${nameOf(x.run.definition_key, x.run.summary)}: ${RUN_STATUS[x.run.status]?.label ?? x.run.status} (${x.run.progress ?? 0}%)`,
  };
}

const startWorkflowTool = defineTool({
  id: "start_workflow", module: "assistant", category: "B", minRole: "member",
  description: "Start an authorised background workflow from the user's request and report its result — e.g. \"prepare tomorrow's meetings and list pending client commitments\" (finds the day's meetings, prepares missing briefs, lists open commitments). Pass the user's words as request; optional date YYYY-MM-DD (default tomorrow). Only user-startable workflows the user's role allows can run; nothing is sent.",
  input: z.object({
    request: z.string().min(3).max(1000).describe("The user's request in their words"),
    workflowKey: z.string().max(120).optional().describe("Exact workflow key if known (from list_workflow_runs)"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Day the workflow is about (default: tomorrow)"),
  }),
  async run(i, t) {
    try {
      const a = actor(t);
      const key = i.workflowKey ?? workflowForRequest(i.request);
      const allowed = startableWorkflows(a);
      if (!key || !allowed.some((w) => w.key === key)) {
        return { ok: false, summary: "No background workflow fits this request.", error: "no_matching_workflow", data: { available: allowed.map((w) => ({ key: w.key, name: w.name, description: w.description })) } };
      }
      const tz = t.ctx.timezone || "Asia/Kolkata";
      const date = i.date ?? dateForRequest(i.request, tz);
      // One execution per assistant run + workflow + date: a repeated tool call returns the same run (no duplicate briefs).
      const r = await startWorkflow(a, key, { date, tz, generateBriefs: true }, `assistant:${t.runId}:${key}:${date}`);
      const rep = await runReport(t, r.runId);
      if (!rep) return { ok: false, summary: "The workflow started but could not be read back.", error: "not_found_or_no_access" };
      return { ok: true, summary: `${r.duplicate ? "Already started — " : ""}${rep.summary}`, data: { ...rep.data, date, duplicate: r.duplicate }, blocks: rep.blocks };
    } catch (e) { return err(e, "Could not start the workflow"); }
  },
});

const listRuns = defineTool({
  id: "list_workflow_runs", module: "assistant", category: "A",
  description: "List background jobs (workflow runs): running, waiting for approval, paused, failed or finished, newest first. Use for 'what is running?', 'did anything fail?'. Also lists workflows the user can start.",
  input: z.object({
    status: z.enum(["active", "failed", "waiting_approval", "paused", "completed", "all"]).optional().describe("Default active (running/waiting/paused)"),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  async run(i, t) {
    try {
      const map: Record<string, string[] | undefined> = { active: ["queued", "running", "waiting_dependency", "waiting_approval", "partially_completed", "paused"], failed: ["failed"], waiting_approval: ["waiting_approval"], paused: ["paused"], completed: ["completed", "done"], all: undefined };
      const runs = await listExecutions(db(t), ws(t), { status: map[i.status ?? "active"] as never, limit: i.limit ?? 10 });
      const items = runs.map((r) => ({ runId: r.id, workflow: nameOf(r.definition_key, r.summary), status: RUN_STATUS[r.status]?.label ?? r.status, progress: r.progress, startedAt: r.started_at, error: r.error ?? null, href: runHref(r.id) }));
      return {
        ok: true, summary: `${items.length} job(s)${i.status && i.status !== "all" ? ` (${i.status.replace("_", " ")})` : ""}`,
        data: { runs: items, canStart: startableWorkflows(actor(t)).map((w) => ({ key: w.key, name: w.name })) },
        blocks: items.length ? [{ kind: "table", title: "Background jobs", columns: ["Job", "Status", "Progress", "Started"], rows: items.map((r) => [r.workflow, r.status, `${r.progress ?? 0}%`, r.startedAt]) }] : [],
      };
    } catch (e) { return failed("Could not list background jobs", e); }
  },
});

const getRun = defineTool({
  id: "get_workflow_run", module: "assistant", category: "A",
  description: "Progress and results of one background job: each step's status and result, what failed and what to do, link to the run.",
  input: z.object({ runId: z.string().describe("Run id from list_workflow_runs or start_workflow") }),
  async run(i, t) {
    if (!isUuid(i.runId)) return { ok: false, summary: "Run not found.", error: "not_found_or_no_access" };
    try {
      const rep = await runReport(t, i.runId);
      if (!rep) return { ok: false, summary: "Run not found or you don't have access.", error: "not_found_or_no_access" };
      return { ok: true, summary: rep.summary, data: rep.data, blocks: rep.blocks };
    } catch (e) { return failed("Could not read the run", e); }
  },
});

const pauseRun = defineTool({
  id: "pause_workflow_run", module: "assistant", category: "B", minRole: "member",
  description: "Pause or resume a running background job. Finished steps keep their results.",
  input: z.object({ runId: z.string(), resume: z.boolean().optional().describe("true = resume a paused job") }),
  async run(i, t) {
    if (!isUuid(i.runId)) return { ok: false, summary: "Run not found.", error: "not_found_or_no_access" };
    try {
      const r = await runControl(actor(t), i.runId, { action: i.resume ? "resume" : "pause" });
      return { ok: true, summary: `${i.resume ? "Resumed" : "Paused"} (${RUN_STATUS[r.run.status]?.label ?? r.run.status})`, data: { runId: i.runId, status: r.run.status, href: runHref(i.runId) } };
    } catch (e) { return err(e, i.resume ? "Could not resume" : "Could not pause"); }
  },
});

const cancelRun = defineTool({
  id: "cancel_workflow_run", module: "assistant", category: "C", minRole: "admin",
  description: "Cancel a background job. Needs the user's approval. Steps not yet run are cancelled; finished steps and their results are kept.",
  input: z.object({ runId: z.string(), reason: z.string().min(3).max(300).optional() }),
  async plan(i, t): Promise<ApprovalPlan> {
    const x = isUuid(i.runId) ? await getExecution(db(t), ws(t), i.runId) : null;
    if (!x || x.run.kind !== "orchestrated") return { title: "Cancel background job", explanation: "Run not found or you don't have access — nothing would change.", affected: [], diff: [] };
    const left = x.steps.filter((s: Row) => !["done", "skipped", "cancelled"].includes(s.status)).map((s: Row) => s.label);
    return {
      title: `Cancel "${nameOf(x.run.definition_key, x.run.summary)}"`,
      explanation: `${i.reason ? `${i.reason}. ` : ""}${left.length ? `Not yet done: ${left.join(", ")}.` : "All steps already finished."} Finished steps are kept.`,
      affected: [], diff: [{ field: "status", before: RUN_STATUS[x.run.status]?.label ?? x.run.status, after: "Cancelled" }],
    };
  },
  async run(i, t) {
    if (!isUuid(i.runId)) return { ok: false, summary: "Run not found.", error: "not_found_or_no_access" };
    try {
      const r = await runControl(actor(t), i.runId, { action: "cancel" });
      return { ok: true, summary: "Cancelled — finished steps are kept.", data: { runId: i.runId, status: r.run.status, href: runHref(i.runId) } };
    } catch (e) { return err(e, "Could not cancel"); }
  },
});

const pendingApprovals = defineTool({
  id: "list_pending_approvals", module: "assistant", category: "A",
  description: "What is waiting for the user's approval: record changes in Review, background jobs paused for approval, and outdated approved proposals that need a decision.",
  input: z.object({ limit: z.number().int().min(1).max(25).optional() }),
  async run(i, t) {
    try {
      const lim = i.limit ?? 10;
      const [props, runs, marks] = await Promise.all([
        db(t).from("change_proposal").select("id, target_type, reason, risk, created_at", { count: "exact" }).eq("workspace_id", ws(t)).eq("state", "proposed").order("created_at", { ascending: false }).limit(lim),
        listExecutions(db(t), ws(t), { status: "waiting_approval", limit: lim }),
        db(t).from("reassessment_mark").select("id, entity_type, reason", { count: "exact" }).eq("workspace_id", ws(t)).eq("state", "open").eq("mark", "outdated_warning").limit(lim),
      ]);
      const changes = ((props.data ?? []) as Row[]).map((p) => ({ id: p.id, record: p.target_type, reason: p.reason, risk: p.risk, href: "/approvals" }));
      const jobs = runs.map((r) => ({ runId: r.id, workflow: nameOf(r.definition_key, r.summary), href: runHref(r.id) }));
      const outdated = ((marks.data ?? []) as Row[]).map((m) => ({ id: m.id, reason: m.reason, href: "/approvals/outdated" }));
      const total = (props.count ?? changes.length) + jobs.length + (marks.count ?? outdated.length);
      return {
        ok: true, summary: total ? `${props.count ?? changes.length} change(s) to review, ${jobs.length} job(s) waiting, ${marks.count ?? outdated.length} outdated approved output(s)` : "Nothing is waiting for approval",
        data: { changes, jobs, outdated, counts: { changes: props.count ?? changes.length, jobs: jobs.length, outdated: marks.count ?? outdated.length } },
        blocks: total ? [{ kind: "tasks", title: "Waiting for you", items: [
          ...changes.map((c) => ({ title: `Review change to ${c.record}: ${c.reason ?? "no reason given"}`, href: c.href })),
          ...jobs.map((j) => ({ title: `Approve or cancel: ${j.workflow}`, href: j.href })),
          ...outdated.map((o) => ({ title: o.reason, href: o.href })),
        ] }] : [],
      };
    } catch (e) { return failed("Could not load approvals", e); }
  },
});

export const orchestratorTools = [startWorkflowTool, listRuns, getRun, pauseRun, cancelRun, pendingApprovals];
