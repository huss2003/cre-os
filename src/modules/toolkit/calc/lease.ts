import Decimal from "decimal.js";
import { edate } from "@/lib/util/time";
import { evaluate, compareScenarios, sensitivities, FinanceInputError } from "@/modules/deals/finance/engine";
import type { FinanceInput, FinanceResult, Sensitivity, CostItem, CostState, Num } from "@/modules/deals/finance/types";

/**
 * Lease Economics ("lease-1.0") and Occupancy Economics ("occ-1.0") — PURE wrappers around the deals finance engine
 * (fin-1.0). This file only maps user terms to a FinanceInput and regroups engine cash flows for presentation;
 * every money flow (rent, escalation, rent-free, CAM, parking, deposit out/refund, PV) comes from engine.evaluate.
 * Conventions: all rates are ₹ per SF per MONTH on an explicit area basis; "other recurring" items carry an explicit
 * periodicity (monthly | annual) and are converted to monthly before the engine; blank = unknown (never 0).
 */
export const LEASE_FORMULA = "lease-1.0";
export const OCC_FORMULA = "occ-1.0";

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type D = Decimal;
const blank = (x: unknown) => x === null || x === undefined || x === "";
const d = (x: Num | null | undefined) => new Dec(blank(x) ? 0 : (x as Num));
const s2 = (x: D) => x.toFixed(2);

export type Periodicity = "monthly" | "annual";
export type ValueLabel = "quoted" | "estimated";

export interface LeaseTerms {
  name: string;
  /** quoted = from a landlord quote; estimated = adviser assumption. Shown on every output. */
  label: ValueLabel;
  areaSf: Num;
  areaBasis: "chargeable" | "carpet";
  /** ₹/SF/month on areaBasis. */
  rentPerSf: Num;
  /** YYYY-MM-DD; lease month 1 starts here. */
  leaseCommencement: string;
  /** Optional; if set and rentFreeMonths is blank, rent-free = whole months between the two dates. */
  rentCommencement?: string | null;
  tenureMonths: number;
  rentFreeMonths?: number | null;
  escalationPct?: Num | null;
  escalationEveryMonths?: number | null;
  /** ₹/SF/month on areaBasis; null = unknown; "0" = explicitly none/included. */
  camPerSf?: Num | null;
  camEscalationPct?: Num | null;
  camEscalationEveryMonths?: number | null;
  /** null = unknown; 0 = none. Rate is ₹ per slot per month. */
  parkingSlots?: number | null;
  parkingRatePerSlot?: Num | null;
  /** Months of first full monthly base rent. null = unknown. */
  depositMonths?: Num | null;
  otherRecurring?: { label: string; amount: Num; periodicity: Periodicity }[];
  /** "none" = user confirmed there are no other recurring charges; otherwise empty list = unknown. */
  otherRecurringState?: "known" | "none" | "unknown";
  /** Non-recurring (one-off) items; month 0 = at signing. */
  nonRecurring?: { label: string; amount: Num; leaseMonth?: number }[];
  gst?: { treatment: "included" | "excluded" | "recoverable"; ratePct?: Num | null } | null;
  discountRatePct: Num;
}

export function monthsBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split("-").map(Number);
  const [yb, mb, db] = b.split("-").map(Number);
  let m = (yb - ya) * 12 + (mb - ma);
  if (db < da) m -= 1;
  return m;
}

export function rentFreeOf(t: LeaseTerms): number {
  if (!blank(t.rentFreeMonths)) return Number(t.rentFreeMonths);
  if (t.rentCommencement) return Math.max(0, monthsBetween(t.leaseCommencement, t.rentCommencement));
  return 0;
}

export function validateTerms(t: LeaseTerms): string[] {
  const miss: string[] = [];
  if (blank(t.areaSf) || d(t.areaSf).lte(0)) miss.push("area (SF)");
  if (blank(t.rentPerSf)) miss.push("rent ₹/SF/month");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.leaseCommencement ?? "")) miss.push("lease commencement date");
  if (!Number.isInteger(t.tenureMonths) || t.tenureMonths < 1) miss.push("tenure (months)");
  if (blank(t.discountRatePct)) miss.push("discount rate % p.a.");
  if (!blank(t.escalationPct) && d(t.escalationPct).gt(0) && !(Number(t.escalationEveryMonths) > 0)) miss.push("escalation frequency (months)");
  return miss;
}

