import { describe, expect, it } from "vitest";
import { backlogMessage } from "./backlog";

describe("job backlog message", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  it("is silent when nothing is overdue or the probe failed", () => {
    expect(backlogMessage(null, now)).toBeNull();
    expect(backlogMessage({ overdue: 0, oldestDueAt: null }, now)).toBeNull();
  });
  it("names the count and the age of the oldest job", () => {
    const m = backlogMessage({ overdue: 601, oldestDueAt: "2026-11-11T06:00:00Z" }, now)!;
    expect(m).toMatch(/^601 background jobs waiting, oldest 6 h ago — the scheduler may not be running/);
    expect(backlogMessage({ overdue: 1, oldestDueAt: "2026-11-11T11:40:00Z" }, now)).toMatch(/1 background job waiting, oldest 20 min ago/);
  });
});
