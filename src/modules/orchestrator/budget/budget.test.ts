import { describe, expect, it } from "vitest";
import { evaluate, jobResource, matches, periodWindow, workflowResource } from "./rules";

describe("budget rules", () => {
  it("maps background jobs to resources; critical work is flagged; unknown types are unguarded", () => {
    expect(jobResource("intelligence.research")).toEqual({ resource: "research", module: "intelligence", critical: false });
    expect(jobResource("contacts.reverify")?.resource).toBe("enrichment");
    expect(jobResource("capture.process")).toMatchObject({ resource: "transcription", critical: true });
    expect(jobResource("brief.generate")).toBeNull();
    expect(jobResource("orchestrator.daily_plan")).toBeNull();
  });
  it("maps AI workflows to resources", () => {
    expect(workflowResource("research.web", 2)).toBe("research");
    expect(workflowResource("transcribe", 0, 30)).toBe("transcription");
    expect(workflowResource("contacts.enrich")).toBe("enrichment");
    expect(workflowResource("capture.document_ocr")).toBe("documents");
    expect(workflowResource("brief.synthesis")).toBe("model_tokens");
  });
  it("period windows follow the workspace timezone", () => {
    const now = new Date("2032-03-31T19:00:00Z"); // 1 Apr 00:30 IST
    expect(periodWindow("daily", now, "Asia/Kolkata")).toMatchObject({ key: "2032-04-01" });
    const m = periodWindow("monthly", now, "Asia/Kolkata");
    expect(m.key).toBe("2032-04");
    expect(m.start.toISOString()).toBe("2032-03-31T18:30:00.000Z");
    expect(m.end.toISOString()).toBe("2032-04-30T18:30:00.000Z");
  });
  it("near / exhausted thresholds; provider and module matching never widens to another provider", () => {
    const b = { id: "b", resource: "research" as const, provider: "openai", module: "*", period: "daily" as const, limit_units: 10, unit: "calls" as const, alert_pct: 80, enabled: true };
    const win = { key: "k", end: new Date() };
    expect(evaluate(b, 7, win).status).toBe("ok");
    expect(evaluate(b, 8, win).status).toBe("near");
    expect(evaluate(b, 10, win).status).toBe("exhausted");
    expect(matches(b, { resource: "research", provider: "openai" })).toBe(true);
    expect(matches(b, { resource: "research", provider: "anthropic" })).toBe(false);
  });
});

import { usageRowMatches } from "./rules";
describe("resource_usage matching", () => {
  const row = { resource: "research", unit: "calls", module: "research", provider: "internal" };
  it("an all-modules/all-providers budget counts recorded research calls", () => {
    expect(usageRowMatches({ resource: "research", unit: "calls", module: "*", provider: "*" }, row)).toBe(true);
    expect(usageRowMatches({ resource: "research", unit: "calls", module: "", provider: " " }, row)).toBe(true);
  });
  it("normalises case, whitespace and singular units", () => {
    expect(usageRowMatches({ resource: "Research ", unit: "call", module: " Research", provider: "*" }, row)).toBe(true);
  });
  it("still respects a specific module / provider / resource", () => {
    expect(usageRowMatches({ resource: "research", unit: "calls", module: "intelligence", provider: "*" }, row)).toBe(false);
    expect(usageRowMatches({ resource: "research", unit: "calls", module: "*", provider: "openai" }, row)).toBe(false);
    expect(usageRowMatches({ resource: "enrichment", unit: "calls", module: "*", provider: "*" }, row)).toBe(false);
    expect(usageRowMatches({ resource: "research", unit: "usd", module: "*", provider: "*" }, row)).toBe(false);
  });
});