/** Unknown items reported by this tool (presentation of engine gaps). */
export interface Extras {
  advanceRentMonths?: Num | null;
  fitoutCost?: Num | null;
  movingCost?: Num | null;
  initialCharges?: Num | null;
  /** Override horizon (≥ tenure) for equal-horizon comparison; extra months continue on same terms. */
  horizonMonths?: number;
}

/** Map terms → engine FinanceInput. Period 1 = lease month 1; period 0 = signing (one month before commencement). */
export function toFinanceInput(t: LeaseTerms, x: Extras = {}): FinanceInput {
  const miss = validateTerms(t);
  if (miss.length) throw new FinanceInputError(`Missing: ${miss.join(", ")}`);
  const H = Math.max(x.horizonMonths ?? t.tenureMonths, t.tenureMonths);
  const area = t.areaBasis === "carpet" ? { carpetSf: t.areaSf } : { chargeableSf: t.areaSf };
  const esc = !blank(t.escalationPct) && d(t.escalationPct).gt(0) ? { pct: String(t.escalationPct), everyMonths: Number(t.escalationEveryMonths) } : null;
  const camEsc = !blank(t.camEscalationPct) && d(t.camEscalationPct).gt(0) ? { pct: String(t.camEscalationPct), everyMonths: Number(t.camEscalationEveryMonths ?? t.escalationEveryMonths) } : null;
  const states: Partial<Record<CostItem, CostState>> = { fitout: "none", reinstatement: "none" };
  const sources: Record<string, string> = { "none:fitout": "outside lease-economics scope", "none:reinstatement": "outside lease-economics scope" };

  let cam: FinanceInput["cam"] = null;
  if (blank(t.camPerSf)) states.cam = "unknown";
  else if (d(t.camPerSf).isZero()) { cam = { mode: "none" }; sources["none:cam"] = "user: CAM none / included in rent"; }
  else cam = { mode: "per_sf", ratePerSf: String(t.camPerSf), basis: t.areaBasis, escalation: camEsc };

  let parking: FinanceInput["parking"] = null;
  if (blank(t.parkingSlots)) states.parking = "unknown";
  else if (Number(t.parkingSlots) === 0) { states.parking = "none"; sources["none:parking"] = "user: no paid parking"; }
  else {
    if (blank(t.parkingRatePerSlot)) throw new FinanceInputError("Missing: parking ₹/slot/month (slots given)");
    parking = { slots: Number(t.parkingSlots), ratePerSlot: String(t.parkingRatePerSlot) };
  }

  let deposit: FinanceInput["deposit"] = null;
  if (blank(t.depositMonths)) states.deposit = "unknown";
  else if (d(t.depositMonths).isZero()) { states.deposit = "none"; sources["none:deposit"] = "user: no deposit"; }
  else deposit = { months: String(t.depositMonths), paidPeriod: 0 };

  const recurring = (t.otherRecurring ?? []).filter((r) => !blank(r.amount)).map((r) => ({
    label: r.label, category: "other_recurring", fromPeriod: 1,
    monthly: r.periodicity === "annual" ? d(r.amount).div(12).toString() : String(r.amount),
  }));
  if (!recurring.length) {
    states.opex = t.otherRecurringState === "none" ? "none" : "unknown";
    if (states.opex === "none") sources["none:opex"] = "user: no other recurring charges";
  }

  const oneOffs: NonNullable<FinanceInput["oneOffs"]> = (t.nonRecurring ?? []).filter((o) => !blank(o.amount))
    .map((o) => ({ label: o.label, amount: String(o.amount), period: o.leaseMonth ?? 0, category: "non_recurring" }));
  const rentFree = rentFreeOf(t);
  if (!blank(x.advanceRentMonths) && d(x.advanceRentMonths).gt(0)) {
    // advance rent is a prepayment: paid at signing and adjusted against the first rent-paying months (timing only)
    const adv = d(x.advanceRentMonths).times(d(t.areaSf)).times(d(t.rentPerSf));
    oneOffs.push({ label: "Advance rent", amount: adv.toString(), period: 0, category: "advance_rent" });
    oneOffs.push({ label: "Advance rent adjusted", amount: adv.neg().toString(), period: rentFree + 1, category: "advance_rent_adjusted" });
  }
  if (!blank(x.movingCost)) oneOffs.push({ label: "Moving", amount: String(x.movingCost), period: 0, category: "moving" });
  if (!blank(x.initialCharges)) oneOffs.push({ label: "Initial charges (stamp duty, registration, legal)", amount: String(x.initialCharges), period: 0, category: "initial_charges" });
  let capex: FinanceInput["capex"] = null;
  if (!blank(x.fitoutCost) && d(x.fitoutCost).gt(0)) { capex = { fitoutCost: String(x.fitoutCost), spendPeriod: 0 }; delete states.fitout; delete sources["none:fitout"]; }

  return {
    name: t.name, kind: "conventional", baseDate: edate(t.leaseCommencement, -1), horizonMonths: H,
    annualDiscountRatePct: String(t.discountRatePct), area, tenureMonths: t.tenureMonths,
    afterTenure: H > t.tenureMonths ? "continue_same_terms" : null,
    rent: { basis: t.areaBasis, rate: String(t.rentPerSf), startPeriod: 1, escalation: esc, rentFreeMonths: rentFree },
    cam, parking, deposit, recurring, oneOffs, capex,
    taxes: t.gst ? { treatment: t.gst.treatment, gstRatePct: blank(t.gst.ratePct) ? null : String(t.gst.ratePct) } : null,
    costStates: states, assumptionSources: { ...sources, rent_terms: `${t.label} value` },
  };
}

