import Decimal from "decimal.js";
import { createHash } from "node:crypto";
import { edate } from "@/lib/util/time";
import {
  ENGINE_VERSION,
  type CashflowRow,
  type Escalation,
  type FinanceInput,
  type FinanceResult,
  type Num,
  type Sensitivity,
} from "./types";

/**
 * Deterministic occupancy-cost engine (spec Part I §11, Part II §5). No LLM, no floating-point money maths.
 * See ./types.ts for the timeline and sign conventions.
 */
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type D = Decimal;
const d = (x: Num | null | undefined, fallback: Num = 0): D => new Dec(x === null || x === undefined || x === "" ? fallback : x);
const ZERO = new Dec(0);

export class FinanceInputError extends Error {
  constructor(message: string, public field?: string) {
    super(message);
  }
}

export function stableStringify(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** r_m = (1 + r_a)^(1/12) - 1, with r_a given in percent. */
export function monthlyRateFromAnnual(annualPct: Num): D {
  const ra = d(annualPct).div(100);
  if (ra.lte(-1)) throw new FinanceInputError("annual discount rate must be > -100%", "annualDiscountRatePct");
  return ra.plus(1).pow(new Dec(1).div(12)).minus(1);
}

function escalationFactor(esc: Escalation | null | undefined, leaseMonth: number): D {
  if (!esc || d(esc.pct).isZero()) return new Dec(1);
  if (!Number.isInteger(esc.everyMonths) || esc.everyMonths <= 0) throw new FinanceInputError("escalation.everyMonths must be a positive integer", "escalation");
  const steps = Math.floor((leaseMonth - 1) / esc.everyMonths);
  return d(esc.pct).div(100).plus(1).pow(steps);
}

function positive(x: Num | null | undefined): boolean {
  return x !== null && x !== undefined && x !== "" && d(x).gt(0);
}

/** Validate structural inputs. Missing values that the maths needs are errors, never silently zero (S6). */
export function validateInput(inp: FinanceInput): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inp.baseDate)) throw new FinanceInputError("baseDate must be YYYY-MM-DD", "baseDate");
  if (!Number.isInteger(inp.horizonMonths) || inp.horizonMonths < 1 || inp.horizonMonths > 600)
    throw new FinanceInputError("horizonMonths must be an integer between 1 and 600", "horizonMonths");
  if (inp.annualDiscountRatePct === null || inp.annualDiscountRatePct === undefined || inp.annualDiscountRatePct === "")
    throw new FinanceInputError("annualDiscountRatePct is required (use 0 for undiscounted)", "annualDiscountRatePct");
  if (inp.currency && inp.currency !== "INR" && !/^[A-Z]{3}$/.test(inp.currency)) throw new FinanceInputError("currency must be ISO 4217", "currency");
  const r = inp.rent;
  if (r) {
    if (r.basis === "chargeable" && !positive(inp.area.chargeableSf)) throw new FinanceInputError("rent on chargeable basis needs area.chargeableSf", "area.chargeableSf");
    if (r.basis === "carpet" && !positive(inp.area.carpetSf)) throw new FinanceInputError("rent on carpet basis needs area.carpetSf", "area.carpetSf");
    if (r.basis === "seat" && !r.committedSeats && !inp.area.plannedSeats)
      throw new FinanceInputError("rent on seat basis needs committed or planned seats", "area.plannedSeats");
    if (r.rate === null || r.rate === undefined || r.rate === "") throw new FinanceInputError("rent.rate is required", "rent.rate");
  }
  const c = inp.cam;
  if (c && (c.mode === "per_sf" || c.mode === "mixed")) {
    const basis = c.basis ?? "chargeable";
    const a = basis === "carpet" ? inp.area.carpetSf : inp.area.chargeableSf;
    if (!positive(a)) throw new FinanceInputError(`CAM per SF needs area.${basis}Sf`, `area.${basis}Sf`);
  }
  const tenure = inp.tenureMonths ?? null;
  const start = inp.rent?.startPeriod ?? 1;
  if (tenure !== null && (!Number.isInteger(tenure) || tenure < 1)) throw new FinanceInputError("tenureMonths must be a positive integer", "tenureMonths");
  if (tenure !== null && start + tenure - 1 < inp.horizonMonths && !inp.afterTenure)
    throw new FinanceInputError(
      `tenure (${tenure} months) ends before the ${inp.horizonMonths}-month comparison horizon: set afterTenure (continue_same_terms | vacate) explicitly`,
      "afterTenure",
    );
  if (inp.financing) {
    const f = inp.financing;
    if (!Number.isInteger(f.termMonths) || f.termMonths < 1) throw new FinanceInputError("financing.termMonths must be a positive integer", "financing.termMonths");
    if (!positive(f.principal)) throw new FinanceInputError("financing.principal must be > 0", "financing.principal");
    if (inp.capex && d(f.principal).gt(d(inp.capex.fitoutCost).minus(d(inp.capex.landlordContribution))))
      throw new FinanceInputError("financing.principal exceeds net capex (would double count)", "financing.principal");
  }
}

