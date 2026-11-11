import { describe, it, expect } from "vitest";
import { checkValue, findInputProblem, assertValidInputs, kindForKey, kindForUnit, parseFormNumber, InputRangeError } from "./validate";
import { computeBts, type BtsInput } from "./bts";
import { computeInvestment } from "./investment";
import { computeLoan } from "./financing";
import { compareConventionalManaged } from "./managed";
import { leaseEconomics, type LeaseTerms } from "./lease";
import { btsFromForm, investmentFromForm } from "../models-service";

describe("toolkit input validators", () => {
  it("blank is unknown, never an error", () => {
    for (const v of [null, undefined, "", "  "]) expect(checkValue(v, "percent", "Escalation")).toBeNull();
  });
  it("percent bounds and message", () => {
    expect(checkValue("15", "percent", "Escalation")).toBeNull();
    expect(checkValue("100", "percent", "Escalation")).toBeNull();
    expect(checkValue("150", "percent", "Escalation")).toBe("Escalation must be between 0 and 100 %");
    expect(checkValue(-1, "percent", "Discount rate")).toMatch(/between 0 and 100 %/);
  });
  it("rejects NaN, Infinity, exponent overflow and junk", () => {
    expect(checkValue("5e66", "percent", "Escalation")).toMatch(/plain number/);
    expect(checkValue(5e66, "percent", "Escalation")).toMatch(/between 0 and 100/);
    expect(checkValue("Infinity", "money", "Deposit")).toMatch(/real number/);
    expect(checkValue(Number.NaN, "money", "Deposit")).toMatch(/real number/);
    expect(checkValue(Number.POSITIVE_INFINITY, "money", "Deposit")).toMatch(/real number/);
    expect(checkValue("12abc", "money", "Deposit")).toMatch(/must be a number/);
  });
  it("other field types: months, years, area, rent/sf, money, counts", () => {
    expect(checkValue("601", "months", "Tenure")).toMatch(/0 and 600 months/);
    expect(checkValue("60", "months", "Tenure")).toBeNull();
    expect(checkValue("51", "years", "Holding period")).toMatch(/0 and 50 years/);
    expect(checkValue("0", "area", "Area")).toMatch(/1 and/);
    expect(checkValue("10,000,001", "area", "Area")).toMatch(/sf$/);
    expect(checkValue("1,00,000", "rentPerSf", "Rent")).toBeNull();
    expect(checkValue("100001", "rentPerSf", "Rent")).toMatch(/₹\/sf/);
    expect(checkValue("1000000000001", "money", "Price")).toMatch(/₹$/);
    expect(checkValue("2.5", "count", "Seats")).toMatch(/whole number/);
    expect(checkValue("-1", "count", "Seats")).toMatch(/between 0/);
    expect(checkValue("-5000", "signedMoney", "Deposit change")).toBeNull();
  });
  it("classifies keys and units", () => {
    expect(kindForKey("escalationPct")).toBe("percent");
    expect(kindForKey("tenureMonths")).toBe("months");
    expect(kindForKey("holdingYears")).toBe("years");
    expect(kindForKey("areaSf")).toBe("area");
    expect(kindForKey("rentPerSfMonth")).toBe("rentPerSf");
    expect(kindForKey("purchasePrice")).toBe("money");
    expect(kindForKey("seats")).toBe("count");
    expect(kindForKey("name")).toBeNull();
    expect(kindForUnit("% per year")).toBe("percent");
    expect(kindForUnit("₹/SF/month")).toBe("rentPerSf");
    expect(kindForUnit("₹/month")).toBe("money");
    expect(kindForUnit("months of rent")).toBe("months");
    expect(kindForUnit("1–5")).toBeNull();
  });
  it("walks nested input; free text on text keys is ignored", () => {
    expect(findInputProblem({ name: "Tower B", restoration: "Bare shell", escalation: { pct: "15", everyMonths: "12" } })).toBeNull();
    expect(findInputProblem({ escalation: { pct: "5e66" } })).toMatchObject({ field: "escalation.pct" });
    expect(findInputProblem({ drawSchedulePct: ["50", "120"] })).toMatchObject({ field: "drawSchedulePct.1" });
    expect(() => assertValidInputs({ escalationPct: 500 }, "Offer 1: ")).toThrow("Offer 1: Escalation must be between 0 and 100 %");
    expect(parseFormNumber(" 1,200 ", "area", "Area")).toBe(1200);
    expect(parseFormNumber("", "area", "Area")).toBeNull();
    expect(() => parseFormNumber("1e9", "area", "Area", "m0_area")).toThrow(InputRangeError);
  });
});

