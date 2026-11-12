import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/gateway", () => ({ callStructured: vi.fn() }));
import { codeExplanation } from "./ai";

describe("scoring.explain code path", () => {
  it("names drivers, drags, unknowns and questions from the factors", () => {
    const e = codeExplanation({
      score: 64, band: "validate_nurture", confidence: "medium", completeness: 70, recommended_action: "validate_requirement",
      factors: [
        { label: "Lease expiry", known: true, points: 25, max: 30, explanation: "Expiry in 14 months" },
        { label: "Headcount growth", known: true, points: 2, max: 20, explanation: "Flat hiring" },
        { label: "Budget", known: false, points: 0, max: 15, explanation: "" },
      ],
      missing: ["Budget"],
    });
    expect(e.summary).toContain("64/100 (validate nurture)");
    expect(e.summary).toContain("Strongest drivers: Lease expiry (25/30)");
    expect(e.summary).toContain("Held back by Headcount growth (2/20)");
    expect(e.risks.some((r) => r.startsWith("Budget is unknown"))).toBe(true);
    expect(e.questions[0]).toBe("Can you confirm the budget?");
    expect(JSON.stringify(e)).not.toMatch(/undefined|NaN|\{\w+\}/);
  });
});
