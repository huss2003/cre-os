import { describe, expect, it, vi } from "vitest";
import { ruleExtract } from "./extract";
import { codeFirstLeaseTerms, finaliseTerms, heuristicTerms, leaseTermsAccept, type ModelTerms } from "@/modules/assistant/documents/lease-terms";
import { quoteAccept, regexExtract, inrAmount } from "@/modules/toolkit/quote-intake";
import { extractClauses } from "@/modules/intelligence/legal/clauses";
import { runWithPolicy } from "@/lib/ai/policy";
import { captureAccept } from "./service";

vi.mock("@/lib/ai/gateway", () => ({ callStructured: vi.fn(), transcribe: vi.fn(), extractImageText: vi.fn(), AiUnavailableError: class extends Error {} }));

const SRC = { sourceAt: "2026-11-11T05:00:00Z", timezone: "Asia/Kolkata" };
const fact = (t: string, field: string) => ruleExtract(t, SRC).facts.find((f) => f.field === field);

describe("capture rule extractor — amounts, areas, dates (code first)", () => {
  it.each([
    ["Need 20,000 sq ft in Baner", "area_target_sf", 20000, "sf"],
    ["Looking for 12500 sqft office", "area_target_sf", 12500, "sf"],
    ["about 15k sf of carpet", "area_target_sf", 15000, "sf"],
    ["Budget ₹85 per sq ft", "budget_max", 85, "INR/sf/month"],
    ["budget Rs 9,000 per seat", "budget_max", 9000, "INR/seat/month"],
    ["need 150 seats", "seats_target", 150, "seats"],
  ])("%s", (text, field, value, unit) => {
    const f = fact(text, field)!;
    expect(f).toBeTruthy();
    expect(f.proposed_value).toBe(value);
    expect(f.unit).toBe(unit);
  });
  it("bare '2 lakh' never assumes a unit (asks)", () => {
    const ex = ruleExtract("They said 2 lakh", SRC);
    expect(ex.ambiguities.some((a) => a.kind === "unit")).toBe(true);
    expect(ex.facts[0].unit).toBeNull();
  });
  it("'by Friday' becomes a task with a date question; 'by March 2027' a dated fact", () => {
    const ex = ruleExtract("Send options by Friday. Occupation by March 2027.", SRC);
    expect(ex.tasks[0].due_date).toMatch(/^2026-11-1\d$/);
    expect(ex.ambiguities.some((a) => a.kind === "date")).toBe(true);
    expect(ex.facts.find((f) => f.field === "occupation_date")?.proposed_value).toBe("2027-03-31");
  });
  it("accept(): content found → no AI; empty chatter → AI may help", () => {
    expect(captureAccept(ruleExtract("Need 20,000 sq ft in Baner", SRC))).toBe(true);
    expect(captureAccept(ruleExtract("ok", SRC))).toBe(false);
  });
});

const LEASE = [
  `LEAVE AND LICENSE AGREEMENT between Acme Realty Pvt Ltd (Lessor) and Zenith Labs Pvt Ltd (Lessee).
Premises: Unit 501, 5th floor, Tower B, EON Free Zone, Kharadi.
Chargeable area 12,500 sq ft (carpet 9,000 sq ft).
Rent: Rs 85 per sq ft per month on chargeable area.
CAM: Rs 15 per sq ft per month.
Security deposit: 6 months.`,
  `The lock-in period is 36 months from the commencement date.
Escalation of 15% every 3 years on the then prevailing rent.
Commencement date: 01/04/2027.
Rent-free period of 3 months for fit-out.
Notice period of 6 months.`,
];

