import { describe, it, expect } from "vitest";
import { computeFitout, compareQuotes } from "./fitout";

describe("fitout-1.0 budget", () => {
  const r = computeFitout({
    areaSf: 10000, seats: 100,
    lines: [
      { category: "civil", quantity: 10000, unitPrice: 150, taxPct: 18, approved: 1450000, actual: 1500000 }, // est derived 15,00,000
      { category: "furniture", estimated: 2000000, taxPct: 12, approved: 1900000 },
      { category: "it", estimated: "NA", taxPct: 18, approved: 500000 },
      { category: "hvac", estimated: 1000000 }, // tax unknown
    ],
  });
  it("derives estimated from qty × unit price and keeps unknowns unknown", () => {
    expect(r.lines[0].estimatedSource).toBe("derived");
    expect(r.lines[2].estimated.net).toBeNull();
    expect(r.lines[3].estimated.tax).toBeNull();
  });
  it("totals with explicit tax (hand-computed)", () => {
    // est net 15,00,000 + 20,00,000 + 10,00,000 = 45,00,000; tax 2,70,000 + 2,40,000 (+ HVAC unknown) = 5,10,000
    expect(r.totals.estimated).toMatchObject({ net: "4500000.00", tax: "510000.00", gross: "5010000.00", lines: 3, unknownLines: 1, unknownTaxLines: 1 });
    // approved: 14,50,000×1.18 + 19,00,000×1.12 + 5,00,000×1.18 = 17,11,000 + 21,28,000 + 5,90,000
    expect(r.totals.approved.gross).toBe("4429000.00");
    expect(r.totals.actual.gross).toBe("1770000.00");
    expect(r.variance.approvedVsEstimated).toBe("-581000.00");
    expect(r.perSf.estimated).toBe("501.00");
    expect(r.perSeat.approved).toBe("44290.00");
    expect(r.byCategory.find((c) => c.category === "civil")!.estimated.gross).toBe("1770000.00");
    expect(r.missing.some((m) => m.includes("Line 4"))).toBe(true);
  });
});

describe("fitout-1.0 quotation comparison", () => {
  const quotes = [
    { partnerName: "Jasfo", scope: ["civil", "flooring"] as const, price: 1000000, taxPct: 18, deliveryWeeks: 10, warrantyMonths: 12, validUntil: "2026-12-31" },
    { partnerName: "Acme Interiors", scope: ["civil", "flooring", "ceiling"] as const, price: 1100000, taxPct: 18, deliveryWeeks: 8, warrantyMonths: 24, validUntil: "2026-10-01", exclusions: ["Loose furniture"] },
    { partnerName: "B Build", scope: ["civil"] as const, price: 900000, deliveryWeeks: 12, warrantyMonths: 12, validUntil: "2026-12-01" },
  ].map((q) => ({ ...q, scope: [...q.scope] }));
  const res = compareQuotes({ quotes, requiredScope: ["civil", "flooring", "ceiling"], asOf: "2026-11-10" });
  it("flags expired, scope gaps, missing tax", () => {
    expect(res.rows[1].expired).toBe(true);
    expect(res.rows[1].flags[0]).toMatch(/EXPIRED/);
    expect(res.rows[0].scopeGaps).toEqual(["ceiling"]);
    expect(res.rows[2].priceInclTax).toBeNull();
    expect(res.rows[2].flags.join()).toMatch(/Tax % not stated/);
  });
  it("ranks transparently with the same process for every partner", () => {
    // Jasfo: 40×1 + 30×(2/3) + 15×0.8 + 15×0.5 = 79.5 ; Acme: 40×(11.8/12.98) + 30 + 15 + 15 = 96.36
    expect(res.rows[0].scores.total).toBe("79.50");
    expect(res.rows[1].scores.total).toBe("96.36");
    expect(res.rows[1].rank).toBe(1);
    const renamed = compareQuotes({ quotes: quotes.map((q) => ({ ...q, partnerName: q.partnerName === "Jasfo" ? "Other Co" : q.partnerName })), requiredScope: ["civil", "flooring", "ceiling"], asOf: "2026-11-10" });
    expect(renamed.rows[0].scores.total).toBe("79.50"); // name never changes the score
  });
  it("preferred requires a typed reason", () => {
    expect(() => compareQuotes({ quotes, requiredScope: ["civil"], asOf: "2026-11-10", preferredIndex: 0 })).toThrow(/reason/);
    const ok = compareQuotes({ quotes, requiredScope: ["civil"], asOf: "2026-11-10", preferredIndex: 0, preferredReason: "Existing relationship and site familiarity" });
    expect(ok.preferred?.index).toBe(0);
  });
});
