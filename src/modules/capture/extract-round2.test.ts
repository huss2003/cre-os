import { describe, it, expect } from "vitest";
import { ruleExtract, enforceRules, parseUnitSpec, ExtractionSchema, DETAIL_KEYS, type Extraction } from "./extract";
import { FIELD_BY_KEY } from "@/modules/deals/requirements/contract";

const AT = "2026-10-31T12:30:00Z"; // Saturday 31 Oct 2026, 18:00 IST
const SPEC = "spoke to Raj; 20k by March; maybe Baner; send options Friday";

describe("debrief acceptance: exact spec sentence (no company)", () => {
  const ex = ruleExtract(SPEC, { sourceAt: AT });
  it("produces reviewable objects and asks about the year, the weekday and the unit of 20k", () => {
    expect(ExtractionSchema.parse(ex)).toBeTruthy();
    expect(ex.interaction?.channel).toBe("call");
    expect(ex.mentions.map((m) => [m.kind, m.text])).toEqual([["person", "Raj"], ["geography", "Baner"]]);
    const kinds = ex.ambiguities.map((a) => a.kind).sort();
    expect(kinds).toEqual(["date", "date", "unit"]);
    expect(ex.ambiguities.find((a) => a.kind === "date" && /March/.test(a.question))!.options.map((o) => o.value)).toEqual(["2027-03-31", "2028-03-31"]);
    expect(ex.tasks[0]).toMatchObject({ description: "Send options to Raj", due_date: "2026-11-06" });
    expect(ex.drafts).toHaveLength(1);
  });
  it("'20k' unit ambiguity: sq ft vs rupees is asked, never assumed", () => {
    const unit = ex.ambiguities.find((a) => a.kind === "unit")!;
    expect(unit.options.map((o) => o.value)).toEqual(["area_target_sf", "budget_max|per_seat_month", "budget_max|total_month"]);
    expect(unit.options[0].label).toMatch(/20,000 sq ft/);
    expect(unit.options[1].label).toMatch(/₹20,000 per seat/);
    const f = ex.facts[unit.fact_index!];
    expect(f.raw_text).toBe("20k");
    expect(f.unit).toBeNull();
    expect(parseUnitSpec("budget_max|per_seat_month")).toEqual({ field: "budget_max", basis: "per_seat_month" });
    expect(parseUnitSpec("membership|owner")).toBeNull();
  });
  it("Indian digit grouping: '25,000 sq ft' and '1,20,000 sq ft' are read whole", () => {
    const e = ruleExtract("met Priya from Zenith; 25,000 sq ft now, 1,20,000 sq ft later", { sourceAt: AT });
    expect(e.facts.filter((f) => f.field === "area_target_sf").map((f) => f.proposed_value)).toEqual([25000, 120000]);
  });
  it("explicit units are not asked about", () => {
    const e = ruleExtract("met Priya from Zenith; 20k sq ft; budget ₹85 per sq ft; 120 seats", { sourceAt: AT });
    expect(e.ambiguities.filter((a) => a.kind === "unit")).toEqual([]);
    expect(e.facts.map((f) => [f.field, f.proposed_value, f.unit])).toEqual([["area_target_sf", 20000, "sf"], ["budget_max", 85, "INR/sf/month"], ["seats_target", 120, "seats"]]);
  });
  it("the adviser's own commitment is a promise with who 'me'", () => {
    expect(ex.promises).toEqual([expect.objectContaining({ who: "me", what: "Send options to Raj", due: "2026-11-06", task_index: 0 })]);
  });
  it("enforceRules restores the unit question when a model silently assumes sq ft", () => {
    const model: Extraction = { ...ex, ambiguities: ex.ambiguities.filter((a) => a.kind !== "unit"), facts: ex.facts.map((f) => (f.raw_text === "20k" ? { ...f, unit: "sf" } : f)) };
    const out = enforceRules(model, SPEC, [], { sourceAt: AT });
    const u = out.ambiguities.find((a) => a.kind === "unit")!;
    expect(u).toBeTruthy();
    expect(out.facts[u.fact_index!].raw_text).toBe("20k");
  });
});

