// Entity resolution (engine/context.ts): candidate phrases, match ranking and tie detection — pure, no DB.
import { describe, it, expect } from "vitest";
import { candidatePhrases, matchTier, scoreLabel, rankHits } from "./context";
import type { EntityRef } from "../types";
import { classifyIntent } from "./router";
import { selectTools } from "../tools/select";
import { parseCorrection, dueFrom, placeIn } from "./mock";
import { TOOLS } from "../tools";

const T = "abc-x8k2yf";
const lc = (xs: string[]) => xs.map((x) => x.toLowerCase());

describe("candidatePhrases", () => {
  it("drops unit tokens and bare numbers (SF, sq ft, ₹, psf, 30,000)", () => {
    const p = candidatePhrases("The client's requirement is now 30,000 SF, not 25,000 SF at ₹ 95 psf or 80 per sq ft.");
    for (const bad of ["sf", "psf", "sq", "ft", "30", "000", "25", "95", "80", "₹"]) expect(lc(p)).not.toContain(bad);
    expect(p.every((x) => !/^\d/.test(x))).toBe(true);
  });

  it("keeps 'Property A' / 'Tower B' and single-letter suffix names together", () => {
    const p = candidatePhrases(`Compare Property A ${T}, Property B ${T}, Tower C — which is financially better?`);
    expect(p).toContain(`Property A ${T}`);
    expect(p).toContain(`Property B ${T}`);
    expect(p).toContain("Tower C");
    expect(p).not.toContain("A");
  });

  it("honours lowercase tag-like tokens (hyphen or digit) inside and outside a capitalised run", () => {
    expect(candidatePhrases(`Give me everything important about ABC Technologies ${T}.`)).toContain(`ABC Technologies ${T}`);
    expect(candidatePhrases("Review ABC Technologies int-abcdef, identify why")).toContain("ABC Technologies int-abcdef");
    expect(candidatePhrases("what about acme-pune2 today")).toContain("acme-pune2");
    expect(lc(candidatePhrases("Draft a short follow-up to Rahul"))).not.toContain("follow-up");
  });

  it("strips leading verbs/stop words but keeps the name", () => {
    expect(candidatePhrases(`What did Rahul ${T} say about Property A ${T} during our last meeting?`)).toEqual(expect.arrayContaining([`Rahul ${T}`, `Property A ${T}`]));
    expect(candidatePhrases(`Why is ABC Technologies ${T} a high-priority account?`)[0]).toBe(`ABC Technologies ${T}`);
    expect(candidatePhrases("Summarise this requirement.")).toEqual([]);
  });
});

