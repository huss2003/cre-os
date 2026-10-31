/**
 * Workflow 08 Requirement Analyst — round-2 acceptance (pure).
 */
import { describe, it, expect } from "vitest";
import { buildPatch } from "./service";
import {
  FIELD_BY_KEY, FIELD_STATUSES, FIELD_STATUS_LABEL, applyDerivedSpecs, confirmationBlockers, deriveSpecs, fieldStatus, hardConstraints,
  missingQuestions, partitionEdit, type RequirementRow,
} from "./contract";
import { planQuestionTasks, questionTaskKey } from "./tasks";

describe("08 · each value is labelled client-confirmed, reported, estimated or unknown", () => {
  it("has exactly the four statuses with plain labels", () => {
    expect(FIELD_STATUSES).toEqual(["client_confirmed", "reported", "estimated", "unknown"]);
    expect(Object.values(FIELD_STATUS_LABEL)).toEqual(["client-confirmed", "reported", "estimated", "unknown"]);
  });
  it("a reported value is stored as reported and is never treated as a confirmed client instruction", () => {
    const p = buildPatch({ constraints: {} }, [{ key: "tenure_months", value: "60", status: "reported" }, { key: "occupation_date", value: "2027-04-01" }]);
    expect(p.constraints.field_status).toEqual({ tenure_months: "reported", occupation_date: "estimated" });
    const req: RequirementRow = { occupation_date: "2027-04-01", constraints: p.constraints };
    expect(fieldStatus(req, "tenure_months")).toBe("reported");
    const q = missingQuestions(req).find((x) => x.key === "tenure_months")!;
    expect(q.reason).toBe("estimated_needs_confirmation");
    expect(confirmationBlockers(req).join(" ")).toMatch(/Tenure \(months\): estimated, needs client confirmation/);
    // reported fields edit directly (they are not client instructions yet)
    expect(partitionEdit(req, ["tenure_months"])).toEqual({ direct: ["tenure_months"], viaProposal: [] });
  });
});

describe("08 · structured requirement covers every spec field and each is editable", () => {
  const SPEC_FIELDS: Record<string, unknown> = {
    objective: "relocation", area: ["15000", "20000", "25000"], seats: ["150", "180", "200"], area_basis: "carpet", budget: ["70", "95"], budget_basis: "per_sf_month",
    decision_date: "2026-12-15", occupation_date: "2027-03-01", preferred_locations: ["00000000-0000-4000-8000-0000000000aa"], forbidden_locations: ["00000000-0000-4000-8000-0000000000bb"],
    it_load: "server room 20 kW", employee_catchments: "Hinjewadi, Wakad", parking: "40 cars, 120 two-wheelers", transit: "within 1 km of metro", power: "500 kVA",
    security_access: "access control + CCTV", fitout_standard: "warm_shell", tenure_months: "60", expansion: "ROFR on next floor", procurement_process: "RFP + board",
    current_lease_notice: "6 months, break at 36", mandate_status: "exclusive", conflict_status: "clear",
  };
  it("every field named in workflow 08 exists in the contract", () => {
    for (const k of Object.keys(SPEC_FIELDS)) expect(FIELD_BY_KEY.has(k), k).toBe(true);
  });
  it("every field can be written (with its status) and blanks stay unknown", () => {
    const p = buildPatch({ constraints: {} }, Object.entries(SPEC_FIELDS).map(([key, value]) => ({ key, value, status: "reported" as const })));
    expect(Object.keys(p.constraints.field_status!).sort()).toEqual(Object.keys(SPEC_FIELDS).sort());
    const blank = buildPatch({ constraints: {} }, [{ key: "power", value: "" }]);
    expect(blank.constraints.field_status!.power).toBe("unknown");
    expect(blank.constraints.values!.power).toBeUndefined();
  });
  it("a requirement can be saved with missing fields (the checklist lists them instead)", () => {
    const qs = missingQuestions({ constraints: {} });
    expect(qs.filter((q) => q.priority === "mandatory").length).toBeGreaterThan(10);
  });
});