interface Ledger {
  add(period: number, category: string, amount: D): void;
}

export function evaluate(input: FinanceInput): FinanceResult {
  validateInput(input);
  const H = input.horizonMonths;
  const warnings: string[] = [];
  const rm = monthlyRateFromAnnual(input.annualDiscountRatePct);
  const onePlus = rm.plus(1);
  const df = (t: number): D => (rm.isZero() ? new Dec(1) : onePlus.pow(-t));

  // period -> category -> amount (unrounded); amounts beyond the horizon become terminal values at H
  const grid = new Map<number, Map<string, D>>();
  const terminal = new Map<string, D>();
  const ledger: Ledger = {
    add(period, category, amount) {
      if (amount.isZero()) return;
      if (period < 0) throw new FinanceInputError(`negative period for ${category}`);
      if (period > H) {
        // balance-sheet style item after the horizon (deposit refund, outstanding loan): PV at horizon
        const pvAtH = rm.isZero() ? amount : amount.div(onePlus.pow(period - H));
        terminal.set(category, (terminal.get(category) ?? ZERO).plus(pvAtH));
        return;
      }
      const m = grid.get(period) ?? new Map<string, D>();
      m.set(category, (m.get(category) ?? ZERO).plus(amount));
      grid.set(period, m);
    },
  };

  const start = input.rent?.startPeriod ?? 1;
  const tenure = input.tenureMonths ?? H - start + 1;
  const leaseEnd = start + tenure - 1;
  const lastLeasePeriod = input.afterTenure === "continue_same_terms" ? H : Math.min(H, leaseEnd);
  if (input.afterTenure === "continue_same_terms" && leaseEnd < H) warnings.push(`Tenure ends at period ${leaseEnd}; assumed renewal on same escalating terms to period ${H}.`);
  if (input.afterTenure === "vacate" && leaseEnd < H) warnings.push(`Premises vacated after period ${leaseEnd}; no occupancy cost modelled for periods ${leaseEnd + 1}-${H} (comparison is not like-for-like occupancy).`);

  const chargeable = input.area.chargeableSf ? d(input.area.chargeableSf) : null;
  const carpet = input.area.carpetSf ? d(input.area.carpetSf) : null;
  const seats = input.area.plannedSeats ?? null;

  // ---------------------------------------------------------------- rent
  const rent = input.rent;
  const rentFree = rent?.rentFreeMonths ?? 0;
  let billingUnits: D | null = null;
  const rateAt = (leaseMonth: number): D => {
    if (!rent) return ZERO;
    if (rent.schedule && rent.schedule.length) {
      const sorted = [...rent.schedule].sort((a, b) => a.fromLeaseMonth - b.fromLeaseMonth);
      let rate = d(rent.rate);
      for (const s of sorted) if (s.fromLeaseMonth <= leaseMonth) rate = d(s.rate);
      return rate;
    }
    return d(rent.rate).times(escalationFactor(rent.escalation, leaseMonth));
  };
  if (rent) {
    const committed = rent.committedSeats ?? null;
    billingUnits =
      rent.basis === "chargeable" ? chargeable :
      rent.basis === "carpet" ? carpet :
      rent.basis === "seat" ? new Dec(committed ?? seats ?? 0) : new Dec(1);
    if (rent.basis === "seat" && committed && seats && committed > seats) warnings.push(`Committed seats (${committed}) exceed planned seats (${seats}).`);
    for (let p = start; p <= lastLeasePeriod; p++) {
      const L = p - start + 1;
      if (L <= rentFree) continue;
      ledger.add(p, "rent", billingUnits!.times(rateAt(L)));
    }
  }

  // ---------------------------------------------------------------- CAM
  const cam = input.cam;
  if (cam && cam.mode !== "none") {
    const camArea = (cam.basis ?? "chargeable") === "carpet" ? carpet : chargeable;
    for (let p = start; p <= lastLeasePeriod; p++) {
      const L = p - start + 1;
      if (rent?.rentFreeIncludesCam && L <= rentFree) continue;
      const f = escalationFactor(cam.escalation, L);
      let amt = ZERO;
      if (cam.mode === "fixed" || cam.mode === "mixed") amt = amt.plus(d(cam.fixedMonthly));
      if (cam.mode === "per_sf" || cam.mode === "mixed") amt = amt.plus(d(cam.ratePerSf).times(camArea!));
      ledger.add(p, "cam", amt.times(f));
    }
  }

  // ---------------------------------------------------------------- parking
  if (input.parking && input.parking.slots > 0) {
    for (let p = start; p <= lastLeasePeriod; p++) {
      const L = p - start + 1;
      ledger.add(p, "parking", d(input.parking.ratePerSlot).times(input.parking.slots).times(escalationFactor(input.parking.escalation, L)));
    }
  }

  // ---------------------------------------------------------------- other recurring + one-offs
  for (const r of input.recurring ?? []) {
    const from = r.fromPeriod ?? start;
    const to = Math.min(r.toPeriod ?? lastLeasePeriod, H);
    for (let p = from; p <= to; p++) ledger.add(p, r.category ?? "recurring", d(r.monthly));
  }
  for (const o of input.oneOffs ?? []) ledger.add(o.period, o.category ?? "one_off", d(o.amount));

  // ---------------------------------------------------------------- deposit (outflow + refund; never a permanent expense)
  if (input.deposit) {
    const dep = input.deposit;
    let amount: D;
    if (dep.amount !== undefined && dep.amount !== null && dep.amount !== "") amount = d(dep.amount);
    else if (dep.months !== undefined && rent) amount = d(dep.months).times(billingUnits!.times(rateAt(1)));
    else throw new FinanceInputError("deposit needs amount, or months together with rent", "deposit");
    const paid = dep.paidPeriod ?? 0;
    const refund = dep.refundPeriod ?? (input.afterTenure === "continue_same_terms" ? Math.max(leaseEnd, H) : leaseEnd);
    ledger.add(paid, "deposit", amount);
    if (refund > H) warnings.push(`Deposit refund at period ${refund} is beyond the horizon; included as its present value at period ${H}.`);
    ledger.add(refund, refund > H ? "deposit_terminal_value" : "deposit_refund", amount.neg());
  }

  // ---------------------------------------------------------------- capex, landlord support, reinstatement
  const capex = input.capex;
  if (capex) {
    const spend = capex.spendPeriod ?? 0;
    ledger.add(spend, "fitout_capex", d(capex.fitoutCost));
    if (positive(capex.landlordContribution)) ledger.add(capex.contributionPeriod ?? spend, "landlord_capex_support", d(capex.landlordContribution).neg());
    if (capex.reinstatement && positive(capex.reinstatement.amount)) ledger.add(capex.reinstatement.period, "reinstatement", d(capex.reinstatement.amount));
  }

  // ---------------------------------------------------------------- fit-out financing (client cash view: no double count)
  let interestTotal: D | null = null;
  const f = input.financing;
  if (f) {
    const P = d(f.principal);
    const draw = f.drawPeriod ?? capex?.spendPeriod ?? 0;
    const first = f.firstRepaymentPeriod ?? draw + 1;
    const n = f.termMonths;
    const i = d(f.annualInterestRate).div(1200);
    ledger.add(draw, "financing_draw", P.neg()); // lender pays this part of capex
    if (positive(f.upfrontFee)) ledger.add(draw, "financing_fee", d(f.upfrontFee));
    if (positive(f.securityDeposit)) {
      ledger.add(draw, "financing_deposit", d(f.securityDeposit));
      ledger.add(first + n - 1, "financing_deposit_refund", d(f.securityDeposit).neg());
    }
    const annuity = i.isZero() ? P.div(n) : P.times(i).div(new Dec(1).minus(i.plus(1).pow(-n)));
    let balance = P;
    interestTotal = ZERO;
    for (let k = 0; k < n; k++) {
      const period = first + k;
      const interest = balance.times(i);
      const principal = f.repayment === "straight_line" ? P.div(n) : annuity.minus(interest);
      const principalPaid = k === n - 1 ? balance : principal; // close residual rounding on the last instalment
      ledger.add(period, "financing_interest", interest);
      ledger.add(period, "financing_principal", principalPaid);
      interestTotal = interestTotal.plus(interest);
      balance = balance.minus(principalPaid);
      if (f.earlyTerminationPeriod && period === f.earlyTerminationPeriod && k < n - 1) {
        ledger.add(period, "financing_early_settlement", balance);
        warnings.push(`Financing settled early at period ${period}; outstanding principal repaid.`);
        balance = ZERO;
        break;
      }
    }
    if (positive(f.residualBuyout)) ledger.add(first + n - 1, "financing_residual_buyout", d(f.residualBuyout));
    if (first + n - 1 > H) warnings.push(`Financing repayments run beyond the horizon; remaining instalments included at present value at period ${H}.`);
  }

  // ---------------------------------------------------------------- move dependencies (relocate)
  const mv = input.move;
  if (mv) {
    if (positive(mv.parallelRentMonthly) && (mv.parallelMonths ?? 0) > 0) {
      const from = mv.parallelFromPeriod ?? 1;
      for (let p = from; p < from + (mv.parallelMonths ?? 0); p++) ledger.add(p, "parallel_rent", d(mv.parallelRentMonthly));
    }
    if (positive(mv.moveCost)) ledger.add(mv.movePeriod ?? 0, "move_cost", d(mv.moveCost));
    if (positive(mv.brokerageLegal)) ledger.add(mv.brokerageLegalPeriod ?? 0, "brokerage_legal", d(mv.brokerageLegal));
  }

  // ---------------------------------------------------------------- taxes (GST) — rate must be supplied
  const tax = input.taxes;
  if (tax) {
    if (tax.treatment === "excluded") {
      if (tax.gstRatePct === null || tax.gstRatePct === undefined || tax.gstRatePct === "") {
        warnings.push("Quoted rates exclude GST but no GST rate was supplied: GST is NOT modelled.");
      } else {
        const rate = d(tax.gstRatePct).div(100);
        const cats = new Set(tax.appliesTo ?? ["rent", "cam", "parking"]);
        for (const [p, m] of grid) {
          let base = ZERO;
          for (const [cat, amt] of m) if (cats.has(cat as "rent")) base = base.plus(amt);
          if (!base.isZero()) ledger.add(p, "gst", base.times(rate));
        }
      }
    } else if (tax.treatment === "recoverable") {
      warnings.push("GST treated as recoverable (input credit): excluded from occupancy cost per finance input.");
    }
  } else {
    warnings.push("Tax treatment not specified: quoted amounts used as-is.");
  }

  // ---------------------------------------------------------------- assemble (round each category-period to paise)
  for (const [cat, pv] of terminal) {
    const m = grid.get(H) ?? new Map<string, D>();
    m.set(cat, (m.get(cat) ?? ZERO).plus(pv));
    grid.set(H, m);
  }
  const cashflows: CashflowRow[] = [];
  const periodTotalsD: D[] = Array.from({ length: H + 1 }, () => ZERO);
  const catTotals = new Map<string, D>();
  let rentNpv = ZERO;
  for (let p = 0; p <= H; p++) {
    const m = grid.get(p);
    if (!m) continue;
    for (const cat of [...m.keys()].sort()) {
      const amt = m.get(cat)!.toDecimalPlaces(2);
      if (amt.isZero()) continue;
      cashflows.push({ period: p, date: edate(input.baseDate, p), category: cat, amount: amt.toFixed(2) });
      periodTotalsD[p] = periodTotalsD[p].plus(amt);
      catTotals.set(cat, (catTotals.get(cat) ?? ZERO).plus(amt));
      if (cat === "rent") rentNpv = rentNpv.plus(amt.times(df(p)));
    }
  }

  let npv = ZERO;
  let tco = ZERO;
  let cum = ZERO;
  let peakCum = ZERO;
  let peak = ZERO;
  let peakPeriod = 0;
  periodTotalsD.forEach((v, p) => {
    npv = npv.plus(v.times(df(p)));
    tco = tco.plus(v);
    cum = cum.plus(v);
    if (cum.gt(peakCum)) peakCum = cum;
    if (v.gt(peak)) { peak = v; peakPeriod = p; }
  });
  let annuity = ZERO;
  if (rm.isZero()) annuity = new Dec(H);
  else for (let t = 1; t <= H; t++) annuity = annuity.plus(df(t));
  const eq = npv.div(annuity);
  const per = (x: D | null) => (x && x.gt(0) ? eq.div(x).toFixed(2) : null);
  let effRent: string | null = null;
  if (rent && (rent.basis === "chargeable" || rent.basis === "carpet") && billingUnits && billingUnits.gt(0)) {
    effRent = rentNpv.div(annuity).div(billingUnits).toFixed(2);
  }

  const totals = {
    nominalTco: tco.toFixed(2),
    npv: npv.toFixed(2),
    annuityFactor: annuity.toFixed(10),
    equivalentMonthly: eq.toFixed(2),
    perChargeableSfMonth: per(chargeable),
    perCarpetSfMonth: per(carpet),
    perPlannedSeatMonth: per(seats ? new Dec(seats) : null),
    effectiveRentPerSfMonth: effRent,
    peakMonthlyOutflow: peak.toFixed(2),
    peakMonthlyOutflowPeriod: peakPeriod,
    peakCumulativeOutflow: peakCum.toFixed(2),
    financingInterestTotal: interestTotal ? interestTotal.toFixed(2) : null,
  };
  const categoryTotals: Record<string, string> = {};
  for (const k of [...catTotals.keys()].sort()) categoryTotals[k] = catTotals.get(k)!.toFixed(2);
  const periodTotals = periodTotalsD.map((v) => v.toFixed(2));

  const outputHash = sha(stableStringify({ engine: ENGINE_VERSION, input, periodTotals, totals, cashflows }));
  return {
    engineVersion: ENGINE_VERSION,
    name: input.name,
    kind: input.kind,
    currency: input.currency ?? "INR",
    baseDate: input.baseDate,
    horizonMonths: H,
    monthlyDiscountRate: rm.toFixed(10),
    periodTotals,
    cashflows,
    categoryTotals,
    totals,
    warnings,
    outputHash,
  };
}

