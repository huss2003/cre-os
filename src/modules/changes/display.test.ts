import { describe, it, expect } from "vitest";
import { fieldLabel, formatValue, collectRefs, UNKNOWN, UNKNOWN_RECORD } from "./display";

const ORG = "11111111-1111-4111-8111-111111111111", G1 = "22222222-2222-4222-8222-222222222222", G2 = "33333333-3333-4333-8333-333333333333";

describe("proposal display formatter", () => {
  it("labels fields in plain words", () => {
    expect(fieldLabel("/org_id")).toBe("Company");
    expect(fieldLabel("/preferred_geography_ids")).toBe("Preferred locations");
    expect(fieldLabel("/area_min_sf")).toBe("Min area (sf)");
    expect(fieldLabel("/some_new_field")).toBe("Some new field");
  });
  it("resolves ids to names and never leaks unknown ids", () => {
    expect(formatValue("/org_id", ORG, { [ORG]: "Acme" })).toBe("Acme");
    expect(formatValue("/preferred_geography_ids", [G1, G2], { [G1]: "Baner" })).toBe(`Baner, ${UNKNOWN_RECORD}`);
    expect(formatValue("/org_id", ORG)).not.toContain(ORG);
  });
  it("renders objects as key: value lists, dates formatted, nulls Unknown", () => {
    const out = formatValue("/constraints", { values: { must_have: ["parking", "cafeteria"], fit_out: true }, source: "lease_chain" });
    expect(out).not.toMatch(/[{}"]/);
    expect(out).toContain("Must have: parking, cafeteria");
    expect(out).toContain("Fit out: Yes");
    expect(formatValue("/occupation_date", "2027-03-31")).toBe("31 Mar 2027");
    expect(formatValue("/occupation_date", null)).toBe(UNKNOWN);
    expect(formatValue("/area_target_sf", 20000)).toBe("20,000");
  });
  it("collects referenced ids by table, including nested", () => {
    const m = collectRefs("/constraints", { lease_id: ORG, preferred_geography_ids: [G1] });
    expect([...m.get("lease")!]).toEqual([ORG]);
    expect([...m.get("geography")!]).toEqual([G1]);
  });
});
