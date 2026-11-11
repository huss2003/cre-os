import { describe, expect, it } from "vitest";
import { groupSteps } from "./progress";

describe("run step grouping", () => {
  it("queued and waiting steps are not counted as in progress", () => {
    const g = groupSteps([{ status: "queued" }, { status: "queued" }, { status: "waiting_dependency" }, { status: "waiting_dependency" }, { status: "waiting_dependency" }], "paused");
    expect(g.current).toHaveLength(0);
    expect(g.remaining).toHaveLength(5);
  });
  it("every step is in exactly one bucket", () => {
    const steps = ["running", "queued", "done", "skipped", "failed", "dead", "waiting_approval"].map((status) => ({ status }));
    const g = groupSteps(steps, "running");
    expect(g.current.length + g.completed.length + g.failedSteps.length + g.remaining.length).toBe(steps.length);
    expect(g.current).toEqual([{ status: "running" }]);
  });
});