// ==================================================================== comparison
export interface ComparisonRow {
  name: string;
  kind: string;
  npv: string;
  nominalTco: string;
  equivalentMonthly: string;
  perChargeableSfMonth: string | null;
  perPlannedSeatMonth: string | null;
  incrementalNpvVsBaseline: string;
  breakEvenPeriodVsBaseline: number | null;
  rank: number;
  outputHash: string;
}
export interface Comparison { baseline: string; rows: ComparisonRow[]; results: FinanceResult[]; warnings: string[] }

/** Cumulative discounted cost by period. */
function cumulativeDiscounted(r: FinanceResult): D[] {
  const rm = new Dec(r.monthlyDiscountRate);
  const out: D[] = [];
  let c = ZERO;
  r.periodTotals.forEach((v, p) => {
    c = c.plus(new Dec(v).times(rm.isZero() ? 1 : rm.plus(1).pow(-p)));
    out.push(c);
  });
  return out;
}

/**
 * Compare scenarios on equal terms. Refuses unequal horizons, base dates, discount rates or currencies
 * (spec: "Do not compare a three-year package with a five-year total"). First input is the baseline.
 */
export function compareScenarios(inputs: FinanceInput[]): Comparison {
  if (inputs.length < 1) throw new FinanceInputError("at least one scenario required");
  const b = inputs[0];
  for (const s of inputs.slice(1)) {
    if (s.horizonMonths !== b.horizonMonths) throw new FinanceInputError(`unequal horizons: "${b.name}" ${b.horizonMonths} vs "${s.name}" ${s.horizonMonths} months`, "horizonMonths");
    if (s.baseDate !== b.baseDate) throw new FinanceInputError(`unequal base dates: ${b.baseDate} vs ${s.baseDate}`, "baseDate");
    if (!d(s.annualDiscountRatePct).eq(d(b.annualDiscountRatePct))) throw new FinanceInputError("unequal discount rates", "annualDiscountRatePct");
    if ((s.currency ?? "INR") !== (b.currency ?? "INR")) throw new FinanceInputError("currency mismatch", "currency");
  }
  const results = inputs.map(evaluate);
  const cums = results.map(cumulativeDiscounted);
  const order = results.map((r, i) => ({ i, npv: new Dec(r.totals.npv) })).sort((x, y) => x.npv.cmp(y.npv) || x.i - y.i);
  const rankOf = new Map(order.map((o, k) => [o.i, k + 1]));
  const rows: ComparisonRow[] = results.map((r, i) => {
    let be: number | null = null;
    if (i > 0) {
      for (let p = cums[i].length - 1; p >= 0; p--) {
        if (cums[i][p].lte(cums[0][p])) be = p; else break;
      }
    }
    return {
      name: r.name, kind: r.kind, npv: r.totals.npv, nominalTco: r.totals.nominalTco, equivalentMonthly: r.totals.equivalentMonthly,
      perChargeableSfMonth: r.totals.perChargeableSfMonth, perPlannedSeatMonth: r.totals.perPlannedSeatMonth,
      incrementalNpvVsBaseline: new Dec(r.totals.npv).minus(results[0].totals.npv).toFixed(2),
      breakEvenPeriodVsBaseline: i === 0 ? null : be,
      rank: rankOf.get(i)!, outputHash: r.outputHash,
    };
  });
  return { baseline: b.name, rows, results, warnings: results.flatMap((r) => r.warnings.map((w) => `${r.name}: ${w}`)) };
}

