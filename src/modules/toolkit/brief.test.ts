import { describe, it, expect } from "vitest";
import { buildBrief, parseFieldInput } from "./brief";

const req = {
  id: "r1", title: "Pune HQ", status: "estimated", row_version: 3, organisation: { display_name: "Acme" },
  objective: "relocation", area_min_sf: 10000, area_target_sf: 12000, area_max_sf: null, area_basis: "carpet",
  preferred_geography_ids: ["g1"], decision_date: null,
  constraints: { values: { budget_inclusions: "CAM, parking", legal_entity: "Acme India Pvt Ltd" }, field_status: { objective: "client_confirmed", budget_inclusions: "reported" }, not_applicable: ["capex_financing"] },
};

describe("brief-1.0", () => {
  const b = buildBrief({ requirement: req as never, stakeholders: [{ role: "finance", person: { full_name: "Priya" } }], pendingProposals: [{ id: "p1", state: "proposed", reason: "x" }], geographies: [{ id: "g1", name: "Baner" }],
    meetings: [{ title: "Discovery", start_at: "2026-11-01T10:00:00Z", outcome: { outcome: "positive", summary: "Good", commitments: [{ who: "us", what: "Send shortlist", due: "2026-11-05" }] } }, { title: "No notes", outcome: null }] });
  const f = (k: string) => b.sections.flatMap((s) => s.fields).find((x) => x.key === k)!;
  it("labels Confirmed / Estimated / Assumption / Missing / Not applicable from requirement field status", () => {
    expect(f("objective").status).toBe("Confirmed");
    expect(f("area").status).toBe("Estimated");
    expect(f("budget_inclusions").status).toBe("Assumption");
    expect(f("decision_date").status).toBe("Missing");
    expect(f("decision_date").value).toBeNull();
    expect(f("capex_financing").status).toBe("Not applicable");
  });
  it("formats ranges and resolves place names without inventing values", () => {
    expect(f("area").value).toBe("min: 10,000 · target: 12,000");
    expect(f("preferred_locations").value).toBe("Baner");
  });
  it("has sections A–G, stakeholder slots, meeting outcomes, open questions and pending approvals", () => {
    expect(b.sections.map((s) => s.id)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
    expect(b.stakeholders.find((s) => s.slot === "Financial approver")!.people).toEqual(["Priya"]);
    expect(b.stakeholders.find((s) => s.slot === "Decision-maker")!.status).toBe("Missing");
    expect(b.meetings).toHaveLength(1);
    expect(b.meetings[0].commitments[0]).toContain("Send shortlist");
    expect(b.openQuestions.length).toBeGreaterThan(0);
    expect(b.missing).toContain("Decision date");
    expect(b.pendingApprovals[0].id).toBe("p1");
    expect(b.counts.Missing).toBeGreaterThan(0);
  });
  it("is deterministic", () => {
    expect(JSON.stringify(buildBrief({ requirement: req as never, stakeholders: [], pendingProposals: [] }))).toBe(JSON.stringify(buildBrief({ requirement: req as never, stakeholders: [], pendingProposals: [] })));
  });
  it("parses form input per field kind", () => {
    expect(parseFieldInput("area", "1, 2, 3")).toEqual(["1", "2", "3"]);
    expect(parseFieldInput("certifications", "IGBC, LEED")).toEqual(["IGBC", "LEED"]);
    expect(parseFieldInput("legal_entity", " X ")).toBe("X");
  });
});
