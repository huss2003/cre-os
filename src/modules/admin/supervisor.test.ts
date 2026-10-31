import { describe, it, expect } from "vitest";
import { backupCandidates, budgetCandidates, connectorCandidates, deadJobCandidates, gapCandidate, heartbeatState, SUPERVISOR } from "./supervisor";
import { latencyDrift } from "./health";
import { sampleRows, summariseRestore } from "./backup";

const now = new Date("2026-11-01T06:00:00Z");
const hAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

describe("supervisor rules (pure)", () => {
  it("retry exhaustion is surfaced: every dead job becomes a critical alert without leaking the error text", () => {
    const c = deadJobCandidates([{ id: "j1", job_type: "integrations.sync", state: "dead", attempts: 5, last_error: "token=SECRET" }, { id: "j2", state: "queued" }]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: "dead_job", subject: "j1", severity: "critical" });
    expect(JSON.stringify(c)).not.toContain("SECRET");
  });

  it("missed backup: no successful logical_export in 26 h => alert; a fresh workspace is not alerted", () => {
    expect(backupCandidates([], hAgo(2), now)).toEqual([]);
    expect(backupCandidates([], hAgo(30), now).map((c) => c.kind)).toEqual(["backup_missed"]);
    const ok = { id: "e1", kind: "logical_export", status: "succeeded", started_at: hAgo(27), finished_at: hAgo(27) };
    expect(backupCandidates([ok], hAgo(100), now).map((c) => c.kind)).toEqual(["backup_missed"]);
    const fresh = { ...ok, started_at: hAgo(3), finished_at: hAgo(3) };
    expect(backupCandidates([fresh], hAgo(100), now)).toEqual([]);
  });

  it("failed backups: latest export failed or stuck running, latest restore test failed", () => {
    const failed = { id: "e2", kind: "logical_export", status: "failed", started_at: hAgo(1) };
    const ok = { id: "e1", kind: "logical_export", status: "succeeded", started_at: hAgo(20), finished_at: hAgo(20) };
    expect(backupCandidates([failed, ok], hAgo(100), now).map((c) => [c.kind, c.subject])).toEqual([["backup_failed", "e2"]]);
    const stuck = { id: "e3", kind: "logical_export", status: "running", started_at: hAgo(3) };
    expect(backupCandidates([stuck, ok], hAgo(100), now).map((c) => c.subject)).toEqual(["e3"]);
    const rs = { id: "r1", kind: "restore_sample", status: "failed", started_at: hAgo(5) };
    expect(backupCandidates([rs, ok], hAgo(100), now).map((c) => c.kind)).toEqual(["restore_failed"]);
  });

  it("AI budget alerts at 80% (warning) and 100% (critical), keyed by month; no budget => none", () => {
    expect(budgetCandidates(2000, 3000, "2026-11-01T00:00:00.000Z")).toEqual([]);
    const w = budgetCandidates(2400, 3000, "2026-11-01T00:00:00.000Z");
    expect(w).toMatchObject([{ kind: "ai_budget_80", subject: "2026-11", severity: "warning" }]);
    expect(w[0].title).toContain("₹2,400 of ₹3,000");
    expect(budgetCandidates(3000, 3000, "2026-11-01T00:00:00.000Z")).toMatchObject([{ kind: "ai_budget_100", severity: "critical" }]);
    expect(budgetCandidates(10, 0, "2026-11-01T00:00:00.000Z")).toEqual([]);
  });

  it("connectors: expired/revoked/error accounts and failing cursors are critical, stale cursors are warnings", () => {
    const accounts = [
      { id: "a1", provider: "microsoft", status: "expired", created_at: hAgo(500) },
      { id: "a2", provider: "google", status: "connected", created_at: hAgo(500) },
    ];
    const cursors = [
      { connector_account_id: "a2", resource: "inbox", last_success_at: hAgo(2), last_attempt_at: hAgo(0.1), last_error: "401" },
      { connector_account_id: "a2", resource: "calendar", last_success_at: hAgo(40), last_attempt_at: hAgo(40), last_error: null },
      { connector_account_id: "a2", resource: "sent", last_success_at: hAgo(1), last_attempt_at: hAgo(1), last_error: null },
    ];
    const c = connectorCandidates(accounts, cursors, now);
    expect(c.map((x) => [x.kind, x.subject, x.severity])).toEqual([
      ["connector_failed", "a1", "critical"], ["connector_failed", "a2:inbox", "critical"], ["connector_stale", "a2:calendar", "warning"],
    ]);
    expect(JSON.stringify(c)).not.toContain("401");
  });

  it("heartbeat: stale after 15 min or when never seen; a gap > 15 min produces one alert keyed by the previous tick", () => {
    expect(heartbeatState(hAgo(0.1), now).stale).toBe(false);
    expect(heartbeatState(hAgo(0.3), now).stale).toBe(true);
    expect(heartbeatState(null, now)).toMatchObject({ stale: true, minutesSince: null });
    expect(gapCandidate({ gapMinutes: SUPERVISOR.heartbeatStaleMinutes, prevStartedAt: hAgo(0.25) })).toBeNull();
    expect(gapCandidate({ gapMinutes: null, prevStartedAt: null })).toBeNull();
    const g = gapCandidate({ gapMinutes: 1440, prevStartedAt: hAgo(24) });
    expect(g).toMatchObject({ kind: "scheduler_gap", subject: hAgo(24), severity: "critical" });
    expect(g!.title).toContain("24 h");
  });

  it("latency drift needs a real baseline and a > 2x, > 1 s slowdown", () => {
    expect(latencyDrift(5000, 1000, 10)).toBe(true);
    expect(latencyDrift(5000, 1000, 3)).toBe(false);
    expect(latencyDrift(1500, 600, 10)).toBe(false);
    expect(latencyDrift(null, 1000, 10)).toBe(false);
  });

  it("restore test helpers: spread sampling and failure classification", () => {
    expect(sampleRows([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(sampleRows(Array.from({ length: 10 }, (_, i) => i), 5)).toEqual([0, 2, 4, 6, 8]);
    const s = summariseRestore([
      { table: "a", rows_in: 2, rows_restored: 2, value_mismatch_rows: 0, duplicate_ids: 0, dropped_columns: [], restored_hash: "h" },
      { table: "b", rows_in: 1, error: "23502: null value in column" },
      { table: "c", rows_in: 3, rows_restored: 3, value_mismatch_rows: 1, value_mismatch_columns: ["rent"], duplicate_ids: 0, dropped_columns: ["old_col"] },
    ], ["d"], 1234);
    expect(s.problems.map((p) => p.table)).toEqual(["b", "c"]);
    expect(s.findings).toMatchObject({ tables_restored: 2, rows_restored: 5, dropped_columns: { c: ["old_col"] }, skipped_for_time: ["d"], hashes: { a: "h" } });
  });
});