// ==================================================================== sensitivities
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function sensitivities(input: FinanceInput): Sensitivity[] {
  const base = evaluate(input);
  const baseNpv = new Dec(base.totals.npv);
  const out: Sensitivity[] = [];
  const run = (label: string, parameter: string, delta: string, mutate: (x: FinanceInput) => void) => {
    const x = clone(input);
    mutate(x);
    try {
      const r = evaluate(x);
      out.push({ label, parameter, delta, npv: r.totals.npv, npvChange: new Dec(r.totals.npv).minus(baseNpv).toFixed(2) });
    } catch { /* infeasible variation (e.g. negative rate) is skipped */ }
  };
  if (input.rent) {
    run("Rent +10%", "rent.rate", "+10%", (x) => { x.rent!.rate = d(x.rent!.rate).times(1.1).toString(); x.rent!.schedule = x.rent!.schedule?.map((s) => ({ ...s, rate: d(s.rate).times(1.1).toString() })); });
    run("Rent -10%", "rent.rate", "-10%", (x) => { x.rent!.rate = d(x.rent!.rate).times(0.9).toString(); x.rent!.schedule = x.rent!.schedule?.map((s) => ({ ...s, rate: d(s.rate).times(0.9).toString() })); });
    if (input.rent.escalation) {
      run("Escalation +2.5pp", "rent.escalation.pct", "+2.5pp", (x) => { x.rent!.escalation!.pct = d(x.rent!.escalation!.pct).plus(2.5).toString(); });
      run("Escalation -2.5pp", "rent.escalation.pct", "-2.5pp", (x) => { x.rent!.escalation!.pct = d(x.rent!.escalation!.pct).minus(2.5).toString(); });
    }
  }
  if (input.capex) {
    run("Fit-out +20%", "capex.fitoutCost", "+20%", (x) => { x.capex!.fitoutCost = d(x.capex!.fitoutCost).times(1.2).toString(); });
    run("Fit-out -20%", "capex.fitoutCost", "-20%", (x) => { x.capex!.fitoutCost = d(x.capex!.fitoutCost).times(0.8).toString(); if (x.financing && d(x.financing.principal).gt(d(x.capex!.fitoutCost).minus(d(x.capex!.landlordContribution)))) x.financing.principal = d(x.capex!.fitoutCost).minus(d(x.capex!.landlordContribution)).toString(); });
  }
  run("Discount rate +2pp", "annualDiscountRatePct", "+2pp", (x) => { x.annualDiscountRatePct = d(x.annualDiscountRatePct).plus(2).toString(); });
  run("Discount rate -2pp", "annualDiscountRatePct", "-2pp", (x) => { x.annualDiscountRatePct = d(x.annualDiscountRatePct).minus(2).toString(); });
  if (input.move?.parallelMonths) run("Move delay +3 months parallel rent", "move.parallelMonths", "+3", (x) => { x.move!.parallelMonths = (x.move!.parallelMonths ?? 0) + 3; });
  return out;
}

