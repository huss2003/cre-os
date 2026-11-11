/**
 * Journey STAGE 7 — Module 8 Deal Toolkit (docs/journey/TEST_PLAN.txt cases 8.1–8.11).
 * Service-level (no browser). Synthetic ABC Technologies requirement + Properties A/B/C, WS1 as owner, tagged fixtures.
 * Expected numbers are recomputed independently here with decimal.js — never copied from the calculators.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Decimal from "decimal.js";
import JSZip from "jszip";
import { USERS, WS1, tag, userClient } from "../helpers";
import type { Db } from "@/lib/supabase/server";
import type { DealsCtx } from "@/modules/deals/ctx";
import { createRequirement, addStakeholder } from "@/modules/deals/requirements/service";
import { loadBriefFor, generateDeliverables, downloadDeliverable } from "@/modules/toolkit/deliverables";
import { leaseEconomics, compareLeaseOffers, occupancyEconomics, type LeaseTerms } from "@/modules/toolkit/calc/lease";
import { rateProperties, DEFAULT_MODEL, type RatingProperty, type RatingRequirement } from "@/modules/toolkit/calc/rating";
import { compareConventionalManaged } from "@/modules/toolkit/calc/managed";
import { compareRenewalRelocation } from "@/modules/toolkit/calc/renewal";
import { analyseNegotiation, appendOffer, type OfferTerms, type OfferVersion } from "@/modules/toolkit/calc/negotiation";
import { runComparison } from "@/modules/toolkit/comparison";
import { runLeaseEconomics, createNegotiation, addOffer, loadNegotiation } from "@/modules/toolkit/lease-service";
import { getVersion } from "@/modules/toolkit/store";
import { generateDeck } from "@/modules/toolkit/deck";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const T = tag("m8");
let db: Db; let ctx: DealsCtx; let reqId = ""; let geoId = "";

// ------------------------------------------------------------------ synthetic properties (plan 8.3–8.6)
const PROPS = {
  A: { area: 25000, rent: 100, cam: 12, depMonths: 6, escPct: 15, rf: 2 },
  B: { area: 28000, rent: 95, cam: 10, depMonths: 6, escPct: 12, rf: 3 },
  C: { area: 24000, rent: 110, cam: 8, depMonths: 4, escPct: 15, rf: 1 },
} as const;
type K = keyof typeof PROPS;
const terms = (k: K, over: Partial<LeaseTerms> = {}): LeaseTerms => ({
  name: `Property ${k}`, label: "quoted", areaSf: PROPS[k].area, areaBasis: "chargeable", rentPerSf: PROPS[k].rent,
  leaseCommencement: "2027-08-01", tenureMonths: 60, rentFreeMonths: PROPS[k].rf, escalationPct: PROPS[k].escPct, escalationEveryMonths: 36,
  camPerSf: PROPS[k].cam, depositMonths: PROPS[k].depMonths, parkingSlots: null, otherRecurringState: "unknown",
  gst: { treatment: "included" }, discountRatePct: 12, ...over,
});

/** Independent expectation: rent month L (1..60), escalation every 36 months, rent-free months zero. */
function expRentMonth(k: K, L: number, rf: number = PROPS[k].rf, rate: number = PROPS[k].rent, esc: number = PROPS[k].escPct) {
  if (L <= rf) return new D(0);
  const steps = Math.floor((L - 1) / 36);
  return new D(PROPS[k].area).times(rate).times(new D(1).plus(new D(esc).div(100)).pow(steps));
}
const sumRent = (k: K, from: number, to: number, rf?: number, rate?: number, esc?: number) => {
  let s = new D(0); for (let L = from; L <= to; L++) s = s.plus(expRentMonth(k, L, rf, rate, esc)); return s;
};
const f2 = (x: Decimal) => x.toFixed(2);

beforeAll(async () => {
  db = await userClient("owner");
  ctx = { db, workspaceId: WS1, userId: USERS.owner.id, role: "owner" };
  const g = await db.from("geography").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, level: "locality", name: `Kharadi ${T}`, aliases: [] }).select("id").single();
  if (g.error) throw g.error;
  geoId = g.data.id;
});