// ---------------------------------------------------------------------------------------------- lease economics
export interface RentStep { fromMonth: number; toMonth: number; ratePerSf: string; monthlyRent: string; annualRent: string }
export interface YearRow { year: number; fromMonth: number; toMonth: number; rent: string; cam: string; parking: string; other: string; nonRecurring: string; expenditure: string; deposit: string }
export interface MonthRow { month: number; date: string; rent: string; cam: string; parking: string; other: string; nonRecurring: string; deposit: string; total: string }

export interface LeaseEconomics {
  formulaVersion: string;
  engineVersion: string;
  name: string;
  label: ValueLabel;
  areaSf: string;
  areaBasis: string;
  rentFreeMonths: number;
  monthly: { baseRent: string; cam: string | null; parking: string | null; other: string | null };
  annual: { baseRent: string; cam: string | null; parking: string | null; other: string | null };
  rentSteps: RentStep[];
  totals: { rent: string; cam: string | null; parking: string | null; other: string | null; nonRecurring: string; contractualExpenditure: string; npv: string };
  rentFreeBenefit: string;
  deposit: { amount: string; paidMonth: number; refundMonth: number; refundable: true } | null;
  years: YearRow[];
  months: MonthRow[];
  complete: boolean;
  totalsLabel: string;
  gaps: string[];
  warnings: string[];
  outputHash: string;
}

const EXPENSE_CATS: Record<string, keyof Omit<MonthRow, "month" | "date" | "total" | "deposit">> = {
  rent: "rent", cam: "cam", parking: "parking", other_recurring: "other", non_recurring: "nonRecurring",
};

