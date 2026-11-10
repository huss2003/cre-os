import { describe, expect, it } from "vitest";
import { compareConventionalManaged, type CvmInput } from "./managed";

const base = (): CvmInput => ({
  comparisonMonths: 36, headcount: 110,
  conventional: { rentRate: 100, rentBasis: "chargeable", chargeableSf: 10000, carpetSf: 7500, seats: 100, camRate: 15, camBasis: "chargeable",
    deposit: 6000000, fitout: 5000000, furniture: 1000000, it: 500000, restoration: 500000, utilitiesMonthly: 50000, housekeepingMonthly: 20000,
    maintenanceMonthly: 10000, parkingMonthly: 0, otherServicesMonthly: 0, tenureMonths: 36, escalation: { pct: 0, everyMonths: 12 }, monthsToOccupy: 4, control: 5 },
  managed: { perSeatPrice: 12000, seats: 100, contractMonths: 36, included: ["utilities", "housekeeping", "maintenance", "internet", "furniture", "reception", "security"],
    internetMonthly: "", utilitiesMonthly: 50000, housekeepingMonthly: "", receptionMonthly: "", securityMonthly: "", maintenanceMonthly: "",
    furniture: "", deposit: 3600000, setup: 100000, addOnsMonthly: 20000, escalation: { pct: 0, everyMonths: 12 }, monthsToOccupy: 1, control: 3 },
});

describe("cvm-1.0 conventional vs managed (hand-computed)", () => {
  it("normalises both options", () => {
    const r = compareConventionalManaged(base());
    const c = r.conventional!, m = r.managed!;
    // conv: rent 100×10,000 = 1,000,000; CAM 15×10,000 = 150,000; +50k+20k+10k = 1,230,000/month
    expect(c.month1Monthly).toBe("1230000.00");
    expect(c.recurringTotal).toBe("44280000.00"); // ×36
    expect(c.oneOffTotal).toBe("7000000.00"); // 5M+1M+0.5M+0.5M
    expect(c.totalCommitment).toBe("51280000.00");
    expect(c.effectiveMonthly).toBe("1424444.44");
    expect(c.costPerSeat).toBe("14244.44");
    expect(c.costPerEmployee).toBe("12949.49"); // 1,424,444.44/110
    expect(c.initialCashExDeposit).toBe("8230000.00");
    expect(c.initialCashInclDeposit).toBe("14230000.00");
    expect(c.fitoutInvestment).toBe("6500000.00"); // restoration excluded
    // managed: 12,000×100 + add-ons 20,000 = 1,220,000; setup 100,000
    expect(m.month1Monthly).toBe("1220000.00");
    expect(m.totalCommitment).toBe("44020000.00");
    expect(m.costPerSeat).toBe("12227.78");
    expect(m.refundableDeposit).toBe("3600000.00");
  });
  it("prevents double counting of included services", () => {
    const r = compareConventionalManaged(base());
    expect(r.warnings.join(" ")).toMatch(/Utilities is included.*excluded/);
    expect(r.managed!.lines.find((l) => l.status === "excluded_double_count")?.label).toMatch(/Utilities/);
    expect(r.managed!.month1Monthly).toBe("1220000.00"); // 50,000 NOT added
  });
  it("applies step escalation", () => {
    const i = base(); i.conventional.escalation = { pct: 5, everyMonths: 12 };
    // (1,150,000×12)×(1+1.05+1.1025) = 43,504,500 + 80,000×36 = 2,880,000
    expect(compareConventionalManaged(i).conventional!.recurringTotal).toBe("46384500.00");
  });
  it("unknown is not zero: blanks listed, totals flagged incomplete", () => {
    const i = base(); i.conventional.fitout = ""; i.managed.included = [];
    const r = compareConventionalManaged(i);
    expect(r.conventional!.complete).toBe(false);
    expect(r.missing).toContain("Conventional: fit-out");
    expect(r.missing.some((x) => x.startsWith("Managed: internet"))).toBe(true);
    const j = base(); j.conventional.rentRate = null;
    const r2 = compareConventionalManaged(j);
    expect(r2.ok).toBe(false); expect(r2.conventional).toBeNull(); expect(r2.recommendation.preferred).toBeNull();
  });
  it("does not automatically prefer the cheapest", () => {
    const i = base(); i.weights = { cost: 10, flexibility: 0, commitment: 0, speed: 0, control: 90 };
    const r = compareConventionalManaged(i);
    expect(Number(r.managed!.totalCommitment)).toBeLessThan(Number(r.conventional!.totalCommitment));
    expect(r.recommendation.preferred).toBe("conventional");
    expect(r.recommendation.text).toMatch(/despite costing more/);
    // conv = (10×44,020,001/51,280,001 + 90×1)/100
    expect(r.weightedScore!.conventional).toBe("0.9858");
    expect(r.weightedScore!.managed).toBe("0.6400");
  });
  it("is deterministic", () => {
    expect(JSON.stringify(compareConventionalManaged(base()))).toBe(JSON.stringify(compareConventionalManaged(base())));
  });
});