// ================================================================== 8.1
describe("8.1 Generate requirement brief (ABC Technologies)", () => {
  it("brief carries company, 25,000 SF, Kharadi, 9-month occupancy, 5-year tenure, budget unconfirmed, finance approval, missing details", async () => {
    const r = await createRequirement(ctx, {
      title: `ABC Technologies office ${T}`, orgName: `ABC Technologies ${T}`,
      changes: [
        { key: "objective", value: "relocation", status: "reported" },
        { key: "area", value: [24000, 25000, 28000], status: "reported" },
        { key: "area_basis", value: "chargeable", status: "reported" },
        { key: "preferred_locations", value: [geoId], status: "reported" },
        { key: "occupation_date", value: "2027-08-11", status: "reported" }, // 9 months from 2026-11-11
        { key: "tenure_months", value: 60, status: "reported" },
        { key: "budget", value: [90, 105], status: "estimated" },
        { key: "budget_basis", value: "per_sf_month", status: "estimated" },
        { key: "commercial_authority", value: "CFO — finance approval required before LOI", status: "reported" },
      ],
    }) as { id: string };
    reqId = r.id;
    await addStakeholder(ctx, reqId, { personName: `Finance Head ${T}`, role: "finance" });
    const brief = await loadBriefFor(db, WS1, reqId);
    const f = (k: string) => brief.sections.flatMap((s) => s.fields).find((x) => x.key === k)!;
    expect(brief.organisation).toBe(`ABC Technologies ${T}`);
    expect(f("area").value).toContain("target: 25,000");
    expect(f("preferred_locations").value).toBe(`Kharadi ${T}`);
    expect(f("occupation_date").value).toBe("2027-08-11");
    expect(f("tenure_months").value).toBe("60");
    expect(f("budget").status).not.toBe("Confirmed");
    expect(f("budget").status).toBe("Estimated");
    expect(f("commercial_authority").value).toMatch(/finance approval/);
    expect(brief.stakeholders.find((s) => s.slot === "Financial approver")!.people).toEqual([`Finance Head ${T}`]);
    expect(brief.missing.length).toBeGreaterThan(0);
    expect(brief.missing).toEqual(expect.arrayContaining(["Decision date", "Contracting legal entity"]));
    expect(brief.openQuestions.length).toBeGreaterThan(0);
  });
});

// ================================================================== 8.2
const ratingProps = (overA: Partial<RatingProperty> = {}): RatingProperty[] => [
  { key: "A", name: "Property A", source: "manual", microMarket: `Kharadi ${T}`, grade: "A", areaSf: 25000, areaBasis: "chargeable", rent: 100, rentBasis: "chargeable", cam: 12, depositMonths: 6, rentFreeMonths: 2, escalationPct: 15, escalationEveryMonths: 36, metroKm: 1.2, amenities: ["cafeteria", "gym"], evidence: "quoted", ...overA },
  { key: "B", name: "Property B", source: "manual", microMarket: `Kharadi ${T}`, grade: "A", areaSf: 28000, areaBasis: "chargeable", rent: 95, rentBasis: "chargeable", cam: 10, depositMonths: 6, rentFreeMonths: 3, escalationPct: 12, escalationEveryMonths: 36, metroKm: 2.5, amenities: ["cafeteria"], evidence: "quoted" },
  { key: "C", name: "Property C", source: "manual", microMarket: `Kharadi ${T}`, grade: "A+", areaSf: 24000, areaBasis: "chargeable", rent: 110, rentBasis: "chargeable", cam: 8, depositMonths: 4, rentFreeMonths: 1, escalationPct: 15, escalationEveryMonths: 36, metroKm: null, amenities: null, evidence: "quoted" },
];
const ratingReq: RatingRequirement = { title: "ABC", areaMinSf: 24000, areaTargetSf: 25000, areaMaxSf: 28000, areaBasis: "chargeable", budgetMax: null, microMarkets: [`Kharadi ${T}`], termMonths: 60 };

