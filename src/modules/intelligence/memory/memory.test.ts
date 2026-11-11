import { describe, it, expect } from "vitest";
import { relationshipStrength, type RelationshipEvidence } from "./relationship/strength";
import { requirementConfidence, requirementEvolution } from "./requirement/confidence";
import { display } from "./types";

const base: RelationshipEvidence = { interactions: 0, meaningful: 0, firstAt: null, lastAt: null, meetings: 0, outbound: 0, inbound: 0, voluntaryInfo: 0, introductions: 0, wins: 0, commitmentsKept: 0, commitmentsOverdue: 0, userLevel: null, today: "2026-11-11" };

describe("relationship strength (§4.2)", () => {
  it("no evidence → none; null → unknown", () => {
    expect(relationshipStrength(base).level).toBe("none");
    expect(relationshipStrength(null).level).toBe("unknown");
    expect(relationshipStrength(null).score).toBeNull();
  });
  it("frequency is not strength: 40 one-way emails stay weak and say why", () => {
    const a = relationshipStrength({ ...base, interactions: 40, outbound: 40, firstAt: "2026-01-01", lastAt: "2026-11-10" });
    expect(a.level).toBe("weak");
    expect(a.factors.find((f) => f.key === "frequency")!.points).toBeLessThanOrEqual(10);
    expect(a.explanation.join(" ")).toMatch(/No evidence of/);
  });
  it("trust signals make a strong relationship, with evidence listed", () => {
    const a = relationshipStrength({ ...base, interactions: 6, meaningful: 4, outbound: 3, inbound: 3, voluntaryInfo: 2, meetings: 3, introductions: 1, wins: 1, commitmentsKept: 2, firstAt: "2026-01-01", lastAt: "2026-11-01", userLevel: "trusted" });
    expect(["good", "strong"]).toContain(a.level);
    expect(a.factors.every((f) => f.note.length > 0)).toBe(true);
    expect(a.caveats.join(" ")).toMatch(/not scored/);
  });
});

describe("requirement confidence + evolution (§5.2, §5.3)", () => {
  it("maps statuses and never upgrades inference", () => {
    expect(requirementConfidence("client_confirmed", { value: 10 })).toBe("confirmed");
    expect(requirementConfidence("reported", { value: 10 })).toBe("indicative");
    expect(requirementConfidence("estimated", { value: 10 })).toBe("estimated");
    expect(requirementConfidence("inferred", { value: 10 })).toBe("inferred");
    expect(requirementConfidence("client_confirmed", { value: null })).toBe("unknown");
    expect(requirementConfidence("client_confirmed", { value: 1, conflicting: true })).toBe("conflicting");
    expect(requirementConfidence("client_confirmed", { value: 1, outdated: true })).toBe("outdated");
  });
  it("detects area/location/timeline changes and keeps the previous value as obsolete", () => {
    const ch = requirementEvolution([
      { version: 2, created_at: "2026-10-01", change_reason: "client call", change_proposal_id: null, snapshot: { area_min_sf: null, area_target_sf: 15000, area_max_sf: null, preferred_geography_ids: ["kharadi"], occupation_date: "2027-03-31" } },
      { version: 1, created_at: "2026-09-01", change_reason: null, change_proposal_id: null, snapshot: { area_min_sf: null, area_target_sf: 10000, area_max_sf: null, preferred_geography_ids: ["hinjawadi"], occupation_date: "2026-12-31" } },
    ]);
    expect(ch.map((c) => c.field).sort()).toEqual(["area", "occupation_date", "preferred_locations"]);
    const area = ch.find((c) => c.field === "area")!;
    expect(area.from).toEqual([null, 10000, null]); expect(area.to).toEqual([null, 15000, null]);
    expect(area.previousObsolete).toBe(true); expect(area.reason).toBe("client call");
  });
  it("unknown stays unknown", () => { expect(display(null)).toBe("Unknown"); expect(display([null, null])).toBe("Unknown"); expect(display(0)).toBe("0"); });
});
