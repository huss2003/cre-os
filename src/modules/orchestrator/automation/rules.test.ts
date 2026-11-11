import { describe, expect, it } from "vitest";
import { buildAlerts, categoryUsage, delayReason, dispatchOrder, isDelayedJob, isPausableJob, overviewCounts, routedStatus } from "./rules";

const NOW = new Date("2026-11-11T10:00:00Z");
const ago = (m: number) => new Date(+NOW - m * 60_000).toISOString();

describe("global pause — which jobs wait (§2.13)", () => {
  it("holds back background automation but never user-initiated or critical work", () => {
    for (const t of ["signals.scan", "intelligence.research", "contacts.reverify", "scoring.bulk", "workflows.sweep", "orchestrator.weekly_review"]) expect(isPausableJob(t)).toBe(true);
    for (const t of ["capture.process", "capture.document", "imports.process", "assistant.command", "meetings.remind", "meetings.autobrief", "orchestrator.daily_plan", "orchestrator.dispatch", "admin.export", "brief.pre_meeting"]) expect(isPausableJob(t)).toBe(false);
    expect(isPausableJob("intelligence.research", { userInitiated: true })).toBe(false);
    expect(isPausableJob("scoring.bulk", { trigger: "user" })).toBe(false);
  });
});

describe("delayed work (§2.7, §2.11)", () => {
  it("flags retry backoff, long queue and long dependency waits; not paused/finished runs", () => {
    expect(delayReason({ status: "partially_completed", next_attempt_at: new Date(+NOW + 60_000).toISOString(), started_at: ago(5) }, NOW)).toMatch(/retry/);
    expect(delayReason({ status: "queued", started_at: ago(45) }, NOW)).toMatch(/Queued/);
    expect(delayReason({ status: "queued", started_at: ago(5) }, NOW)).toBeNull();
    expect(delayReason({ status: "waiting_dependency", started_at: ago(180) }, NOW)).toMatch(/required information/);
    expect(delayReason({ status: "paused", started_at: ago(900) }, NOW)).toBeNull();
    expect(delayReason({ status: "completed", started_at: ago(900) }, NOW)).toBeNull();
    expect(isDelayedJob({ state: "queued", due_at: ago(20), attempts: 0 }, NOW)).toBe(true);
    expect(isDelayedJob({ state: "queued", due_at: ago(2), attempts: 0 }, NOW)).toBe(false);
    expect(isDelayedJob({ state: "succeeded", due_at: ago(200), attempts: 1 }, NOW)).toBe(false);
  });
});

describe("priority — urgent client work first (rule 9, §2.7 reprioritise)", () => {
  it("runs urgent/user work first and holds routine background runs while urgent work waits", () => {
    const runs = [
      { id: "bg", priority: 30, trigger_type: "schedule", started_at: ago(60) },
      { id: "normal", priority: 50, trigger_type: "event", started_at: ago(30) },
      { id: "client", priority: 80, trigger_type: "event", started_at: ago(1) },
      { id: "user", priority: 20, trigger_type: "user", started_at: ago(2) },
    ];
    const o = dispatchOrder(runs);
    expect(o.run.map((r) => r.id)).toEqual(["client", "user", "normal"]);
    expect(o.held.map((r) => r.id)).toEqual(["bg"]);
    expect(dispatchOrder(runs.filter((r) => r.id === "bg" || r.id === "normal")).run.map((r) => r.id)).toEqual(["normal", "bg"]);
  });
});

describe("overview counts + alerts (UI A, E)", () => {
  const runs = [
    { status: "completed", started_at: ago(10) }, { status: "done", started_at: ago(10) }, { status: "failed", started_at: ago(10) },
    { status: "running", started_at: ago(1) }, { status: "queued", started_at: ago(60) }, { status: "waiting_approval", started_at: ago(5) },
    { status: "partially_completed", started_at: ago(5), next_attempt_at: new Date(+NOW + 600_000).toISOString(), error: "503" },
  ];
  it("counts total/active/scheduled/completed/failed/delayed/attention", () => {
    expect(overviewCounts(runs, 4, NOW)).toEqual({ total: 7, active: 3, scheduled: 4, completed: 2, failed: 1, delayed: 2, attention: 2 });
  });
  it("lists alerts most serious first and covers every category", () => {
    const a = buildAlerts({
      paused: true, failedRuns: [{ name: "Reassess quote" }], delayedRuns: [{ name: "Weekly" }], unhealthy: [{ label: "Gmail", status: "down", last_success_at: null }],
      marks: [{ mark: "stale" }, { mark: "needs_refresh" }], budgets: [{ status: "near", budget: { resource: "research", unit: "usd" }, used: 8, limit: 10 }],
      pendingProposals: 2, waitingApproval: 1, infoChanges: [{ title: "New quote affects comparison", body: "x", href: "/deals" }], routedFailed: 1,
    });
    expect(a.map((x) => x.kind)).toEqual(["paused", "outage", "failed", "failed", "budget", "attention", "delayed", "stale", "stale", "info_change"]);
    expect(buildAlerts({ paused: false, failedRuns: [], delayedRuns: [], unhealthy: [], marks: [], budgets: [], pendingProposals: 0, waitingApproval: 0, infoChanges: [] })).toEqual([]);
  });
});

describe("budget categories (UI F)", () => {
  it("always shows research, enrichment, transcription and AI with limit / used / remaining", () => {
    const c = categoryUsage([{ status: "near", budget: { resource: "research", unit: "usd", period: "monthly" }, used: 8, limit: 10, pct: 80 }], { model_tokens: { used: 1.5, unit: "usd" } });
    expect(c.map((x) => x.resource)).toEqual(["research", "enrichment", "transcription", "model_tokens"]);
    expect(c[0]).toMatchObject({ limit: 10, used: 8, remaining: 2, status: "near" });
    expect(c[3]).toMatchObject({ limit: null, used: 1.5, remaining: null, status: "no_limit" });
  });
});

describe("routed work tracking (§2.4)", () => {
  it("maps the receiving module's run to completed / failed / running; none after 2 h = delayed", () => {
    expect(routedStatus({ status: "done" }, ago(5), NOW)).toBe("completed");
    expect(routedStatus({ status: "failed" }, ago(5), NOW)).toBe("failed");
    expect(routedStatus({ status: "running" }, ago(5), NOW)).toBe("running");
    expect(routedStatus(null, ago(30), NOW)).toBe("pending");
    expect(routedStatus(null, ago(180), NOW)).toBe("delayed");
  });
});