describe("8.2 Compare properties A, B, C", () => {
  it("rates all three with configured weights, advantages, shortcomings, missing info", () => {
    const r = rateProperties(DEFAULT_MODEL, ratingReq, ratingProps(), { asOf: "2026-11-11" });
    expect(r.properties.map((p) => p.name).sort()).toEqual(["Property A", "Property B", "Property C"]);
    for (const p of r.properties) {
      expect(p.factors.map((x) => [x.key, x.weight])).toEqual(DEFAULT_MODEL.factors.map((x) => [x.key, x.weight]));
      expect(p.score).not.toBeNull();
    }
    expect(r.properties.some((p) => p.advantages.length > 0)).toBe(true);
    expect(r.properties.some((p) => p.disadvantages.length > 0)).toBe(true);
    const c = r.properties.find((p) => p.key === "C")!;
    expect(c.missing.join(" ").toLowerCase()).toMatch(/metro|connect|amenit/);
    // budget not set → the budget rule is "not_applied", never a pass (and not a blocking "unknown" either)
    const budgetRule = r.properties[0].rules.find((x) => /budget/i.test(x.label))!;
    expect(budgetRule.outcome).not.toBe("pass");
    expect(budgetRule.outcome).toBe("not_applied");
    expect(r.recommendation.explanation.length).toBeGreaterThan(0);
  });
  it("runComparison saves the rated comparison against the requirement (RLS, owner)", async () => {
    const s = await runComparison(db, WS1, USERS.owner.id, { title: `Compare A/B/C ${T}`, requirementId: reqId, assetIds: [], manual: ratingProps(), termMonths: 60 });
    const row = (await db.from("deal_analysis").select("kind, outputs").eq("id", s.id).single()).data as { kind: string; outputs: { properties: unknown[] } };
    expect(row.kind).toBe("property_comparison");
    expect(row.outputs.properties).toHaveLength(3);
    cmpId = s.id;
    // budget on the requirement is only ESTIMATED (unconfirmed) → must not be a hard disqualifier for Property C (₹110)
    const c = (row.outputs.properties as { key: string; eligibility: string; rules: { label: string; outcome: string; detail: string }[] }[]).find((p) => p.key === "C")!;
    console.log("[8.2] C eligibility:", c.eligibility, c.rules.map((r) => `${r.label}=${r.outcome} (${r.detail})`).join("; "));
    expect(c.eligibility).not.toBe("not_eligible");
    expect(c.rules.find((r) => /budget/i.test(r.label))!.outcome).toBe("not_applied");
    const cr = c as unknown as { disadvantages: string[] };
    expect(cr.disadvantages.join(" ")).toMatch(/over the estimated budget \(unconfirmed\)/i);
    const rec = (row.outputs as unknown as { recommendation: { explanation: string } }).recommendation.explanation;
    expect(rec).not.toMatch(/excluded/i);
  });
});
let cmpId = ""; let leaseId = ""; let negoId = "";

// ================================================================== 8.3 / 8.4
describe("8.3 Lease economics + 8.4 deposits", () => {
  const exp = {
    A: { base: "2500000.00", cam: "300000.00", total: "2800000.00", dep: "15000000.00" },
    B: { base: "2660000.00", cam: "280000.00", total: "2940000.00", dep: "15960000.00" },
    C: { base: "2640000.00", cam: "192000.00", total: "2832000.00", dep: "10560000.00" },
  };
  for (const k of ["A", "B", "C"] as K[]) {
    it(`Property ${k}: monthly base rent / CAM / total and deposit`, () => {
      const p = PROPS[k];
      const base = new D(p.area).times(p.rent), cam = new D(p.area).times(p.cam);
      expect(f2(base)).toBe(exp[k].base); expect(f2(cam)).toBe(exp[k].cam); expect(f2(base.plus(cam))).toBe(exp[k].total);
      expect(f2(base.times(p.depMonths))).toBe(exp[k].dep);
      const r = leaseEconomics(terms(k));
      expect(r.monthly.baseRent).toBe(exp[k].base);
      expect(r.monthly.cam).toBe(exp[k].cam);
      expect(f2(new D(r.monthly.baseRent).plus(r.monthly.cam!))).toBe(exp[k].total);
      // first rent-paying month carries base + CAM only (parking/other unknown → not added as 0)
      const firstPaying = r.months[p.rf];
      expect(firstPaying.rent).toBe(exp[k].base);
      expect(firstPaying.cam).toBe(exp[k].cam);
      expect(firstPaying.total).toBe(exp[k].total);
      // area + rental basis visible; other charges not silently zero
      expect(r.areaSf).toBe(String(p.area)); expect(r.areaBasis).toBe("chargeable");
      expect(r.monthly.parking).toBeNull(); expect(r.monthly.other).toBeNull();
      expect(r.totals.parking).toBeNull(); expect(r.totals.other).toBeNull();
      expect(r.complete).toBe(false);
      expect(r.gaps).toEqual(expect.arrayContaining(["Parking", "Other operating costs"]));
      // 8.4 deposit: separate, refundable, not an occupancy expense
      expect(r.deposit).not.toBeNull();
      expect(r.deposit!.amount).toBe(exp[k].dep);
      expect(r.deposit!.refundable).toBe(true);
      expect(r.deposit!.refundMonth).toBe(60);
      const expenditureExDeposit = sumRent(k, 1, 60).plus(new D(p.area).times(p.cam).times(60));
      expect(r.totals.contractualExpenditure).toBe(f2(expenditureExDeposit));
    });
  }
  it("8.4 deposit assumption is visible (engine assumptions register)", () => {
    const occ = occupancyEconomics({ terms: terms("A"), extras: {} });
    const dep = occ.cashFunding.find((c) => /deposit/i.test(c.label))!;
    expect(dep.amount).toBe("15000000.00"); expect(dep.refundable).toBe(true);
  });
});

