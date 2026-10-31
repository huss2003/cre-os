import { describe, it, expect } from "vitest";
import { decide, findCandidates, scoreBuilding, scoreOrganisation, scorePerson, buildingBlock } from "./identity";

describe("identity ambiguity", () => {
  it("two people sharing a name remain separate (a name alone never permits a merge)", () => {
    const s = scorePerson({ name: "Rahul Sharma" }, { name: "Rahul Sharma" });
    expect(s.score).toBeLessThan(0.8);
    expect(decide(s)).toBe("separate");
  });
  it("people with a shared verified email are an auto-link candidate; conflicting names go to review", () => {
    expect(decide(scorePerson({ name: "Rahul Sharma", verified_emails: ["r@acme.com"] }, { name: "Rahul  Sharma", verified_emails: ["R@acme.com"] }))).toBe("auto_link");
    expect(decide(scorePerson({ name: "Rahul Sharma", verified_emails: ["r@acme.com"] }, { name: "Priya Nair", verified_emails: ["r@acme.com"] }))).toBe("review");
  });
  it("two towers of one campus are not merged", () => {
    const s = scoreBuilding({ name: "EON Free Zone Tower 1", locality: "Kharadi" }, { name: "EON Free Zone Tower 2", locality: "Kharadi" });
    expect(s.evidence.different_towers).toBe(true);
    expect(decide(s)).toBe("separate");
    const c = findCandidates(
      [{ id: "b", name: "EON Free Zone Tower 2", locality: "Kharadi" }],
      [{ id: "a", name: "EON Free Zone Tower 1", locality: "Kharadi" }],
      scoreBuilding, (x) => buildingBlock(x.name, x.locality),
    );
    expect(c).toEqual([]);
  });
  it("campus vs tower is suggested as a relation, not a merge", () => {
    const s = scoreBuilding({ name: "EON Free Zone", locality: "Kharadi" }, { name: "EON Free Zone Tower 2", locality: "Kharadi" });
    expect(s.suggested).toBe("relate_campus");
  });
  it("same name+locality without coordinates is review, not auto-link (no hard identifier)", () => {
    const s = scoreBuilding({ name: "Beta House", locality: "Baner" }, { name: "Beta  House.", locality: "Baner" });
    expect(s.score).toBeGreaterThanOrEqual(0.95);
    expect(decide(s)).toBe("review");
    const g = scoreBuilding({ name: "Beta House", locality: "Baner", lat: 18.56, lon: 73.78 }, { name: "Beta House", locality: "Baner", lat: 18.5602, lon: 73.7801 });
    expect(decide(g)).toBe("auto_link");
  });
  it("organisation legal-form variants need review; matching CIN auto-links; conflicting CIN keeps separate", () => {
    const v = scoreOrganisation({ name: "Acme Technologies Pvt Ltd" }, { name: "Acme Technologies Private Limited" });
    expect(v.score).toBeGreaterThanOrEqual(0.8);
    expect(decide(v)).toBe("review");
    expect(decide(scoreOrganisation({ name: "Acme Tech", cin: "U1" }, { name: "Acme Technologies", cin: "u1" }))).toBe("auto_link");
    expect(decide(scoreOrganisation({ name: "Acme Ltd", cin: "U1" }, { name: "Acme Limited", cin: "U2" }))).toBe("separate");
  });
  it("group and subsidiary are related, not merged", () => {
    const s = scoreOrganisation({ name: "Tata Ltd" }, { name: "Tata Consultancy Services Ltd" });
    expect(s.suggested).toBe("relate_group");
    expect(decide(s)).toBe("review");
  });
  it("thresholds are configurable", () => {
    const s = scoreOrganisation({ name: "Acme Technologies Pvt Ltd" }, { name: "Acme Technologies Private Limited" });
    expect(decide(s, { auto_link: 0.99, review: 0.95 })).toBe("separate");
  });
});