const lease: LeaseTerms = { name: "A", label: "quoted", areaSf: 10000, areaBasis: "chargeable", rentPerSf: 100, leaseCommencement: "2027-01-01", tenureMonths: 60, escalationPct: 15, escalationEveryMonths: 36, discountRatePct: 10 };

describe("calculators refuse impossible inputs instead of computing", () => {
  it("lease economics: absurd escalation stops the run with a clear message", () => {
    expect(() => leaseEconomics({ ...lease, escalationPct: "5e66" })).toThrow(/Escalation must be written as a plain number/);
    expect(() => leaseEconomics({ ...lease, escalationPct: 5e66 })).toThrow("A: Escalation must be between 0 and 100 %");
    expect(() => leaseEconomics({ ...lease, escalationPct: null })).not.toThrow(); // blank = unknown
  });
  it("financing, managed, investment", () => {
    expect(() => computeLoan({ financedAmount: 1e7, annualRatePct: 400, tenureMonths: 36 })).toThrow(/Interest rate must be between 0 and 100 %/);
    expect(() => computeLoan({ financedAmount: 1e7, annualRatePct: 10, tenureMonths: 6000 })).toThrow(/Tenure must be between 0 and 600 months/);
    expect(() => compareConventionalManaged({ conventional: { escalation: { pct: "250", everyMonths: "12" } } as never, managed: {} as never })).toThrow(/between 0 and 100 %/);
    expect(() => computeInvestment({ holdingYears: 80, tenancies: [] } as never)).toThrow(/Holding period must be between 0 and 50 years/);
  });
});

describe("form path: BTS / investment forms → validators", () => {
  const form = (v: Record<string, string>) => (k: string) => (v[k] ?? "").trim() || null;
  const ok = { areaSf: "100000", areaBasis: "built_up", constructionCostPerSf: "3000", softCostPct: "10", constructionMonths: "12", mode: "yield", yieldOnCostPct: "9", leaseTermMonths: "120", escalationPct: "15", escalationEveryMonths: "36", rentFreeMonths: "0", depositMonths: "6", tenantFitout: "0", discountRatePct: "10" };
  it("valid BTS form computes; impossible escalation is refused with the field message", () => {
    expect(() => computeBts(btsFromForm(form(ok)) as BtsInput)).not.toThrow();
    expect(() => computeBts(btsFromForm(form({ ...ok, escalationPct: "5e66" })))).toThrow(/Escalation must be written as a plain number/);
    expect(() => computeBts(btsFromForm(form({ ...ok, escalationPct: "999" })))).toThrow("Escalation must be between 0 and 100 %");
    expect(() => computeBts(btsFromForm(form({ ...ok, areaSf: "0" })))).toThrow(/Area must be between 1 and/);
    // blank stays unknown
    expect(() => computeBts(btsFromForm(form({ ...ok, escalationPct: "" })))).not.toThrow();
  });
  it("investment tenancy rows are checked too", () => {
    expect(() => computeInvestment(investmentFromForm(form({ purchasePrice: "1000000000", t0_name: "T1", t0_areaSf: "1000", t0_escalationPct: "300" })))).toThrow(/Escalation must be between 0 and 100 %/);
  });
});