// ==================================================================== concession equivalence
export type Concession =
  | { type: "rent_free"; months: number }
  | { type: "capex_support"; amount: Num; period?: number }
  | { type: "deposit_months"; months: Num }
  | { type: "escalation_pct"; pct: Num }
  | { type: "rent_rate"; rate: Num };

export interface ConcessionValue {
  concession: Concession;
  npvBase: string;
  npvWith: string;
  /** Positive = value to the occupier (NPV saving). */
  npvValue: string;
  /** Flat reduction in ₹ per billing unit per month over in-horizon lease months with the same NPV. */
  equivalentRateReduction: string | null;
  /** Value expressed in first-lease-month rent (discounted) — "worth N rent-free months". */
  equivalentRentFreeMonths: string | null;
}

/** Concession equivalence (spec Part I §8 advanced additions): convert rent-free/capex/deposit/escalation changes to comparable NPV. */
export function concessionEquivalence(base: FinanceInput, concessions: Concession[]): ConcessionValue[] {
  const b = evaluate(base);
  const rm = new Dec(b.monthlyDiscountRate);
  const df = (t: number) => (rm.isZero() ? new Dec(1) : rm.plus(1).pow(-t));
  const r = base.rent;
  const start = r?.startPeriod ?? 1;
  const units = !r ? null : r.basis === "chargeable" ? d(base.area.chargeableSf) : r.basis === "carpet" ? d(base.area.carpetSf) : r.basis === "seat" ? new Dec(r.committedSeats ?? base.area.plannedSeats ?? 0) : new Dec(1);
  const lastLease = base.afterTenure === "continue_same_terms" ? base.horizonMonths : Math.min(base.horizonMonths, start + (base.tenureMonths ?? base.horizonMonths - start + 1) - 1);
  let leaseAnnuity = ZERO;
  for (let p = start; p <= lastLease; p++) leaseAnnuity = leaseAnnuity.plus(df(p));
  const firstMonthRentPv = r && units ? units.times(d(r.schedule?.length ? r.schedule[0].rate : r.rate)).times(df(start)) : null;

  return concessions.map((c) => {
    const x = clone(base);
    switch (c.type) {
      case "rent_free":
        if (!x.rent) throw new FinanceInputError("rent_free concession needs rent");
        x.rent.rentFreeMonths = (x.rent.rentFreeMonths ?? 0) + c.months; break;
      case "capex_support":
        x.capex = x.capex ?? { fitoutCost: 0 };
        x.capex.landlordContribution = d(x.capex.landlordContribution).plus(d(c.amount)).toString();
        if (c.period !== undefined) x.capex.contributionPeriod = c.period;
        break;
      case "deposit_months":
        if (!x.deposit || x.deposit.amount !== undefined) throw new FinanceInputError("deposit_months concession needs a months-based deposit");
        x.deposit.months = d(x.deposit.months).plus(d(c.months)).toString(); break;
      case "escalation_pct":
        if (!x.rent?.escalation) throw new FinanceInputError("escalation concession needs an escalation");
        x.rent.escalation.pct = d(x.rent.escalation.pct).plus(d(c.pct)).toString(); break;
      case "rent_rate":
        if (!x.rent) throw new FinanceInputError("rent_rate concession needs rent");
        x.rent.rate = d(x.rent.rate).plus(d(c.rate)).toString(); break;
    }
    const w = evaluate(x);
    const value = new Dec(b.totals.npv).minus(w.totals.npv);
    return {
      concession: c,
      npvBase: b.totals.npv,
      npvWith: w.totals.npv,
      npvValue: value.toFixed(2),
      equivalentRateReduction: units && units.gt(0) && leaseAnnuity.gt(0) ? value.div(leaseAnnuity.times(units)).toFixed(4) : null,
      equivalentRentFreeMonths: firstMonthRentPv && firstMonthRentPv.gt(0) ? value.div(firstMonthRentPv).toFixed(2) : null,
    };
  });
}

