import { describe, expect, it } from "vitest";
import { codeTalkingPoints } from "./talking-points";

describe("toolkit.negotiation_points code path", () => {
  it("turns offer diffs and computed finance into talking points", () => {
    const pts = codeTalkingPoints({
      offers: [{ no: 1, label: "Offer 1" }, { no: 2, label: "Offer 2" }] as never,
      diffs: [
        { from: null, to: 1, terms: [], financial: null },
        { from: 1, to: 2, terms: [
          { key: "rentPerSf", label: "Base rent ₹/SF/month", previous: "95", current: "90", status: "improved" },
          { key: "escalationPct", label: "Escalation %", previous: "4.5", current: "5", status: "worse" },
          { key: "rentFreeMonths", label: "Rent-free months", previous: "2", current: "2", status: "unchanged" },
        ], financial: { from: 1, to: 2, npvChange: "-1250000", nominalChange: "-2100000", rentChange: "-1800000", depositChange: null, better: "to" } },
      ],
      packages: [{ name: "Fit-out support", items: [], npvValue: "900000", nominalValue: "1000000", itemValues: [], notes: [] }],
      strategy: { preferredOutcome: "Rent ₹88 with 3 months rent-free", acceptableAlternative: "Rent ₹90 with 4.5% escalation", unresolved: ["Car parking ratio"], risks: ["Lock-in 36 months"] },
    });
    expect(pts[0]).toBe("Acknowledge the movement in Offer 2: Base rent ₹/SF/month 95 → 90.");
    expect(pts[1]).toMatch(/Push back — Offer 2 is weaker than Offer 1 on Escalation % \(4\.5 → 5\)/);
    expect(pts[2]).toMatch(/Offer 2 is better for the occupier: NPV change -1250000/);
    expect(pts).toContain("Ask for: Rent ₹88 with 3 months rent-free");
    expect(pts.join(" ")).toMatch(/Fit-out support \(NPV value 900000\)/);
    expect(pts.length).toBeLessThanOrEqual(8);
  });
});