describe("match ranking", () => {
  it("exact > prefix > contains", () => {
    expect(matchTier("ABC Technologies", "abc technologies")).toBe(3);
    expect(matchTier("ABC Technologies Pune", "ABC Technologies")).toBe(2);
    expect(matchTier("Big ABC Technologies", "ABC Technologies")).toBe(1);
    expect(matchTier("Acmeeng-k2ysfg", "SF")).toBe(1);
    expect(matchTier("ABC Technologiesx", "ABC Technologies")).toBe(1); // not a word-boundary prefix
    const ph = ["ABC Technologies"];
    expect(scoreLabel("ABC Technologies", ph).score).toBeGreaterThan(scoreLabel("ABC Technologies Pune", ph).score);
    expect(scoreLabel("ABC Technologies Pune", ph).score).toBeGreaterThan(scoreLabel("The ABC Technologies", ph).score);
    expect(scoreLabel("Pune Widgets abc-x8k2yf", [T]).strong).toBe(false); // single-token contains = weak
  });

  const ref = (type: EntityRef["type"], id: string, label: string): EntityRef => ({ type, id, label });
  const hit = (type: EntityRef["type"], id: string, label: string, phrases: string[]) => ({ ref: ref(type, id, label), ...scoreLabel(label, phrases), phrase: phrases[0] });

  it("drops weak single-token matches when a strong match exists", () => {
    const ph = [`Rahul ${T}`, T];
    const r = rankHits([hit("person", "p1", `Rahul ${T}`, ph), hit("company", "c1", `Pune Widgets ${T}`, ph), hit("company", "c2", `ABC Technologies ${T}`, ph)]);
    expect(r.hits.map((h) => h.ref.id)).toEqual(["p1"]);
    expect(r.ambiguous).toEqual([]);
  });

  it("returns a clarifying ambiguity instead of picking the first of tied records", () => {
    const ph = ["ABC Technologies"];
    const r = rankHits([hit("company", "c1", "ABC Technologies int-111111", ph), hit("company", "c2", "ABC Technologies int-222222", ph), hit("person", "p1", "Someone", ["Someone"])]);
    expect(r.hits.map((h) => h.ref.id)).toEqual(["p1"]);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].type).toBe("company");
    expect(r.ambiguous[0].candidates.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("an exact match wins over prefix matches (no question)", () => {
    const ph = ["ABC Technologies"];
    const r = rankHits([hit("company", "c1", "ABC Technologies Pune", ph), hit("company", "c2", "ABC Technologies", ph), hit("company", "c3", "ABC Technologies Mumbai", ph)]);
    expect(r.ambiguous).toEqual([]);
    expect(r.hits[0].ref.id).toBe("c2");
  });

  it("sets of buildings are not treated as ambiguous", () => {
    const ph = ["Property A", "Property B"];
    const r = rankHits([hit("asset", "a1", "Property A", ph), hit("asset", "a2", "Property B", ph)]);
    expect(r.ambiguous).toEqual([]);
    expect(r.hits).toHaveLength(2);
  });
});

// ---- planner routing (router.ts / select.ts / mock.ts helpers) ----------------------------------------------------

describe("intent routing and tool selection", () => {
  const ids = TOOLS.map((t) => t.id);
  const offered = (q: string) => { const s = selectTools({ intent: classifyIntent(q), request: q, available: ids }); return s.all ? ids : s.ids; };
  it.each([
    ["Why did we identify ABC as an opportunity?", "research_why", "get_research_signals"],
    ["Why is ABC a high-priority account?", "priority_accounts", "get_scores"],
    ["Who are the important people we need to speak to at ABC?", "decision_makers", "find_decision_makers"],
    ["What did Rahul say about Property A during our last meeting?", "history", "get_meeting_history"],
    ["Draft a short follow-up to Rahul based on our last meeting.", "outreach_draft", "generate_outreach_draft"],
    ["The client's requirement is now 30,000 SF, not 25,000 SF.", "requirement_correction", "update_requirement_record"],
    ["Which of the three properties is financially better?", "compare_properties", "compare_properties"],
    ["Give me everything important about ABC", "company_summary", "get_outreach_history"],
  ])("%s → %s, offers %s", (q, intent, tool) => {
    expect(classifyIntent(q)).toBe(intent);
    expect(offered(q)).toContain(tool);
  });
  it("follow-up requests get the outreach group even inside another intent", () => {
    expect(offered("Prepare a follow-up for Rahul, create an internal reminder for Friday and update the deal review.")).toEqual(expect.arrayContaining(["generate_outreach_draft", "create_internal_task", "generate_deal_review"]));
  });
});

describe("planner helpers", () => {
  it("parses requirement corrections to Deals contract keys", () => {
    expect(parseCorrection("The client's requirement is now 30,000 SF, not 25,000 SF.")).toEqual({ key: "area", target: 30000, was: 25000 });
    expect(parseCorrection("They need 280 seats instead of 250")).toMatchObject({ key: "seats", target: 280 });
    expect(parseCorrection("now we are fine")).toBeNull();
  });
  it("works out the next weekday and places", () => {
    expect(dueFrom("reminder for Friday", new Date("2026-11-11T10:00:00Z"))).toBe("2026-11-13");
    expect(dueFrom("remind me tomorrow", new Date("2026-11-11T10:00:00Z"))).toBe("2026-11-12");
    expect(placeIn("Show me all Pune companies with lease expiries")).toBe("Pune");
    expect(placeIn("leases expiring in Hinjewadi next year")).toBe("Hinjewadi");
    expect(placeIn("Show me all companies")).toBeUndefined();
  });
});
