import { describe, it, expect } from "vitest";
import { score } from "./assess";

const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const old = new Date(Date.now() - 500 * 86_400_000).toISOString().slice(0, 10);
const f = (factor: string, point: string, published_on: string | null, location: string | null = null, url = "https://news.example.com/a") =>
  ({ factor, point, published_on, location, source_url: url, source_name: "Example" });

describe("client score (deterministic)", () => {
  it("adds fixed points per factor once, halves old news, demotes non-local hiring, subtracts layoffs", () => {
    const r = score([
      f("pune_expansion", "Opening new Pune campus", recent, "Pune"),
      f("pune_expansion", "Same story again", recent, "Pune", "https://b.example.com"),
      f("hiring_local", "Hiring 500 in Bengaluru", recent, "Bengaluru"),
      f("funding", "Raised Series C", old),
      f("layoffs", "Cut 5% staff", recent),
      f("gcc", "LinkedIn post", recent, null, "https://www.linkedin.com/x"),
    ], [], ["Pune"]);
    expect(r.for.map((p) => [p.factor, p.points])).toEqual([["pune_expansion", 22], ["india_expansion", 6], ["funding", 4]]);
    expect(r.against[0].points).toBe(-8);
    expect(r.score).toBe(10 + 22 + 6 + 4 - 8);
  });
  it("caps at 100 and never goes below 0", () => {
    expect(score([f("layoffs", "x", recent), f("office_exit", "y", recent)], [], ["Pune"]).score).toBe(0);
    const many = ["pune_expansion", "new_office", "gcc", "hiring_local", "relocation", "consolidation", "lease_event", "funding"].map((k) => f(k, "Pune news", recent, "Pune"));
    expect(score(many, [], ["Pune"]).score).toBe(100);
  });
});

import { codeAssessment, factorFor } from "./assess";
describe("signals.assess code path (rules)", () => {
  it("maps signal text to factors", () => {
    expect(factorFor("", "Acme sets up GCC in Pune")).toBe("gcc");
    expect(factorFor("", "Acme announces layoffs of 200")).toBe("layoffs");
    expect(factorFor("job_move", "X joins as CFO")).toBe("leadership_change");
    expect(factorFor("pune_expansion", "anything")).toBe("pune_expansion");
  });
  it("builds sourced facts from stored signals and discovery hints; unsourced signals are flagged", () => {
    const o = codeAssessment("Acme", [
      { kind: "hiring_local", title: "Acme hiring 300 engineers in Pune", summary: null, location_text: "Pune", event_date: null, latest_evidence_on: "2026-10-01", detected_at: "", confidence: "medium", evidence: [{ source_url: "https://et.example.com/a", source_name: "ET", published_on: "2026-10-01" }] },
      { kind: "other", title: "Rumour", summary: null, location_text: null, event_date: null, latest_evidence_on: null, detected_at: "", confidence: "low", evidence: [] },
    ], ["Pune"], ["Acme sets up GCC in Pune (https://news.example.com/x, 2026-11-05)"]);
    expect(o.facts.map((f) => f.factor)).toEqual(["hiring_local", "gcc"]);
    expect(o.facts[1].published_on).toBe("2026-11-05");
    expect(o.summary).toMatch(/Acme has 3 known signals, 2 mentioning Pune/);
    expect(o.unknowns[0]).toMatch(/source link/);
  });
});