// ================================================================== 8.5
describe("8.5 Escalation every 3 years (not annual)", () => {
  for (const k of ["A", "B", "C"] as K[]) {
    it(`Property ${k}: year-wise schedule and 5-year totals`, () => {
      const r = leaseEconomics(terms(k));
      const base = new D(PROPS[k].area).times(PROPS[k].rent);
      // not annual: month 13 and 25 still at base; month 37 escalated once
      expect(r.months[12].rent).toBe(f2(base)); expect(r.months[24].rent).toBe(f2(base)); expect(r.months[35].rent).toBe(f2(base));
      expect(r.months[36].rent).toBe(f2(base.times(new D(1).plus(new D(PROPS[k].escPct).div(100)))));
      expect(r.rentSteps.map((s) => [s.fromMonth, s.toMonth, s.ratePerSf])).toEqual([
        [1, 36, String(PROPS[k].rent)], [37, 60, new D(PROPS[k].rent).times(1 + PROPS[k].escPct / 100).toString()],
      ]);
      expect(r.years).toHaveLength(5);
      for (let y = 1; y <= 5; y++) expect(r.years[y - 1].rent).toBe(f2(sumRent(k, (y - 1) * 12 + 1, y * 12)));
      expect(r.totals.rent).toBe(f2(sumRent(k, 1, 60)));
      expect(r.totals.cam).toBe(f2(new D(PROPS[k].area).times(PROPS[k].cam).times(60))); // CAM has no escalation input here
    });
  }
  it("5-year rent totals match hand figures A 15.40 cr, B 15.92808 cr, C 16.5264 cr", () => {
    expect(f2(sumRent("A", 1, 60))).toBe("154000000.00");
    expect(f2(sumRent("B", 1, 60))).toBe("159280800.00");
    expect(f2(sumRent("C", 1, 60))).toBe("165264000.00");
    const cmp = compareLeaseOffers([terms("A"), terms("B"), terms("C")]);
    expect(cmp.offers.map((o) => o.totals.rent)).toEqual(["154000000.00", "159280800.00", "165264000.00"]);
    expect(cmp.rows.map((x) => x.rank).sort()).toEqual([1, 2, 3]);
  });
});

// ================================================================== 8.6
describe("8.6 Rent-free periods", () => {
  for (const k of ["A", "B", "C"] as K[]) {
    it(`Property ${k}: ${PROPS[k].rf} rent-free months at the start only; contracted rate unchanged`, () => {
      const r = leaseEconomics(terms(k));
      const rf = PROPS[k].rf;
      const base = f2(new D(PROPS[k].area).times(PROPS[k].rent));
      for (let m = 0; m < rf; m++) expect(r.months[m].rent).toBe("0.00");
      for (let m = 0; m < rf; m++) expect(r.months[m].cam).toBe(f2(new D(PROPS[k].area).times(PROPS[k].cam))); // CAM still payable
      expect(r.months[rf].rent).toBe(base);
      expect(r.rentSteps[0].ratePerSf).toBe(String(PROPS[k].rent)); // not a permanent reduction
      expect(r.rentFreeMonths).toBe(rf);
      expect(r.rentFreeBenefit).toBe(f2(new D(base).times(rf)));
      const occ = occupancyEconomics({ terms: terms(k), extras: {} });
      expect(occ.nominalRentPerSf).toBe(new D(PROPS[k].rent).toFixed(2));
      expect(occ.effectiveRentPerSf).toBe(sumRent(k, 1, 60).div(new D(PROPS[k].area).times(60)).toFixed(2));
      expect(occ.pvEffectiveRentPerSf).not.toBeNull();
    });
  }
});

