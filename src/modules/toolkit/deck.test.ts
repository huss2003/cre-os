import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { DEFAULT_BRAND } from "@/modules/deals/documents/model";
import { buildAnalysisDeck, chartOf, deckModel } from "./deck";
import { computeBts } from "./calc/bts";
import { computeInvestment } from "./calc/investment";

async function parts(buf: Buffer) {
  expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  const z = await JSZip.loadAsync(buf);
  const names = Object.keys(z.files);
  const read = async (re: RegExp) => (await Promise.all(names.filter((n) => re.test(n)).map((n) => z.file(n)!.async("string")))).join("\n");
  return { names, read };
}

describe("analysis deck (deck-1.0)", () => {
  it("unknown values are never charted as zero", () => {
    const c = chartOf("NPV", "₹", [["A", "100"], ["B", null], ["C", "50.5"]])!;
    expect(c.labels).toEqual(["A", "C"]);
    expect(c.series[0].values).toEqual([100, 50.5]);
    expect(c.note).toMatch(/B/);
    expect(chartOf("x", "₹", [["A", null]])).toBeNull();
  });

  it("property comparison → valid PPTX with native charts, options table, missing info and labels", async () => {
    const m = deckModel({ kind: "property_comparison", title: "Kharadi shortlist", status: "needs_info", missing: ["Budget"], version: 3, formula_version: "rating-1.0",
      inputs: { assetIds: ["a"] }, outputs: { properties: [{ name: "EON Tower B", rank: 1, score: 82, occupancyCost: "101000", eligibility: "eligible", evidence: "quoted" }, { name: "WTC 2", rank: 2, score: 70, occupancyCost: null, eligibility: "unconfirmed", evidence: "estimated" }], recommendation: { explanation: "EON Tower B ranks first." } },
      requirementTitle: "Acme Pune" }, DEFAULT_BRAND, "Neutral layout (no workspace template configured)", "2026-11-11T00:00:00Z");
    const { names, read } = await parts(await buildAnalysisDeck(m));
    expect(names.filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).length).toBe(2);
    const xml = await read(/^ppt\/slides\/slide\d+\.xml$/);
    for (const s of ["Executive recommendation", "EON Tower B ranks first.", "Options", "Missing information", "Budget", "Sources", "Appendix", "MISSING INFO", "Neutral layout"]) expect(xml).toContain(s);
    const charts = await read(/^ppt\/charts\/chart\d+\.xml$/);
    expect(charts).toContain("101000");
  });

  it("BTS and investment analyses produce decks with their charts", async () => {
    const bts = computeBts({ land: { mode: "purchase", cost: 1e7 }, areaSf: 1e5, areaBasis: "built_up", constructionCostPerSf: 3000, softCostPct: 10, constructionMonths: 12, mode: "yield", yieldOnCostPct: 9, leaseTermMonths: 24, escalationPct: 5, escalationEveryMonths: 12, rentFreeMonths: 2, depositMonths: 6, tenantFitout: 5e6, discountRatePct: 10 });
    const b = deckModel({ kind: "bts", title: "BTS Chakan", status: "ready", missing: [], version: 1, formula_version: "bts-1.0", inputs: {}, outputs: bts }, DEFAULT_BRAND, "Neutral", "2026-11-11T00:00:00Z");
    expect(b.charts.map((c) => c.title)).toEqual(["Project cost breakdown", "Rent paid by lease year"]);
    const bx = await parts(await buildAnalysisDeck(b));
    expect(await bx.read(/^ppt\/slides\/slide\d+\.xml$/)).toContain("Required rent");

    const inv = computeInvestment({ purchasePrice: 1.2e6, stampDutyPct: 0, otherAcquisitionCosts: 0, leasableAreaSf: 1000, areaBasis: "leasable", tenancies: [{ name: "A", areaSf: 1000, rentPerSfMonth: 10, escalationPct: 0, escalationEveryMonths: 12, expiryMonth: 120, downtimeMonths: 0, reletRentPerSfMonth: 10, camRecoveryPerSfMonth: 0 }], opexPerSfMonth: 0, opexEscalationPct: 0, capexReservePerSfYear: 0, holdingYears: 5, exitCapRatePct: 10, saleCostsPct: 0, discountRatePct: 10 });
    const im = deckModel({ kind: "investment", title: "Office yield play", status: "ready", missing: [], version: 1, formula_version: "inv-1.0", inputs: { discountRatePct: 10 }, outputs: inv }, DEFAULT_BRAND, "Neutral", "2026-11-11T00:00:00Z");
    expect(im.recommendation[0]).toContain("10.0000%");
    const ix = await parts(await buildAnalysisDeck(im));
    expect(ix.names.filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).length).toBe(2);
    expect(await ix.read(/^ppt\/slides\/slide\d+\.xml$/)).toContain("Sensitivities");
  });
});