// ==================================================================== fit-out finance comparison (partner neutrality)
export interface FinancingOfferResult {
  partnerName: string;
  partnerId: string | null;
  npv: string;
  nominalTco: string;
  interestTotal: string | null;
  financingPremiumVsCash: string;   // NPV(offer) - NPV(pay cash)
  peakCumulativeOutflow: string;
  missingUnderwritingTerms: string[];
  outputHash: string;
}

const UNDERWRITING_TERMS: [keyof import("./types").FinancingInput, string][] = [
  ["upfrontFee", "Processing/upfront fees"],
  ["securityDeposit", "Security deposit required by the financier"],
  ["residualBuyout", "Residual value / ownership of fit-out at end of term"],
  ["earlyTerminationPeriod", "Early termination / prepayment terms"],
];

/**
 * Compare fit-out financing offers on equal terms: same principal, capex, horizon and discount rate.
 * Every offer is shown (partner neutrality) alongside paying cash.
 */
export function compareFinancingOffers(base: FinanceInput, offers: import("./types").FinancingInput[]): { cash: FinanceResult; offers: FinancingOfferResult[] } {
  if (!base.capex) throw new FinanceInputError("financing comparison needs capex");
  const cashInput = clone(base);
  cashInput.financing = null;
  const cash = evaluate(cashInput);
  const principals = new Set(offers.map((o) => d(o.principal).toFixed(2)));
  if (principals.size > 1) throw new FinanceInputError("offers must finance the same principal to be compared on equal terms", "financing.principal");
  return {
    cash,
    offers: offers.map((o) => {
      const x = clone(base);
      x.financing = o;
      const r = evaluate(x);
      return {
        partnerName: o.partnerName,
        partnerId: o.partnerId ?? null,
        npv: r.totals.npv,
        nominalTco: r.totals.nominalTco,
        interestTotal: r.totals.financingInterestTotal,
        financingPremiumVsCash: new Dec(r.totals.npv).minus(cash.totals.npv).toFixed(2),
        peakCumulativeOutflow: r.totals.peakCumulativeOutflow,
        missingUnderwritingTerms: UNDERWRITING_TERMS.filter(([k]) => o[k] === undefined || o[k] === null).map(([, l]) => l),
        outputHash: r.outputHash,
      };
    }),
  };
}
