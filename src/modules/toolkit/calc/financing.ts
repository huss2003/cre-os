/**
 * Fit-out financing — formula "loan-1.0". PURE, deterministic (decimal.js), never AI.
 * EMI = P·r·(1+r)^n / ((1+r)^n − 1), r = annual% ÷ 12 ÷ 100 (0% ⇒ P ÷ n).
 * Full precision internally; each schedule row is rounded to paise (interest = round(opening × r)), EMI rounded to paise,
 * and the final row absorbs the residue so closing = 0.00 exactly.
 * Moratorium (optional, months BEFORE the n EMI months): "interest_only" pays interest monthly; "capitalised" adds it to principal.
 * Processing fee: % of financed amount or fixed; GST on fee is explicit (unknown is flagged, never assumed).
 */
import Decimal from "decimal.js";
import { num } from "./fitout";
import { assertValidInputs, InputRangeError } from "./validate";

export const LOAN_FORMULA = "loan-1.0";
type Num = string | number | null | undefined;
export interface LoanInput {
  projectCost?: Num; clientContribution?: Num; financedAmount?: Num;
  annualRatePct: Num; tenureMonths: Num;
  feeType?: "pct" | "fixed" | "none"; feeValue?: Num; feeTaxPct?: Num;
  moratoriumMonths?: Num; moratoriumMode?: "interest_only" | "capitalised";
}
export interface ScheduleRow { month: number; phase: "moratorium" | "emi"; opening: string; interest: string; principal: string; payment: string; closing: string }
export interface LoanResult {
  formula: string; financed: string; emi: string; emiExact: string; monthlyRate: string;
  schedule: ScheduleRow[];
  totals: { payments: string; interest: string; principal: string; fee: string; feeTax: string | null; costOfFinancing: string };
  effectiveAnnualRatePct: string | null; cashflow: Array<{ month: number; amount: string; note: string }>;
  missing: string[];
}

const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
const p2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const f2 = (d: Decimal) => p2(d).toFixed(2);

export function emiExact(P: Decimal.Value, monthlyRate: Decimal.Value, n: number): Decimal {
  const p = new D(P), r = new D(monthlyRate);
  if (n <= 0) throw new Error("Tenure must be at least 1 month");
  if (r.isZero()) return p.div(n);
  const f = r.plus(1).pow(n);
  return p.times(r).times(f).div(f.minus(1));
}