/** Lease economics from engine results only. */
export function leaseEconomics(t: LeaseTerms, extras: Extras = {}): LeaseEconomics {
  const fin = toFinanceInput(t, extras);
  const r = evaluate(fin);
  // rent-free benefit = rent the engine charges with no rent-free minus rent with it (same engine, same terms)
  const noFree = evaluate({ ...fin, rent: { ...fin.rent!, rentFreeMonths: 0 } });
  const rentFreeBenefit = d(noFree.categoryTotals.rent).minus(d(r.categoryTotals.rent));
  const area = d(t.areaSf);
  const monthlyRent = area.times(d(t.rentPerSf));
  const camM = fin.cam && fin.cam.mode === "per_sf" ? area.times(d(fin.cam.ratePerSf)) : fin.cam?.mode === "none" ? new Dec(0) : null;
  const parkM = fin.parking ? d(fin.parking.ratePerSlot).times(fin.parking.slots) : r.costStates.parking === "none" ? new Dec(0) : null;
  const otherM = (fin.recurring ?? []).length ? (fin.recurring ?? []).reduce((a, x) => a.plus(d(x.monthly)), new Dec(0)) : r.costStates.opex === "none" ? new Dec(0) : null;

  // rent steps from the engine's own monthly rent flows (rate = amount / area)
  const months: MonthRow[] = [];
  for (let p = 1; p <= fin.horizonMonths; p++) {
    const row: MonthRow = { month: p, date: edate(fin.baseDate, p), rent: "0.00", cam: "0.00", parking: "0.00", other: "0.00", nonRecurring: "0.00", deposit: "0.00", total: "0.00" };
    let total = new Dec(0);
    for (const c of r.cashflows.filter((c) => c.period === p)) {
      const k = EXPENSE_CATS[c.category];
      if (k) { row[k] = s2(d(row[k]).plus(c.amount)); total = total.plus(c.amount); }
      else if (c.category.startsWith("deposit")) row.deposit = s2(d(row.deposit).plus(c.amount));
    }
    row.total = s2(total);
    months.push(row);
  }
  const steps: RentStep[] = [];
  const stepRate = (L: number) => {
    // engine-equivalent rate: from a no-rent-free run so rent-free months still show their contractual rate
    const amt = noFree.cashflows.find((c) => c.period === L && c.category === "rent")?.amount ?? "0";
    return d(amt).div(area);
  };
  for (let L = 1; L <= t.tenureMonths; L++) {
    const rate = stepRate(L);
    const last = steps[steps.length - 1];
    if (last && d(last.ratePerSf).eq(rate.toDecimalPlaces(4))) { last.toMonth = L; continue; }
    const m = rate.times(area);
    steps.push({ fromMonth: L, toMonth: L, ratePerSf: rate.toDecimalPlaces(4).toString(), monthlyRent: s2(m), annualRent: s2(m.times(12)) });
  }
  const years: YearRow[] = [];
  for (let y = 0; y * 12 < fin.horizonMonths; y++) {
    const ms = months.slice(y * 12, y * 12 + 12);
    const sum = (k: keyof MonthRow) => s2(ms.reduce((a, m) => a.plus(d(m[k] as string)), new Dec(0)));
    years.push({ year: y + 1, fromMonth: y * 12 + 1, toMonth: y * 12 + ms.length, rent: sum("rent"), cam: sum("cam"), parking: sum("parking"), other: sum("other"), nonRecurring: sum("nonRecurring"), expenditure: sum("total"), deposit: sum("deposit") });
  }
  // signing-month (period 0) non-recurring items count toward expenditure; deposit never does
  const ct = r.categoryTotals;
  const tot = (k: string) => d(ct[k]);
  const expenditure = tot("rent").plus(tot("cam")).plus(tot("parking")).plus(tot("other_recurring")).plus(tot("non_recurring")).plus(tot("gst"));
  const known = (state: CostState, k: string) => (state === "unknown" ? null : s2(tot(k)));
  const depAmt = r.cashflows.find((c) => c.period === 0 && c.category === "deposit")?.amount;
  return {
    formulaVersion: LEASE_FORMULA, engineVersion: r.engineVersion, name: t.name, label: t.label,
    areaSf: d(t.areaSf).toString(), areaBasis: t.areaBasis, rentFreeMonths: rentFreeOf(t),
    monthly: { baseRent: s2(monthlyRent), cam: camM ? s2(camM) : null, parking: parkM ? s2(parkM) : null, other: otherM ? s2(otherM) : null },
    annual: { baseRent: s2(monthlyRent.times(12)), cam: camM ? s2(camM.times(12)) : null, parking: parkM ? s2(parkM.times(12)) : null, other: otherM ? s2(otherM.times(12)) : null },
    rentSteps: steps,
    totals: {
      rent: s2(tot("rent")), cam: known(r.costStates.cam, "cam"), parking: known(r.costStates.parking, "parking"), other: known(r.costStates.opex, "other_recurring"),
      nonRecurring: s2(tot("non_recurring")), contractualExpenditure: s2(expenditure), npv: r.totals.npv,
    },
    rentFreeBenefit: s2(rentFreeBenefit),
    deposit: depAmt ? { amount: depAmt, paidMonth: 0, refundMonth: r.cashflows.find((c) => c.category === "deposit_refund" || c.category === "deposit_terminal_value")?.period ?? fin.horizonMonths, refundable: true } : null,
    years, months,
    complete: r.complete,
    totalsLabel: r.complete ? `Complete (${t.label} values)` : `Incomplete — excludes unknown ${r.gaps.map((g) => g.label).join(", ")} (${t.label} values)`,
    gaps: r.gaps.map((g) => g.label), warnings: r.warnings, outputHash: r.outputHash,
  };
}