describe("lease terms — patterns first", () => {
  const terms = finaliseTerms(heuristicTerms(LEASE), LEASE);
  const get = (f: string) => terms.find((t) => t.field === f)!;
  it("reads rent, area basis, CAM, deposit, lock-in, escalation, dates with page refs", () => {
    expect(get("rent").normalised).toEqual({ kind: "money", amount: "85", unit: "per_sf_per_month" });
    expect(get("area").normalised).toMatchObject({ kind: "area", sf: "12500", basis: "chargeable" });
    expect(get("cam").normalised).toMatchObject({ amount: "15", unit: "per_sf_per_month" });
    expect(get("deposit").normalised).toMatchObject({ months: 6 });
    expect(get("lock_in")).toMatchObject({ page: 2, normalised: { months: 36 } });
    expect(get("escalation").normalised).toEqual({ kind: "percent", percent: "15", everyMonths: 36 });
    expect(get("start_date").normalised).toEqual({ kind: "date", iso: "2027-04-01" });
    expect(get("notice").normalised).toEqual({ kind: "months", months: 6 });
    expect(get("fit_out").snippet).toMatch(/Rent-free period of 3 months/);
    expect(leaseTermsAccept(terms)).toBe(true);
  });
  it("policy: off never calls AI; backup calls AI only when rent/area are missing; on calls AI", async () => {
    const ai = vi.fn(async () => ({ data: { fields: [] } as ModelTerms, model: "m", mocked: false }));
    expect((await codeFirstLeaseTerms(LEASE, "off", ai)).source).toBe("code");
    expect((await codeFirstLeaseTerms(LEASE, "backup", ai)).source).toBe("code");
    expect(ai).not.toHaveBeenCalled();
    const thin = ["The tenant shall pay rent as agreed separately."];
    expect((await codeFirstLeaseTerms(thin, "off", ai)).source).toBe("code");
    expect(ai).not.toHaveBeenCalled();
    const r = await codeFirstLeaseTerms(thin, "backup", ai);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(r.source).toBe("ai");
    await codeFirstLeaseTerms(LEASE, "on", ai);
    expect(ai).toHaveBeenCalledTimes(2);
  });
  it("AI that fails falls back to code (backup)", async () => {
    const r = await codeFirstLeaseTerms(["Rent payable monthly."], "backup", async () => { throw new Error("down"); });
    expect(r.source).toBe("code");
  });
});

describe("quote intake — prose quotes and money units", () => {
  it("lakh/crore multipliers only when written", () => {
    expect(inrAmount("Rs 2.5 lakh per month")).toBe(250000);
    expect(inrAmount("₹1.2 crore")).toBe(12000000);
    expect(inrAmount("Rs 85 per sq ft")).toBe(85);
  });
  it("reads a prose quote without Label: lines", () => {
    const t = regexExtract("Dear Sir, we are pleased to offer the space. The monthly rent is Rs 92 per sq ft per month on carpet area. A security deposit of six (6) months is payable. The lock-in is 3 years. Rent shall escalate by 15% every 3 years. CAM is Rs 18 per sq ft per month extra. Offer valid till 30/11/2026.");
    expect(t).toMatchObject({ rent: 92, rent_basis: "carpet", rent_periodicity: "monthly", deposit_months: 6, lockin_months: 36, escalation_pct: 15, escalation_every_months: 36, cam_per_sf: 18, cam_included: false, valid_until: "2026-11-30" });
    expect(quoteAccept(t)).toBe(true);
  });
  it("accept fails (→ AI if mode allows) when rent can't be read", () => {
    expect(quoteAccept(regexExtract("Please find our best terms attached."))).toBe(false);
  });
});

describe("legal clauses — headings and keywords", () => {
  it("finds core clauses without AI", () => {
    const c = extractClauses("1. Rent\nRs 85 per sq ft per month.\n2. Lock-in\n36 months.\n3. Escalation\n15% every 3 years.\n4. Notice\nSix months written notice.");
    const types = c.map((x) => x.clause_type);
    expect(types).toEqual(expect.arrayContaining(["rent", "lock_in", "escalation", "notice"]));
  });
});

describe("runWithPolicy contract used by every group-2 feature", () => {
  it("off → never AI; backup → AI only when accept fails", async () => {
    const ai = vi.fn(async () => "ai");
    expect(await runWithPolicy({ mode: "off", code: () => null, ai })).toMatchObject({ source: "none" });
    expect(await runWithPolicy({ mode: "backup", code: () => "x", ai, accept: () => true })).toMatchObject({ source: "code" });
    expect(ai).not.toHaveBeenCalled();
    expect(await runWithPolicy({ mode: "backup", code: () => "x", ai, accept: () => false })).toMatchObject({ source: "ai" });
  });
});
