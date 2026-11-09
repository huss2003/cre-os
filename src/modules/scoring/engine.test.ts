import { describe, it, expect } from "vitest";
import { compute, validateVersion, bandFor, inputsHash, type ModelVersion } from "./engine";
import { classifyRole } from "./features";

const V: ModelVersion = { bands: [{ min: 80, label: "Very High" }, { min: 60, label: "High" }, { min: 40, label: "Medium" }, { min: 20, label: "Low" }, { min: 0, label: "Very Low" }], config: {}, factors: [
  { key: "a", label: "A", weight: 50, unknown: "exclude", description: "" },
  { key: "b", label: "B", weight: 30, unknown: "neutral", description: "" },
  { key: "c", label: "C", weight: 20, unknown: "zero", description: "" },
] };

describe("scoring engine math", () => {
  it("weighted average, rounding and bands", () => {
    const o = compute(V, { values: { a: { value: 1, explanation: "" }, b: { value: 0.5, explanation: "" }, c: { value: 0.25, explanation: "" } } });
    expect(o.score).toBe(Math.round((50 * 1 + 30 * 0.5 + 20 * 0.25) / 100 * 100)); // 70
    expect(o.band).toBe("High"); expect(o.completeness).toBe(100);
  });
  it("unknown policies: exclude drops weight, neutral = 0.5, zero = 0; unknown never reads as negative when excluded", () => {
    const o = compute(V, { values: { a: { value: null, explanation: "" }, b: { value: null, explanation: "" }, c: { value: 1, explanation: "" } } });
    expect(o.score).toBe(Math.round(((30 * 0.5 + 20 * 1) / 50) * 100)); // 70
    expect(o.completeness).toBe(20);
    expect(o.confidence).toBe("insufficient");
  });
  it("mandatory failure disqualifies regardless of good factors", () => {
    const o = compute(V, { values: { a: { value: 1, explanation: "" }, b: { value: 1, explanation: "" }, c: { value: 1, explanation: "" } }, mandatoryFailed: ["Outside area range"] });
    expect(o.score).toBe(0); expect(o.band).toBe("Disqualified"); expect(o.missing).toContain("Fails: Outside area range");
  });
  it("clamps values to 0..1 and stays within 0..100", () => {
    const o = compute(V, { values: { a: { value: 7, explanation: "" }, b: { value: -3, explanation: "" }, c: { value: 1, explanation: "" } } });
    expect(o.score).toBe(70); expect(o.score).toBeLessThanOrEqual(100);
  });
  it("is reproducible: same inputs → same hash and score", () => {
    const f = { values: { a: { value: 0.4, explanation: "x" } } };
    expect(inputsHash("v1", f)).toBe(inputsHash("v1", f));
    expect(inputsHash("v1", f)).not.toBe(inputsHash("v2", f));
    expect(compute(V, f).score).toBe(compute(V, f).score);
  });
  it("validates weights and thresholds", () => {
    expect(validateVersion({ ...V, factors: [{ ...V.factors[0], weight: -1 }] }).join()).toMatch(/between 0 and 100/);
    expect(validateVersion({ ...V, bands: [{ min: 50, label: "x" }] }).join()).toMatch(/start at 0/);
    expect(validateVersion({ ...V, factors: [V.factors[0], V.factors[0]] }).join()).toMatch(/duplicated/);
    expect(bandFor(59, V.bands)).toBe("Medium"); expect(bandFor(60, V.bands)).toBe("High");
  });
  it("contact roles: seniority alone is not authority", () => {
    expect(classifyRole("Head of Corporate Real Estate").cls).toBe("decision_maker");
    expect(classifyRole("CEO").cls).toBe("influencer");
    expect(classifyRole("Executive Assistant to CEO").cls).toBe("gatekeeper");
    expect(classifyRole("Software Engineer").cls).toBe("unknown");
    expect(classifyRole(null).value).toBeNull();
  });
});