export interface OfferComparison {
  formulaVersion: string;
  horizonMonths: number;
  offers: LeaseEconomics[];
  rows: { name: string; npv: string; nominalTco: string; incrementalNpvVsBaseline: string; rank: number; complete: boolean }[];
  warnings: string[];
}

/** Side-by-side offers on an equal horizon (engine.compareScenarios refuses unequal horizons/base dates/rates). */
export function compareLeaseOffers(terms: LeaseTerms[]): OfferComparison {
  if (!terms.length) throw new FinanceInputError("at least one offer required");
  const H = Math.max(...terms.map((t) => t.tenureMonths));
  const inputs = terms.map((t) => toFinanceInput(t, { horizonMonths: H }));
  const base = inputs[0].baseDate;
  const aligned = inputs.map((i) => {
    if (i.baseDate === base) return i;
    throw new FinanceInputError(`offers must share a lease commencement date for an equal comparison (${terms[0].name} vs ${i.name})`);
  });
  const c = compareScenarios(aligned);
  return {
    formulaVersion: LEASE_FORMULA, horizonMonths: H,
    offers: terms.map((t) => leaseEconomics(t, { horizonMonths: H })),
    rows: c.rows.map((r) => ({ name: r.name, npv: r.npv, nominalTco: r.nominalTco, incrementalNpvVsBaseline: r.incrementalNpvVsBaseline, rank: r.rank, complete: r.complete })),
    warnings: c.warnings,
  };
}

// ---------------------------------------------------------------------------------------------- occupancy economics
export interface OccupancyInput { terms: LeaseTerms; extras: Extras }
export interface OccupancyResult {
  formulaVersion: string;
  engineVersion: string;
  name: string;
  label: ValueLabel;
  nominalRentPerSf: string;
  /** Total rent paid ÷ (area × tenure months): nominal average after rent-free and escalation. */
  effectiveRentPerSf: string;
  /** Engine PV-level equivalent rent per SF per month (rent-free and escalation included, discounted). */
  pvEffectiveRentPerSf: string | null;
  cashFunding: { label: string; amount: string | null; refundable?: boolean }[];
  cashFundingTotal: string;
  cashFundingComplete: boolean;
  presentValue: string;
  nominalTotal: string;
  equivalentMonthly: string;
  peakCashRequirement: string;
  peakMonthlyOutflow: string;
  peakMonthlyOutflowMonth: number;
  cumulative: string[];
  complete: boolean;
  totalsLabel: string;
  gaps: string[];
  warnings: string[];
  standardSensitivities: Sensitivity[];
  outputHash: string;
}