// ================================================================== 8.7
describe("8.7 Missing CAM on Property A", () => {
  it("CAM unknown, not zero; flagged; user can supply it", () => {
    const r = leaseEconomics(terms("A", { camPerSf: null }));
    expect(r.monthly.cam).toBeNull(); expect(r.totals.cam).toBeNull();
    expect(r.gaps).toContain("CAM / maintenance");
    expect(r.totalsLabel).toMatch(/Incomplete.*CAM/);
    expect(r.months[2].total).toBe("2500000.00"); // no invented CAM in the month
    const rated = rateProperties(DEFAULT_MODEL, ratingReq, ratingProps({ cam: null }), { asOf: "2026-11-11" });
    const a = rated.properties.find((p) => p.key === "A")!;
    expect(a.occupancyCost).toBeNull();
    expect([...a.missing, ...a.verification].join(" ")).toMatch(/CAM/i);
    // user confirms / adds the quotation value → restored
    expect(leaseEconomics(terms("A", { camPerSf: 12 })).monthly.cam).toBe("300000.00");
    expect(leaseEconomics(terms("A", { camPerSf: 0 })).monthly.cam).toBe("0.00"); // explicit "included" is different from unknown
  });
});

// ================================================================== 8.8
describe("8.8 Conventional (Property A) vs managed office", () => {
  it("per-seat vs per-SF normalised to monthly cost on equal capacity; included services; no double count", () => {
    const res = compareConventionalManaged({
      conventional: { rentRate: 100, rentBasis: "chargeable", chargeableSf: 25000, carpetSf: 18750, seats: 250, camRate: 12, camBasis: "chargeable",
        deposit: 15000000, fitout: 25000000, furniture: 5000000, it: 2000000, restoration: 1500000, utilitiesMonthly: 300000, housekeepingMonthly: 100000,
        maintenanceMonthly: 50000, parkingMonthly: 0, otherServicesMonthly: 0, tenureMonths: 60, lockInMonths: 36, escalation: { pct: 15, everyMonths: 36 } },
      managed: { perSeatPrice: 14000, seats: 250, contractMonths: 60, lockInMonths: 24,
        included: ["utilities", "housekeeping", "maintenance", "internet", "furniture", "reception", "security"],
        internetMonthly: null, utilitiesMonthly: 300000, housekeepingMonthly: null, receptionMonthly: null, securityMonthly: null, maintenanceMonthly: null,
        furniture: null, deposit: 10500000, setup: 500000, addOnsMonthly: 0 },
      comparisonMonths: 60, headcount: 250,
    });
    expect(res.ok).toBe(true);
    const conv = res.conventional!, man = res.managed!;
    expect(man.month1Monthly).toBe("3500000.00");
    expect(conv.month1Monthly).toBe("3250000.00");
    const convExp = new D(3250000).times(36).plus(new D(2800000).times(1.15).plus(450000).times(24)).plus(25000000 + 5000000 + 2000000 + 1500000);
    expect(conv.totalCommitment).toBe(f2(convExp));
    expect(man.totalCommitment).toBe(f2(new D(3500000).times(60).plus(500000)));
    expect(conv.costPerSeat).not.toBeNull(); expect(man.costPerSeat).not.toBeNull();
    expect(man.lines.some((l) => l.status === "excluded_double_count" && /Utilities/.test(l.label))).toBe(true);
    expect(man.lines.filter((l) => l.status === "included").length).toBeGreaterThanOrEqual(5);
    expect(res.warnings.join(" ")).toMatch(/double counting/);
    expect(res.assumptions.join(" ")).toMatch(/never compared per unit/);
    expect(res.differences.join(" ")).toMatch(/priced per seat — no sf basis/);
    expect(conv.refundableDeposit).toBe("15000000.00"); expect(man.refundableDeposit).toBe("10500000.00");
    expect(res.recommendation.text.length).toBeGreaterThan(0);
  });
});

