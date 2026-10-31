import { describe, it, expect } from "vitest";
import { buildPatch } from "./service";
import { partitionEdit, missingQuestions } from "./contract";

describe("requirement edits", () => {
  it("new values are estimates unless explicitly confirmed; blanks stay unknown (S6)", () => {
    const p = buildPatch({ constraints: {} }, [
      { key: "area", value: ["15,000", "", "25000"] }, { key: "occupation_date", value: "2027-03-01", status: "client_confirmed" },
      { key: "legal_entity", value: "Acme India Pvt Ltd" }, { key: "seats", value: ["", "", ""] },
    ]);
    expect(p.columns).toMatchObject({ area_min_sf: 15000, area_target_sf: null, area_max_sf: 25000, occupation_date: "2027-03-01", seats_min: null });
    expect(p.constraints.values).toEqual({ legal_entity: "Acme India Pvt Ltd" });
    expect(p.constraints.field_status).toEqual({ area: "estimated", occupation_date: "client_confirmed", legal_entity: "estimated", seats: "unknown" });
  });
  it("rejects malformed values", () => {
    expect(() => buildPatch({}, [{ key: "decision_date", value: "next March" }])).toThrow(/YYYY-MM-DD/);
    expect(() => buildPatch({}, [{ key: "area_basis", value: "super" }])).toThrow(/one of/);
    expect(() => buildPatch({}, [{ key: "nope", value: 1 }])).toThrow(/unknown/);
  });
  it("confirmed fields route to proposals; estimates edit directly", () => {
    const req = { status: "estimated", constraints: { field_status: { area: "client_confirmed" as const } }, area_min_sf: 1 };
    expect(partitionEdit(req, ["area", "budget"])).toEqual({ direct: ["budget"], viaProposal: ["area"] });
    expect(partitionEdit({ ...req, status: "client_confirmed" }, ["budget"])).toEqual({ direct: [], viaProposal: ["budget"] });
  });
  it("missing questions are deterministic", () => {
    expect(missingQuestions({})).toEqual(missingQuestions({}));
    expect(missingQuestions({})[0].key).toBe("objective");
  });
});
