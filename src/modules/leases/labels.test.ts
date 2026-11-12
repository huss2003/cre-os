import { describe, it, expect } from "vitest";
import { dedupeObligations, leaseLabel } from "./service";

describe("leaseLabel", () => {
  it("falls back tenant → landlord → building/floor/unit → reference", () => {
    expect(leaseLabel({ tenant_name: "Acme" , asset_name: "T1" })).toBe("Acme");
    expect(leaseLabel({ landlord_name: "Panchshil", asset_name: "T1" })).toBe("Panchshil — T1");
    expect(leaseLabel({ asset_name: "Riverside One", floor: "5", unit: "East wing" })).toBe("Riverside One · Floor 5 · East wing");
    expect(leaseLabel({ reference: "L-9" })).toBe("L-9");
    expect(leaseLabel({})).not.toBe("Lease");
  });
});

describe("dedupeObligations", () => {
  it("collapses repeated extractions, keeps the progressed row", () => {
    const base = { lease_id: "a", category: "insurance", description: "Keep insured", deadline: null, responsible: "tenant" };
    const out = dedupeObligations([{ ...base, id: 1, status: "open" }, { ...base, id: 2, description: " keep  insured", status: "done" }, { ...base, id: 3, category: "repairs", status: "open" }]);
    expect(out.map((o) => o.id)).toEqual([2, 3]);
  });
});