// ================================================================== 8.9
describe("8.9 Renewal vs relocation", () => {
  it("both sides costed with assumptions and operational differences", () => {
    const res = compareRenewalRelocation({
      discountRatePct: 12, comparisonMonths: 60,
      renewal: { currentRentMonthly: 1800000, proposedRentMonthly: 2000000, escalation: { pct: 15, everyMonths: 36 }, extensionMonths: 60, rentFreeMonths: 0,
        camMonthly: 240000, depositChange: 1200000, refurbishment: 2500000, maintenanceMonthly: 0, otherMonthly: 0, otherOneOff: 0 },
      relocation: { newRentMonthly: 2500000, escalation: { pct: 15, everyMonths: 36 }, rentFreeMonths: 2, camMonthly: 300000, deposit: 15000000, oldDepositReturned: 10800000,
        fitout: 30000000, moving: 4000000, restorationOld: 3000000, overlapMonths: 2, brokerage: 2500000, itRelocation: 1500000, downtimeCost: 1000000, employeeTransition: 500000,
        otherMonthly: 0, otherOneOff: 0 },
      scores: { location: { renewal: 3, relocation: 4 }, disruption: { renewal: 5, relocation: 2 } },
    });
    expect(res.ok).toBe(true);
    let ren = new D(0), rel = new D(0);
    for (let m = 1; m <= 60; m++) {
      const f = new D(1.15).pow(Math.floor((m - 1) / 36));
      ren = ren.plus(new D(2000000).times(f)).plus(240000);
      rel = rel.plus(m <= 2 ? 0 : new D(2500000).times(f)).plus(300000).plus(m <= 2 ? 1800000 : 0);
    }
    ren = ren.plus(2500000);
    rel = rel.plus(30000000 + 4000000 + 3000000 + 2500000 + 1500000 + 1000000 + 500000);
    expect(res.renewal!.total).toBe(f2(ren));
    expect(res.relocation!.total).toBe(f2(rel));
    expect(res.difference!.cheaper).toBe(ren.lt(rel) ? "renewal" : "relocation");
    expect(res.assumptions.length).toBeGreaterThan(0);
    expect(res.renewal!.lines.some((l) => l.kind === "deposit")).toBe(true);
    expect(res.relocation!.lines.some((l) => l.kind === "deposit")).toBe(true);
    expect(res.operationallyPreferable).not.toBeNull();
    expect(res.verdict.length).toBeGreaterThan(0);
  });
});

// ================================================================== 8.10
const v = (rent: number, rf: number, esc: number): OfferTerms => ({ ...terms("A", { rentPerSf: rent, rentFreeMonths: rf, escalationPct: esc }), name: "Property A" });
describe("8.10 Negotiation — 3 offer versions on Property A", () => {
  it("pure: diffs, financial impact, most favourable identified", () => {
    let vs: OfferVersion[] = [];
    vs = appendOffer(vs, v(100, 2, 15), "2026-11-11T10:00:00Z");
    vs = appendOffer(vs, v(95, 2, 15), "2026-11-11T11:00:00Z");
    vs = appendOffer(vs, v(95, 3, 12), "2026-11-11T12:00:00Z");
    expect(vs.map((x) => x.label)).toEqual(["Offer 1 — Property A", "Offer 2 — Property A", "Offer 3 — Property A"]);
    const a = analyseNegotiation(vs);
    const expRent = [sumRent("A", 1, 60, 2, 100, 15), sumRent("A", 1, 60, 2, 95, 15), sumRent("A", 1, 60, 3, 95, 12)];
    expect(expRent.map(f2)).toEqual(["154000000.00", "146300000.00", "142215000.00"]);
    expect(a.offers.map((o) => o.rentTotal)).toEqual(expRent.map(f2));
    expect(a.diffs[1].terms.find((t) => t.key === "rentPerSf")!.status).toBe("improved");
    expect(a.diffs[2].terms.find((t) => t.key === "rentFreeMonths")!.status).toBe("improved");
    expect(a.diffs[2].terms.find((t) => t.key === "escalationPct")!.status).toBe("improved");
    expect(a.diffs[1].financial!.rentChange).toBe(f2(expRent[1].minus(expRent[0])));
    expect(a.diffs[2].financial!.rentChange).toBe(f2(expRent[2].minus(expRent[1])));
    expect(a.diffs[1].financial!.better).toBe("to"); expect(a.diffs[2].financial!.better).toBe("to");
    const best = [...a.offers].sort((x, y) => new D(x.npv).cmp(y.npv))[0];
    expect(best.no).toBe(3);
    // deposit follows the base rent of each version (6 months)
    expect(a.offers.map((o) => o.depositAmount)).toEqual(["15000000.00", "14250000.00", "14250000.00"]);
  });
  it("db: three versions preserved immutably, original not overwritten", async () => {
    const w = { db, ws: WS1, userId: USERS.owner.id };
    const c = await createNegotiation(w, { title: `Nego A ${T}`, requirementId: reqId, terms: v(100, 2, 15) });
    await addOffer(w, c.id, v(95, 2, 15), "landlord counter");
    const last = await addOffer(w, c.id, v(95, 3, 12), "final");
    negoId = c.id;
    expect(last.version).toBe(3);
    const n = await loadNegotiation(w, c.id);
    expect(n!.inputs.versions.map((x) => [x.no, x.label, x.terms.rentPerSf, x.terms.rentFreeMonths, x.terms.escalationPct])).toEqual([
      [1, "Offer 1 — Property A", 100, 2, 15], [2, "Offer 2 — Property A", 95, 2, 15], [3, "Offer 3 — Property A", 95, 3, 12]]);
    const v1 = await getVersion(db, WS1, c.id, 1);
    expect((v1!.inputs as { versions: OfferVersion[] }).versions).toHaveLength(1);
    expect((v1!.inputs as { versions: OfferVersion[] }).versions[0].terms.rentPerSf).toBe(100);
    const upd = await db.from("deal_analysis_version").update({ inputs: {} }).eq("analysis_id", c.id).eq("version", 1).select("id");
    expect(upd.error || (upd.data ?? []).length === 0).toBeTruthy(); // immutable
  });
});