export function occupancyEconomics(o: OccupancyInput): OccupancyResult {
  const t = o.terms;
  const fin = toFinanceInput(t, o.extras);
  const r: FinanceResult = evaluate(fin);
  const flow0 = (cat: string) => r.cashflows.filter((c) => c.period === 0 && c.category === cat).reduce((a, c) => a.plus(c.amount), new Dec(0));
  const item = (label: string, cat: string, given: unknown, refundable = false) =>
    ({ label, amount: blank(given) && cat !== "deposit" ? null : cat === "deposit" && r.costStates.deposit === "unknown" ? null : s2(flow0(cat)), ...(refundable ? { refundable } : {}) });
  const cashFunding = [
    item("Security deposit (refundable)", "deposit", t.depositMonths, true),
    item("Advance rent (adjusted against later rent)", "advance_rent", o.extras.advanceRentMonths),
    item("Fit-out", "fitout_capex", o.extras.fitoutCost),
    item("Moving", "moving", o.extras.movingCost),
    item("Initial charges", "initial_charges", o.extras.initialCharges),
    { label: "Other non-recurring at signing", amount: s2(flow0("non_recurring")) },
  ];
  const known = cashFunding.filter((c) => c.amount !== null);
  let cum = new Dec(0);
  const cumulative = r.periodTotals.map((v) => s2((cum = cum.plus(v))));
  const area = d(t.areaSf);
  return {
    formulaVersion: OCC_FORMULA, engineVersion: r.engineVersion, name: t.name, label: t.label,
    nominalRentPerSf: d(t.rentPerSf).toFixed(2),
    effectiveRentPerSf: d(r.categoryTotals.rent).div(area.times(t.tenureMonths)).toFixed(2),
    pvEffectiveRentPerSf: r.totals.effectiveRentPerSfMonth,
    cashFunding, cashFundingTotal: s2(known.reduce((a, c) => a.plus(c.amount!), new Dec(0))), cashFundingComplete: known.length === cashFunding.length,
    presentValue: r.totals.npv, nominalTotal: r.totals.nominalTco, equivalentMonthly: r.totals.equivalentMonthly,
    peakCashRequirement: r.totals.peakCumulativeOutflow, peakMonthlyOutflow: r.totals.peakMonthlyOutflow, peakMonthlyOutflowMonth: r.totals.peakMonthlyOutflowPeriod,
    cumulative, complete: r.complete, totalsLabel: `${r.totalsLabel} (${t.label} values)`, gaps: r.gaps.map((g) => g.label), warnings: r.warnings,
    standardSensitivities: sensitivities(fin), outputHash: r.outputHash,
  };
}

/** User-driven sensitivity: overrides on rent, escalation, tenure, rent-free, CAM, discount, deposit, other. */
export interface SensitivityOverrides {
  rentPerSf?: Num | null; escalationPct?: Num | null; tenureMonths?: number | null; rentFreeMonths?: number | null;
  camPerSf?: Num | null; discountRatePct?: Num | null; depositMonths?: Num | null; otherMonthly?: Num | null;
}
export function applyOverrides(t: LeaseTerms, o: SensitivityOverrides): LeaseTerms {
  const x: LeaseTerms = JSON.parse(JSON.stringify(t));
  if (!blank(o.rentPerSf)) x.rentPerSf = String(o.rentPerSf);
  if (!blank(o.escalationPct)) x.escalationPct = String(o.escalationPct);
  if (!blank(o.tenureMonths)) x.tenureMonths = Number(o.tenureMonths);
  if (!blank(o.rentFreeMonths)) x.rentFreeMonths = Number(o.rentFreeMonths);
  if (!blank(o.camPerSf)) x.camPerSf = String(o.camPerSf);
  if (!blank(o.discountRatePct)) x.discountRatePct = String(o.discountRatePct);
  if (!blank(o.depositMonths)) x.depositMonths = String(o.depositMonths);
  if (!blank(o.otherMonthly)) { x.otherRecurring = [{ label: "Other (sensitivity)", amount: String(o.otherMonthly), periodicity: "monthly" }]; x.otherRecurringState = "known"; }
  return x;
}
export function occupancySensitivity(base: OccupancyInput, o: SensitivityOverrides) {
  const a = occupancyEconomics(base);
  const b = occupancyEconomics({ terms: applyOverrides(base.terms, o), extras: base.extras });
  return {
    base: { presentValue: a.presentValue, nominalTotal: a.nominalTotal, peakCash: a.peakCashRequirement, effectiveRentPerSf: a.effectiveRentPerSf },
    adjusted: { presentValue: b.presentValue, nominalTotal: b.nominalTotal, peakCash: b.peakCashRequirement, effectiveRentPerSf: b.effectiveRentPerSf },
    change: {
      presentValue: s2(d(b.presentValue).minus(a.presentValue)), nominalTotal: s2(d(b.nominalTotal).minus(a.nominalTotal)),
      peakCash: s2(d(b.peakCashRequirement).minus(a.peakCashRequirement)),
    },
    note: a.complete && b.complete ? null : "One or both runs are incomplete (unknown costs excluded).",
  };
}
