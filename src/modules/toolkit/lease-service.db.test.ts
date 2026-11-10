import { describe, it, expect } from "vitest";
import { userClient, USERS, WS1, tag } from "../../../tests/helpers";
import { runLeaseEconomics, createNegotiation, addOffer, loadNegotiation } from "./lease-service";
import { getVersion, sameOutputs } from "./store";
import { leaseEconomics, type LeaseTerms } from "./calc/lease";
import { analyseNegotiation } from "./calc/negotiation";

const A: LeaseTerms = {
  name: "A", label: "quoted", areaSf: 25000, areaBasis: "chargeable", rentPerSf: 100, leaseCommencement: "2027-01-01",
  tenureMonths: 60, rentFreeMonths: 2, escalationPct: 15, escalationEveryMonths: 36, camPerSf: 12, parkingSlots: 0,
  depositMonths: 6, otherRecurringState: "none", gst: { treatment: "included" }, discountRatePct: 0,
};

describe("lease-service persistence (saveAnalysis, immutable versions)", () => {
  it("changed rent saves v2; v1 inputs/outputs unchanged and reproducible", async () => {
    const db = await userClient("owner");
    const w = { db, ws: WS1, userId: USERS.owner.id };
    const v1 = await runLeaseEconomics(w, { title: tag("lease"), offers: [A] });
    const v2 = await runLeaseEconomics(w, { id: v1.id, title: "x", offers: [{ ...A, rentPerSf: 98 }] });
    expect(v2.version).toBe(2);
    const s1 = await getVersion(db, WS1, v1.id, 1);
    expect(s1!.formula_version).toBe("lease-1.0");
    expect(s1!.outputs.result.totals.rent).toBe("154000000.00");
    expect(sameOutputs(JSON.parse(JSON.stringify(leaseEconomics(s1!.inputs.offers[0]))), s1!.outputs.result)).toBe(true);
  });

  it("negotiation offers append; Offer 1 preserved", async () => {
    const db = await userClient("owner");
    const w = { db, ws: WS1, userId: USERS.owner.id };
    const n = await createNegotiation(w, { title: tag("nego"), terms: { ...A, rentFreeMonths: 1 } });
    await addOffer(w, n.id, { ...A, rentPerSf: 95, rentFreeMonths: 3, escalationPct: 12 });
    const a = await loadNegotiation(w, n.id);
    expect(a!.inputs.versions.map((v) => v.label)).toEqual(["Offer 1", "Offer 2"]);
    expect(a!.inputs.versions[0].terms.rentPerSf).toBe(100);
    expect(a!.outputs.diffs[1].financial!.rentChange).toBe("-14285000.00");
    expect(sameOutputs(JSON.parse(JSON.stringify(analyseNegotiation(a!.inputs.versions, a!.inputs.packages))), a!.outputs)).toBe(true);
  });
});