describe("Hinglish debriefs (deterministic, no AI)", () => {
  it("'Raj se baat hui, 20k chahiye March tak, Baner ho sakta hai, Friday ko options bhejna hai' matches the English structure", () => {
    const ex = ruleExtract("Raj se baat hui, 20k chahiye March tak, Baner ho sakta hai, Friday ko options bhejna hai", { sourceAt: AT });
    expect(ex.interaction?.channel).toBe("call");
    expect(ex.mentions.map((m) => [m.kind, m.text])).toEqual([["person", "Raj"], ["geography", "Baner"]]);
    expect(ex.ambiguities.map((a) => a.kind).sort()).toEqual(["date", "date", "unit"]);
    expect(ex.facts.find((f) => f.field === "occupation_date")).toMatchObject({ proposed_value: null, raw_text: "March tak" });
    expect(ex.facts.find((f) => f.field === "preferred_geography")).toMatchObject({ proposed_value: "Baner", status: "tentative" });
    expect(ex.tasks).toEqual([expect.objectContaining({ description: "Send options to Raj", due_date: "2026-11-06" })]);
    expect(ex.promises[0]).toMatchObject({ who: "me", what: "Send options to Raj" });
    expect(ex.drafts).toHaveLength(1);
  });
  it("Hindi number words: 'bees hazaar', 'pachaas', and confusable 'saath'/'saat' is asked", () => {
    const ex = ruleExtract("Acme ke Priya se mila, bees hazaar sq ft chahiye, pachaas seats, saath hazaar sq ft bhi ho sakta hai", { sourceAt: AT });
    expect(ex.interaction?.channel).toBe("meeting");
    expect(ex.mentions.slice(0, 2).map((m) => [m.kind, m.text])).toEqual([["organisation", "Acme"], ["person", "Priya"]]);
    expect(ex.facts.slice(0, 2).map((f) => [f.field, f.proposed_value])).toEqual([["area_target_sf", 20000], ["seats_target", 50]]);
    const n = ex.ambiguities.find((a) => a.kind === "number")!;
    expect(n.options.map((o) => o.value)).toEqual([60000, 7000]);
    expect(ex.facts[n.fact_index!].proposed_value).toBeNull();
  });
  it("Devanagari digits and 'pachaas hazaar' without a unit become a unit question", () => {
    const ex = ruleExtract("Raj ko call kiya, २० हज़ार नहीं, pachaas hazaar chahiye", { sourceAt: AT });
    expect(ex.interaction?.channel).toBe("call");
    const u = ex.ambiguities.find((a) => a.kind === "unit")!;
    expect(ex.facts[u.fact_index!].proposed_value).toBe(50000);
  });
  it("counterparty promise, decision-maker and objection in Hinglish", () => {
    const ex = ruleExtract("Raj Monday tak floor plan bhejega, decision Raj lega, rent mehenga lag raha hai", { sourceAt: AT });
    expect(ex.promises).toEqual([expect.objectContaining({ who: "Raj", what: "Send floor plan", due: "2026-11-02" })]);
    expect(ex.ambiguities.some((a) => a.kind === "date" && /Monday/.test(a.question))).toBe(true);
    expect(ex.stakeholders).toEqual([expect.objectContaining({ role: "approver" })]);
    expect(ex.objections.map((o) => o.text)).toEqual(["rent mehenga lag raha hai"]);
  });
});

describe("promises, objections, stakeholder roles and requirement details", () => {
  const text = "met Priya from Zenith; Priya is the decision maker; CFO Meera; Amit from procurement; Raj will send floor plans by Monday; " +
    "too expensive for them; need 50 car parks, 500 kVA power backup, near metro, biometric access control; 5 year lease with 3 year lock-in; warm shell; " +
    "option to expand by another floor; employees mostly live in Wakad";
  const ex = ruleExtract(text, { sourceAt: AT });
  it("extracts who/what/when for promises and keeps objections verbatim", () => {
    expect(ex.promises).toEqual([expect.objectContaining({ who: "Raj", what: "Send floor plans", due: "2026-11-02", task_index: null })]);
    expect(ex.objections.map((o) => o.text)).toEqual(["too expensive for them"]);
  });
  it("stakeholder roles point at person mentions", () => {
    const roles = ex.stakeholders.map((s) => [ex.mentions[s.mention_index].text, s.role]);
    expect(roles).toEqual([["Priya", "approver"], ["Meera", "finance"], ["Amit", "procurement"]]);
  });
  it("requirement details use requirement-contract keys (constraints fields)", () => {
    const d = Object.fromEntries(ex.details.map((x) => [x.key, x.value]));
    expect(d).toMatchObject({ parking: "need 50 car parks", power: "500 kVA power backup", transit: "near metro", security_access: "biometric access control",
      tenure_months: 60, lockin_months: 36, fitout_standard: "warm_shell", expansion: "option to expand by another floor", employee_catchments: "Wakad" });
    for (const k of DETAIL_KEYS) expect(FIELD_BY_KEY.get(k)?.columns).toBeUndefined();
    expect(ex.facts.some((f) => f.field === "preferred_geography")).toBe(false); // catchment is not a location preference
  });
});
