import { describe, it, expect } from "vitest";
import { classifyError, backoffMs, planWaves, readySteps, deriveStatus, TemporaryError, PermanentError, type StepRow } from "./engine/plan";

const row = (k: string, status: StepRow["status"], deps: string[] = [], extra: Partial<StepRow> = {}): StepRow =>
  ({ step_key: k, status, depends_on: deps, error_class: null, attempts: 0, max_attempts: 3, next_attempt_at: null, ...extra });

describe("orchestrator pure rules", () => {
  it("classifies temporary vs permanent errors", () => {
    expect(classifyError(new TemporaryError("x"))).toBe("temporary");
    expect(classifyError(new PermanentError("timeout"))).toBe("permanent");
    expect(classifyError(new Error("fetch failed: ECONNRESET"))).toBe("temporary");
    expect(classifyError({ status: 503, message: "x" })).toBe("temporary");
    expect(classifyError({ status: 429 })).toBe("temporary");
    expect(classifyError({ status: 400, message: "bad" })).toBe("permanent");
    expect(classifyError(new Error("Quote not found."))).toBe("permanent");
  });
  it("exponential backoff with cap", () => {
    const c = { baseMs: 1000, maxMs: 5000 };
    expect([1, 2, 3, 4, 5].map((a) => backoffMs(a, c))).toEqual([1000, 2000, 4000, 5000, 5000]);
  });
  it("dependency waves; cycles and unknown deps rejected", () => {
    expect(planWaves([{ key: "a" }, { key: "b", dependsOn: ["a"] }, { key: "c", dependsOn: ["a"] }, { key: "d", dependsOn: ["b", "c"] }])).toEqual([["a"], ["b", "c"], ["d"]]);
    expect(() => planWaves([{ key: "a", dependsOn: ["b"] }, { key: "b", dependsOn: ["a"] }])).toThrow(/cycle/);
    expect(() => planWaves([{ key: "a", dependsOn: ["zz"] }])).toThrow(/unknown/);
  });
  it("ready steps respect prerequisites and backoff", () => {
    const now = new Date("2026-11-11T10:00:00Z");
    const rows = [row("a", "done"), row("b", "failed", ["a"], { error_class: "temporary", next_attempt_at: "2026-11-11T10:05:00Z" }), row("c", "waiting_dependency", ["b"]), row("d", "queued", ["a"])];
    expect(readySteps(rows, now).map((r) => r.step_key)).toEqual(["d"]);
    expect(readySteps(rows, new Date("2026-11-11T10:06:00Z")).map((r) => r.step_key)).toEqual(["b", "d"]);
  });
  it("derives execution status", () => {
    expect(deriveStatus([row("a", "done"), row("b", "skipped")]).status).toBe("completed");
    expect(deriveStatus([row("a", "done"), row("b", "failed", [], { error_class: "permanent" }), row("c", "waiting_dependency", ["b"])]).status).toBe("partially_completed");
    expect(deriveStatus([row("a", "failed", [], { error_class: "permanent" })]).status).toBe("failed");
    expect(deriveStatus([row("a", "done"), row("b", "waiting_approval")]).status).toBe("waiting_approval");
  });
});