export function computeLoan(input: LoanInput): LoanResult {
  assertValidInputs(input);
  const missing: string[] = [];
  const cost = num(input.projectCost), contrib = num(input.clientContribution);
  let financed = num(input.financedAmount);
  if (cost && contrib && contrib.gt(cost)) throw new InputRangeError("clientContribution", "Client contribution cannot be more than the project cost");
  if (financed && cost && financed.gt(cost.minus(contrib ?? 0))) {
    throw new InputRangeError("financedAmount", `Financed amount cannot be more than project cost − client contribution (₹${cost.minus(contrib ?? 0).toFixed(2)})`);
  }
  if (!financed && cost && contrib) financed = cost.minus(contrib);
  if (!financed && cost && !contrib) missing.push("Client contribution not given (financed amount = project cost − contribution)");
  if (!financed || financed.lte(0)) throw new Error("Financed amount is required (enter it, or project cost and client contribution)");
  const rate = num(input.annualRatePct), nD = num(input.tenureMonths);
  if (rate === null || rate.lt(0)) throw new Error("Annual interest rate is required (0 is allowed)");
  if (!nD || !nD.isInteger() || nD.lt(1)) throw new Error("Tenure must be a whole number of months ≥ 1");
  const n = nD.toNumber();
  const m = num(input.moratoriumMonths)?.toNumber() ?? 0;
  if (m < 0 || !Number.isInteger(m)) throw new Error("Moratorium must be whole months");
  const r = new D(rate).div(1200);

  const schedule: ScheduleRow[] = [];
  let bal = p2(new D(financed));
  let month = 0, totInt = new D(0), totPrin = new D(0), totPay = new D(0);
  for (let k = 0; k < m; k++) {
    month++;
    const interest = p2(bal.times(r));
    const cap = input.moratoriumMode === "capitalised";
    const closing = cap ? bal.plus(interest) : bal;
    const payment = cap ? new D(0) : interest;
    schedule.push({ month, phase: "moratorium", opening: f2(bal), interest: f2(interest), principal: f2(cap ? interest.neg() : new D(0)), payment: f2(payment), closing: f2(closing) });
    totInt = totInt.plus(interest); totPay = totPay.plus(payment); if (cap) totPrin = totPrin.minus(interest); bal = closing;
  }
  const emiX = emiExact(bal, r, n);
  const emi = p2(emiX);
  for (let k = 1; k <= n; k++) {
    month++;
    const interest = p2(bal.times(r));
    let principal = emi.minus(interest), payment = emi;
    if (k === n) { principal = bal; payment = bal.plus(interest); }
    const closing = bal.minus(principal);
    schedule.push({ month, phase: "emi", opening: f2(bal), interest: f2(interest), principal: f2(principal), payment: f2(payment), closing: f2(closing) });
    totInt = totInt.plus(interest); totPrin = totPrin.plus(principal); totPay = totPay.plus(payment); bal = closing;
  }

  let fee = new D(0); let feeTax: Decimal | null = new D(0);
  const fv = num(input.feeValue);
  if (input.feeType === "pct" || input.feeType === "fixed") {
    if (fv === null) missing.push("Processing fee value not given");
    else fee = p2(input.feeType === "pct" ? new D(financed).times(fv).div(100) : fv);
    const ft = num(input.feeTaxPct);
    if (ft === null) { feeTax = null; missing.push("Tax on processing fee not stated (never assumed)"); }
    else feeTax = p2(fee.times(ft).div(100));
  }
  const feeAll = fee.plus(feeTax ?? 0);
  const costOfFinancing = totInt.plus(feeAll);

  // Effective annual rate: monthly IRR of (financed − fees at t0, −payments) by bisection, annualised ×12 (nominal, like the quoted rate).
  const flows = [new D(financed).minus(feeAll), ...schedule.map((s) => new D(s.payment).neg())];
  const npv = (x: Decimal) => flows.reduce((a, cf, t) => a.plus(cf.div(x.plus(1).pow(t))), new D(0));
  let eff: string | null = null;
  if (feeTax !== null) {
    let lo = new D(0), hi = new D(1);
    if (npv(lo).gte(0)) eff = "0.0000";
    else {
      for (let i = 0; i < 200; i++) { const mid = lo.plus(hi).div(2); if (npv(mid).lt(0)) lo = mid; else hi = mid; }
      eff = lo.plus(hi).div(2).times(1200).toDecimalPlaces(4).toFixed(4);
    }
  }
  const cashflow: LoanResult["cashflow"] = [];
  if (contrib || feeAll.gt(0)) cashflow.push({ month: 0, amount: f2((contrib ?? new D(0)).plus(feeAll)), note: `${contrib ? "Client contribution" : ""}${contrib && feeAll.gt(0) ? " + " : ""}${feeAll.gt(0) ? "processing fee" + (feeTax && feeTax.gt(0) ? " incl. tax" : "") : ""}` });
  for (const s of schedule) cashflow.push({ month: s.month, amount: s.payment, note: s.phase === "moratorium" ? "Moratorium" : "EMI" });

  return {
    formula: LOAN_FORMULA, financed: f2(new D(financed)), emi: f2(emi), emiExact: emiX.toDecimalPlaces(6).toFixed(6), monthlyRate: r.toDecimalPlaces(10).toFixed(10),
    schedule,
    totals: { payments: f2(totPay), interest: f2(totInt), principal: f2(totPrin), fee: f2(fee), feeTax: feeTax ? f2(feeTax) : null, costOfFinancing: f2(costOfFinancing) },
    effectiveAnnualRatePct: eff, cashflow, missing,
  };
}