// ================================================================== 8.11
async function docText(buf: Buffer, part = "word/document.xml") {
  const z = await JSZip.loadAsync(buf);
  return (await z.file(part)!.async("string")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}
describe("8.11 Client proposal for A/B/C", () => {
  it("editable proposal contains every required section; pptx deck generated", async () => {
    const w = { db, ws: WS1, userId: USERS.owner.id };
    const le = await runLeaseEconomics(w, { title: `Lease A/B/C ${T}`, requirementId: reqId, offers: [terms("A"), terms("B"), terms("C")] });
    leaseId = le.id;
    const out = await generateDeliverables(db, WS1, USERS.owner.id, { requirementId: reqId, analysisIds: [cmpId, leaseId, negoId], preparedFor: "ABC CFO", title: `ABC Technologies — Kharadi options ${T}` });
    expect(out.files.map((f) => f.name)).toEqual(["proposal.docx", "analysis-workbook.xlsx", "decision-summary.docx"]);
    const p = await downloadDeliverable(db, WS1, out.id, "proposal.docx");
    const text = await docText(p.buffer);
    const checks: [string, RegExp][] = [
      ["requirement summary", /Your requirement/], ["property details", /Property A[\s\S]*Property B[\s\S]*Property C/],
      ["commercial comparison", /rent/i], ["occupancy costs", /occupancyCost|occupancy cost/i],
      ["advantages", /advantage/i], ["shortcomings", /disadvantage|shortcoming/i], ["assumptions", /assumption/i],
      ["missing information", /Still to confirm|missing/i], ["recommendation", /Recommended: (?!\{)/], ["supporting evidence", /evidence|Sources and versions/i],
    ];
    const absent = checks.filter(([, re]) => !re.test(text)).map(([n]) => n);
    console.log("[8.11] proposal sections absent:", absent, "| bytes", p.buffer.length);
    const deck = await generateDeck(db, WS1, USERS.owner.id, cmpId);
    expect(deck.buffer.subarray(0, 2).toString()).toBe("PK");
    const slides = Object.keys((await JSZip.loadAsync(deck.buffer)).files).filter((n) => /ppt\/slides\/slide\d+\.xml$/.test(n));
    const z = await JSZip.loadAsync(deck.buffer);
    let deckText = ""; for (const n of slides) deckText += (await z.file(n)!.async("string")).replace(/<[^>]+>/g, " ");
    const deckAbsent = checks.filter(([, re]) => !re.test(deckText)).map(([n]) => n);
    console.log("[8.11] deck slides:", slides.length, "| deck sections absent:", deckAbsent);
    expect(absent).toEqual([]);
    expect(deckAbsent.filter((n) => ["advantages", "shortcomings", "recommendation"].includes(n))).toEqual([]);
    expect(deckText).toMatch(/Your requirement — summary/);
    // readable recommendation, unconfirmed budget never reported as an exclusion; deposit separate; lease display fields
    expect(text).not.toMatch(/\{"key"/);
    expect(text).toMatch(/Refundable deposit/);
    expect(text).toMatch(/Total before other charges/);
    expect(text).toMatch(/Other charges/); expect(text).toMatch(/Not provided/);
    const ds = await docText((await downloadDeliverable(db, WS1, out.id, "decision-summary.docx")).buffer);
    for (const re of [/Occupancy costs/, /Advantages/, /Shortcomings/, /Assumptions/, /Missing information/, /Recommended: (?!\{)/]) expect(ds).toMatch(re);
  });
  it("uses the corporate proposal template_asset when one is configured (tagged, cleaned up)", async () => {
    const ins = await db.from("template_asset").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, name: `Corp proposal ${T}`, kind: "docx", purpose: "proposal", version: 9999, approved: true, brand_json: { name: `Corp ${T}`, primary: "#123456", disclaimer: `Disclaimer ${T}` } }).select("id").single();
    if (ins.error) throw ins.error;
    try {
      const out = await generateDeliverables(db, WS1, USERS.owner.id, { requirementId: reqId, analysisIds: [cmpId], title: `Template check ${T}` });
      const text = await docText((await downloadDeliverable(db, WS1, out.id, "proposal.docx")).buffer);
      expect(text).toContain(`Disclaimer ${T}`);
      expect(text).toMatch(new RegExp(`Corporate template (&quot;|")Corp proposal ${T}(&quot;|") v9999`));
    } finally {
      await db.from("template_asset").delete().eq("id", ins.data.id);
    }
  });
});

// ================================================================== 7.9 (journey) site-visit feedback reaches Module 8
describe("7.9 Site-visit feedback in comparison + proposal (never auto-rejects)", () => {
  it("loads meeting_property_feedback for compared buildings and shows positives/concerns", async () => {
    const u = USERS.owner.id;
    const asset = await db.from("asset").insert({ workspace_id: WS1, owner_user_id: u, name: `Tower FB ${T}`, grade: "A" }).select("id").single();
    if (asset.error) throw asset.error;
    const mv = await db.from("meeting_visit").insert({ workspace_id: WS1, owner_user_id: u, title: `Site visit ${T}`, start_at: "2026-11-05T05:00:00Z", end_at: "2026-11-05T06:00:00Z", kind: "meeting" }).select("id").single();
    if (mv.error) throw mv.error;
    const prep = await db.from("meeting_prep").insert({ workspace_id: WS1, owner_user_id: u, meeting_visit_id: mv.data.id, meeting_type: "site_visit", requirement_id: reqId, asset_ids: [asset.data.id], status: "completed" }).select("id").single();
    if (prep.error) throw prep.error;
    const fb = await db.from("meeting_property_feedback").insert({ workspace_id: WS1, owner_user_id: u, prep_id: prep.data.id, asset_id: asset.data.id, fields: { overall: 2, interest: "maybe", explicit_rejection: false, layout: "Floor plate suits the team", parking: "Only 40 car parks", pricing: "Rent above range" } });
    if (fb.error) throw fb.error;
    const s = await runComparison(db, WS1, u, { title: `FB compare ${T}`, requirementId: reqId, assetIds: [asset.data.id], manual: ratingProps(), termMonths: 60 });
    const row = (await db.from("deal_analysis").select("outputs").eq("id", s.id).single()).data as { outputs: { siteVisitFeedback: { name: string; comments: string[]; concerns: string[]; interest: string }[]; properties: { key: string; eligibility: string }[] } };
    const f = row.outputs.siteVisitFeedback.find((x) => x.name === `Tower FB ${T}`)!;
    expect(f.interest).toBe("maybe");
    expect(f.comments.join(" ")).toMatch(/Floor plate suits/);
    expect(f.concerns.join(" ")).toMatch(/40 car parks/); expect(f.concerns.join(" ")).toMatch(/Rent above range/);
    expect(row.outputs.properties.find((p) => p.key === asset.data.id)!.eligibility).not.toBe("not_eligible");
    const out = await generateDeliverables(db, WS1, u, { requirementId: reqId, analysisIds: [s.id], title: `FB proposal ${T}` });
    const text = await docText((await downloadDeliverable(db, WS1, out.id, "proposal.docx")).buffer);
    expect(text).toMatch(/Site-visit feedback/); expect(text).toMatch(/Only 40 car parks/);
  });
});
