import { describe, it, expect } from "vitest";
import { missingQuestions, fieldStatus, partitionEdit, confirmationBlockers, requirementCompleteness, stakeholderGaps, toColumnPatch, REQUIREMENT_FIELDS } from "./contract";

describe("requirement contract (spec Part I §8 Requirement)", () => {
  it("covers every element of the spec's requirement contract", () => {
    const keys = REQUIREMENT_FIELDS.map((f) => f.key);
    for (const k of ["objective", "decision_date", "occupation_date", "area", "area_basis", "seats", "growth_assumption", "attendance_assumption",
      "budget", "budget_inclusions", "preferred_locations", "forbidden_locations", "employee_catchments", "parking", "transit", "power",
      "working_hours", "security_access", "it_load", "certifications", "fitout_standard", "expansion", "tenure_months", "lockin_months",
      "capex_financing", "legal_entity", "commercial_authority", "procurement_process", "current_lease_notice", "mandate_status", "conflict_status"])
      expect(keys).toContain(k);
  });

  it("missing questions are deterministic: mandatory unknowns, then unconfirmed estimates, then helpful", () => {
    const row = { area_min_sf: 15000, area_target_sf: 20000, area_basis: "chargeable", objective: "relocation", mandate_status: "unknown", constraints: { field_status: { objective: "client_confirmed" as const } } };
    const q1 = missingQuestions(row);
    const q2 = missingQuestions(JSON.parse(JSON.stringify(row)));
    expect(q1).toEqual(q2);
    expect(q1[0]).toMatchObject({ key: "decision_date", priority: "mandatory", reason: "missing" });
    expect(q1.find((q) => q.key === "mandate_status")?.reason).toBe("missing"); // "unknown" is not an answer
    expect(q1.find((q) => q.key === "objective")).toBeUndefined(); // confirmed
    const est = q1.filter((q) => q.reason === "estimated_needs_confirmation").map((q) => q.key);
    expect(est).toEqual(["area", "area_basis"]);
    const firstHelpful = q1.findIndex((q) => q.priority === "helpful");
    expect(q1.slice(firstHelpful).every((q) => q.priority === "helpful")).toBe(true);
  });

  it("client confirmed and estimated are distinct; unknown is not coerced", () => {
    const row = { budget_max: 90, constraints: { field_status: { budget: "client_confirmed" as const } } };
    expect(fieldStatus(row, "budget")).toBe("client_confirmed");
    expect(fieldStatus({ budget_max: 90 }, "budget")).toBe("estimated");
    expect(fieldStatus({}, "budget")).toBe("unknown");
    expect(fieldStatus({ budget_max: 0 }, "budget")).toBe("estimated"); // zero is a value, not unknown
  });

  it("edits to confirmed fields must go through a change proposal", () => {
    const row = { status: "estimated", area_target_sf: 20000, constraints: { field_status: { area: "client_confirmed" as const } } };
    expect(partitionEdit(row, ["area", "budget"])).toEqual({ direct: ["budget"], viaProposal: ["area"] });
    expect(partitionEdit({ ...row, status: "client_confirmed" }, ["budget"])).toEqual({ direct: [], viaProposal: ["budget"] });
  });

  it("confirmation is blocked until all mandatory fields are known and confirmed", () => {
    expect(confirmationBlockers({}).length).toBeGreaterThan(10);
    const c = requirementCompleteness({ objective: "new", constraints: { field_status: { objective: "client_confirmed" } } });
    expect(c.mandatoryConfirmed).toBe(1);
    expect(c.percentConfirmed).toBeLessThan(10);
  });

  it("not-applicable answers suppress questions without inventing values", () => {
    const q = missingQuestions({ constraints: { not_applicable: ["current_lease_notice"] } });
    expect(q.find((x) => x.key === "current_lease_notice")).toBeUndefined();
  });

  it("stakeholder map gaps and column mapping", () => {
    expect(stakeholderGaps(["user"])).toContain("No economic buyer / approver identified");
    expect(stakeholderGaps(["sponsor", "finance", "procurement", "legal"])).toEqual([]);
    expect(toColumnPatch("area", [1, 2, 3]).columns).toEqual({ area_min_sf: 1, area_target_sf: 2, area_max_sf: 3 });
    expect(toColumnPatch("power", "1 MW")).toEqual({ columns: {}, constraintValue: "1 MW" });
  });
});