describe("08/09 · free-text power / parking / transit feed the structured matching specs", () => {
  it("parses deterministic figures and refuses to guess", () => {
    expect(deriveSpecs("power", "Need 750 kVA with full DG backup").specs).toEqual({ min_power_kva: 750 });
    expect(deriveSpecs("power", "1.2 MVA").specs).toEqual({ min_power_kva: 1200 });
    expect(deriveSpecs("power", "600 kW").specs).toEqual({});         // kW is not converted to kVA
    expect(deriveSpecs("power", "600 kW").unparsed.length).toBe(1);
    expect(deriveSpecs("parking", "40 cars, 120 two-wheelers").specs).toEqual({ min_car_parks: 40, min_two_wheeler_parks: 120 });
    expect(deriveSpecs("parking", "cars: 25").specs).toEqual({ min_car_parks: 25 });
    expect(deriveSpecs("transit", "within 1.5 km of the metro").specs).toEqual({ max_metro_km: 1.5 });
    expect(deriveSpecs("transit", "metro within 800 m").specs).toEqual({ max_metro_km: 0.8 });
    expect(deriveSpecs("working_hours", "24x7 shifts").specs).toEqual({ operating_24x7: true });
    expect(deriveSpecs("certifications", ["LEED Gold", "IGBC"]).specs).toEqual({ certifications: ["LEED Gold", "IGBC"] });
  });
  it("buildPatch writes derived specs; manual specs win; clearing the answer clears the derived spec", () => {
    const p = buildPatch({ constraints: {} }, [{ key: "power", value: "500 kVA" }, { key: "parking", value: "30 cars" }]);
    expect(p.constraints.required_specs).toEqual({ min_power_kva: 500, min_car_parks: 30 });
    expect(p.constraints.spec_sources).toEqual({ min_power_kva: "derived:power", min_car_parks: "derived:parking" });
    const manual = { ...p.constraints, required_specs: { ...p.constraints.required_specs, min_power_kva: 900 }, spec_sources: { ...p.constraints.spec_sources, min_power_kva: "manual" } };
    const p2 = buildPatch({ constraints: manual }, [{ key: "power", value: "400 kVA" }, { key: "parking", value: "" }]);
    expect(p2.constraints.required_specs).toEqual({ min_power_kva: 900 });
    const c = { values: { transit: "near metro" } };
    expect(applyDerivedSpecs(c, ["transit"])).toEqual(['transit: "near metro" has no distance to metro']);
  });
});

describe("08 · hard constraints and confidence/status are visible", () => {
  it("lists every set hard constraint with its source and status", () => {
    const req: RequirementRow = {
      area_min_sf: 15000, area_max_sf: 25000, area_basis: "carpet", excluded_geography_ids: ["g1"], budget_max: 95, budget_basis: "per_sf_month", occupation_date: "2027-03-01",
      constraints: {
        values: { power: "500 kVA" }, field_status: { area: "client_confirmed", power: "reported" },
        required_specs: { min_power_kva: 500, certifications: ["LEED"] }, spec_sources: { min_power_kva: "derived:power", certifications: "manual" },
        hard_filters: { budget_ceiling: true, latest_occupation: false, preferred_only: false },
      },
    };
    const h = hardConstraints(req, (id) => (id === "g1" ? "Kharadi" : id));
    expect(h.map((x) => [x.key, x.status])).toEqual([
      ["area", "client_confirmed"], ["forbidden_locations", "estimated"], ["min_power_kva", "reported"], ["certifications", "config"], ["hf_budget", "config"],
    ]);
    expect(h.find((x) => x.key === "forbidden_locations")!.value).toBe("Kharadi");
    expect(h.find((x) => x.key === "min_power_kva")!.source).toMatch(/derived from “Power & redundancy”/);
  });
});

describe("08 · missing questions become deduped follow-up tasks that refresh as answers arrive", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it("creates one task per open mandatory question, never twice", () => {
    const req = { id, title: "Acme", constraints: {} } as RequirementRow & { id: string };
    const p1 = planQuestionTasks(req, []);
    const mandatory = missingQuestions(req).filter((q) => q.priority === "mandatory").length;
    expect(p1.create).toHaveLength(mandatory);
    expect(new Set(p1.create.map((c) => c.key)).size).toBe(mandatory);
    const existing = p1.create.map((c, i) => ({ id: `t${i}`, idempotency_key: c.key, status: "open", title: c.title }));
    const p2 = planQuestionTasks(req, existing);
    expect(p2).toEqual({ create: [], retitle: [], reopen: [], close: [] });
  });
  it("estimate → retitled to 'confirm'; confirmed → closed with evidence; cleared → reopened", () => {
    const key = questionTaskKey(id, "tenure_months");
    const base = { id, title: "Acme" };
    const open = [{ id: "t1", idempotency_key: key, status: "open", title: "Ask: Tenure (months) — Acme" }];
    const est = planQuestionTasks({ ...base, constraints: { values: { tenure_months: 60 }, field_status: { tenure_months: "estimated" } } }, open);
    expect(est.retitle).toEqual([expect.objectContaining({ id: "t1", title: "Confirm with client: Tenure (months) — Acme" })]);
    const conf = planQuestionTasks({ ...base, constraints: { values: { tenure_months: 60 }, field_status: { tenure_months: "client_confirmed" } } }, open);
    expect(conf.close).toEqual([{ id: "t1", evidence: "Answered: tenure_months is now client-confirmed" }]);
    const na = planQuestionTasks({ ...base, constraints: { not_applicable: ["tenure_months"] } }, open);
    expect(na.close).toEqual([{ id: "t1", evidence: "Answered: marked not applicable" }]);
    const reopened = planQuestionTasks({ ...base, constraints: {} }, [{ ...open[0], status: "done" }]);
    expect(reopened.reopen.map((r) => r.id)).toEqual(["t1"]);
    // a task the user cancelled is left alone
    expect(planQuestionTasks({ ...base, constraints: {} }, [{ ...open[0], status: "cancelled" }]).reopen).toEqual([]);
  });
});
