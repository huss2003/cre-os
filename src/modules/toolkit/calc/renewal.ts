import Decimal from "decimal.js";
import { assertValidInputs } from "./validate";

/**
 * Renewal vs relocation (formula "rvr-1.0"). PURE, deterministic, decimal.js only (S5).
 *
 * Timeline: months 1..P (P = comparison period). All one-offs fall in month 1. Rent in month m is
 * 0 during rent-free months, else rent × (1+e)^floor((m-1)/every). Relocation also pays the CURRENT rent for the
 * overlap months (1..overlap) on top of the new rent. PV discounts month m by (1+r_m)^-(m-1), r_m = (1+r_a)^(1/12)-1
 * (payments in advance). Deposits are refundable: shown in initial cash, excluded from cost totals and PV.
 * Break-even: first month from which relocation's cumulative cost stays at or below renewal's to the end of the
 * period; "none within period" otherwise. Blank = unknown → listed in `missing`, never treated as zero; totals are
 * then "known costs only". Relocation is never recommended on rent alone: the financial and operational verdicts are
 * reported separately.
 */
export const RVR_VERSION = "rvr-1.0";
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type D = Decimal;
export type N = number | string | null | undefined;
const known = (x: N) => x !== null && x !== undefined && String(x).trim() !== "" && Number.isFinite(Number(x));
const dv = (x: N): D => new Dec(known(x) ? String(x).trim() : 0);
const s2 = (x: D) => x.toFixed(2);
const int = (x: N) => (known(x) && Number(x) >= 0 ? Math.floor(Number(x)) : null);

export interface Escalation { pct: N; everyMonths: N }
export interface RenewalInput {
  currentRentMonthly: N; proposedRentMonthly: N; escalation?: Escalation | null; extensionMonths: N; rentFreeMonths: N;
  camMonthly: N; depositChange: N; refurbishment: N; maintenanceMonthly: N; otherMonthly: N; otherOneOff: N;
}
export interface RelocationInput {
  newRentMonthly: N; escalation?: Escalation | null; rentFreeMonths: N; camMonthly: N; deposit: N; oldDepositReturned?: N;
  fitout: N; moving: N; restorationOld: N; overlapMonths: N; brokerage: N; itRelocation: N; downtimeCost: N; employeeTransition: N;
  otherMonthly: N; otherOneOff: N;
}
export const NONFIN = ["location", "connectivity", "employee_convenience", "building_quality", "suitability", "infrastructure", "expansion_flexibility", "disruption"] as const;
export type NonFinKey = (typeof NONFIN)[number];
export const NONFIN_LABEL: Record<NonFinKey, string> = {
  location: "Location", connectivity: "Connectivity", employee_convenience: "Employee convenience", building_quality: "Building quality",
  suitability: "Suitability", infrastructure: "Infrastructure", expansion_flexibility: "Expansion flexibility", disruption: "Low disruption (5 = least disruptive)",
};
export interface RvrInput {
  renewal: RenewalInput; relocation: RelocationInput; comparisonMonths?: N; discountRatePct: N;
  scores?: Partial<Record<NonFinKey, { renewal: N; relocation: N }>>;
}
export interface Line { label: string; amount: string | null; kind: "monthly" | "one_off" | "deposit"; status: "known" | "unknown" }
export interface SideResult {
  complete: boolean; lines: Line[]; total: string; recurringTotal: string; oneOffTotal: string; annualAverage: string;
  initialCash: string; depositNet: string | null; initialCashInclDeposit: string; pv: string; monthly: string[]; cumulative: string[];
}
export interface RvrResult {
  formula: string; ok: boolean; comparisonMonths: number | null; discountRatePct: string | null;
  renewal: SideResult | null; relocation: SideResult | null;
  difference: { total: string; pv: string; cheaper: "renewal" | "relocation" | "equal" } | null;
  breakEven: { month: number | null; text: string } | null;
  nonFinancial: { rows: { key: NonFinKey; label: string; renewal: number | null; relocation: number | null }[]; renewalAvg: string | null; relocationAvg: string | null; scored: number };
  financiallyPreferable: "renewal" | "relocation" | "equal" | null; operationallyPreferable: "renewal" | "relocation" | "equal" | null;
  verdict: string; risks: string[]; negotiation: string[]; assumptions: string[]; missing: string[];
}

function escF(e: Escalation | null | undefined, m: number): D {
  if (!e || !known(e.pct) || dv(e.pct).isZero()) return new Dec(1);
  const every = known(e.everyMonths) && Number(e.everyMonths) > 0 ? Math.floor(Number(e.everyMonths)) : 12;
  return dv(e.pct).div(100).plus(1).pow(Math.floor((m - 1) / every));
}

interface Spec { rent: D; esc?: Escalation | null; rentFree: number; fixed: D; oneOff: D; overlap?: { months: number; monthly: D } }
function run(s: Spec, P: number, rm: D) {
  const monthly: string[] = []; const cumulative: string[] = []; let cum = new Dec(0); let pv = new Dec(0); let recurring = new Dec(0);
  for (let m = 1; m <= P; m++) {
    let rec = (m <= s.rentFree ? new Dec(0) : s.rent.times(escF(s.esc, m))).plus(s.fixed);
    if (s.overlap && m <= s.overlap.months) rec = rec.plus(s.overlap.monthly);
    recurring = recurring.plus(rec);
    const c = rec.plus(m === 1 ? s.oneOff : 0);
    cum = cum.plus(c); monthly.push(s2(c)); cumulative.push(s2(cum));
    pv = pv.plus(c.div(rm.plus(1).pow(m - 1)));
  }
  return { monthly, cumulative, total: cum, pv, recurring };
}

export function compareRenewalRelocation(inp: RvrInput): RvrResult {
  assertValidInputs(inp);
  const missing: string[] = []; const assumptions: string[] = []; const risks: string[] = []; const negotiation: string[] = [];
  const r = inp.renewal; const l = inp.relocation;
  const req = (x: N, label: string) => { if (!known(x)) missing.push(label); return known(x); };
  const okR = req(r.proposedRentMonthly, "Renewal: proposed monthly rent");
  const okL = req(l.newRentMonthly, "Relocation: new monthly rent");
  let P = int(inp.comparisonMonths); if (P === 0) P = null;
  if (!P && int(r.extensionMonths)) { P = int(r.extensionMonths); assumptions.push(`Comparison period not given: using the renewal extension, ${P} months.`); }
  if (!P) missing.push("Comparison period (months) or renewal extension");
  const okD = req(inp.discountRatePct, "Discount rate (% per year) — enter 0 for undiscounted");
  const lines = (pairs: [N, string, Line["kind"], string][], complete: { v: boolean }) =>
    pairs.map(([v, label, kind, miss]) => {
      if (!known(v)) { missing.push(miss); complete.v = false; return { label, amount: null, kind, status: "unknown" } as Line; }
      return { label, amount: s2(dv(v)), kind, status: "known" } as Line;
    });
  const cR = { v: true }; const cL = { v: true };
  const rLines = lines([
    [r.proposedRentMonthly, "Proposed rent", "monthly", "Renewal: proposed monthly rent"], [r.camMonthly, "CAM", "monthly", "Renewal: CAM (monthly)"],
    [r.maintenanceMonthly, "Maintenance", "monthly", "Renewal: maintenance (monthly)"], [r.otherMonthly, "Other recurring", "monthly", "Renewal: other recurring costs"],
    [r.refurbishment, "Refurbishment", "one_off", "Renewal: refurbishment cost"], [r.otherOneOff, "Other one-off", "one_off", "Renewal: other one-off costs"],
    [r.depositChange, "Deposit top-up (refundable)", "deposit", "Renewal: change in security deposit"],
  ], cR);
  const lLines = lines([
    [l.newRentMonthly, "New rent", "monthly", "Relocation: new monthly rent"], [l.camMonthly, "CAM", "monthly", "Relocation: CAM (monthly)"],
    [l.otherMonthly, "Other recurring", "monthly", "Relocation: other recurring costs"],
    [l.fitout, "Fit-out", "one_off", "Relocation: fit-out"], [l.moving, "Moving", "one_off", "Relocation: moving cost"],
    [l.restorationOld, "Restoration of old premises", "one_off", "Relocation: restoration of current premises"], [l.brokerage, "Brokerage", "one_off", "Relocation: brokerage"],
    [l.itRelocation, "IT relocation", "one_off", "Relocation: IT relocation"], [l.downtimeCost, "Downtime cost", "one_off", "Relocation: business downtime cost"],
    [l.employeeTransition, "Employee transition", "one_off", "Relocation: employee transition cost"], [l.otherOneOff, "Other one-off", "one_off", "Relocation: other one-off costs"],
    [l.deposit, "New security deposit (refundable)", "deposit", "Relocation: new security deposit"],
  ], cL);
  if (!known(r.rentFreeMonths)) missing.push("Renewal: rent-free months (0 if none)");
  if (!known(l.rentFreeMonths)) missing.push("Relocation: rent-free months (0 if none)");
  if (!known(l.overlapMonths)) missing.push("Relocation: overlap months paying both rents (0 if none)");
  if (!r.escalation || !known(r.escalation.pct)) missing.push("Renewal: escalation — none applied");
  if (!l.escalation || !known(l.escalation.pct)) missing.push("Relocation: escalation — none applied");
  const overlapM = int(l.overlapMonths) ?? 0;
  if (overlapM > 0 && !known(r.currentRentMonthly)) missing.push("Current monthly rent — needed to cost the overlap months");
  if (!known(l.oldDepositReturned)) missing.push("Relocation: current deposit returned on exit");

  const nf = NONFIN.map((key) => {
    const s = inp.scores?.[key]; const ok = (x: N) => (known(x) && Number(x) >= 1 && Number(x) <= 5 ? Number(x) : null);
    return { key, label: NONFIN_LABEL[key], renewal: ok(s?.renewal), relocation: ok(s?.relocation) };
  });
  const both = nf.filter((x) => x.renewal !== null && x.relocation !== null);
  const ra = both.length ? both.reduce((s, x) => s.plus(x.renewal!), new Dec(0)).div(both.length) : null;
  const la = both.length ? both.reduce((s, x) => s.plus(x.relocation!), new Dec(0)).div(both.length) : null;
  if (both.length < NONFIN.length) missing.push(`Non-financial scores: ${NONFIN.length - both.length} of ${NONFIN.length} criteria not scored for both`);
  const operationally = ra && la ? (ra.gt(la) ? "renewal" : la.gt(ra) ? "relocation" : "equal") : null;

  assumptions.push("Deposits are refundable: shown in initial cash, excluded from totals and PV.", "All one-off costs fall in month 1; payments monthly in advance.", "Overlap months are costed at the current rent on top of the new rent.");
  const base = { formula: RVR_VERSION, comparisonMonths: P, discountRatePct: okD ? dv(inp.discountRatePct).toString() : null, assumptions, nonFinancial: { rows: nf, renewalAvg: ra ? ra.toFixed(2) : null, relocationAvg: la ? la.toFixed(2) : null, scored: both.length }, operationallyPreferable: operationally as RvrResult["operationallyPreferable"] };
  if (!okR || !okL || !P || !okD) {
    return { ...base, ok: false, renewal: null, relocation: null, difference: null, breakEven: null, financiallyPreferable: null, verdict: "Not enough information for the financial comparison — complete the missing items.", risks, negotiation, missing: [...new Set(missing)] };
  }
  const rm = dv(inp.discountRatePct).div(100).plus(1).pow(new Dec(1).div(12)).minus(1);
  const rs = run({ rent: dv(r.proposedRentMonthly), esc: r.escalation, rentFree: int(r.rentFreeMonths) ?? 0, fixed: dv(r.camMonthly).plus(dv(r.maintenanceMonthly)).plus(dv(r.otherMonthly)), oneOff: dv(r.refurbishment).plus(dv(r.otherOneOff)) }, P, rm);
  const lOne = [l.fitout, l.moving, l.restorationOld, l.brokerage, l.itRelocation, l.downtimeCost, l.employeeTransition, l.otherOneOff].reduce((s: D, x) => s.plus(dv(x)), new Dec(0));
  const ls = run({ rent: dv(l.newRentMonthly), esc: l.escalation, rentFree: int(l.rentFreeMonths) ?? 0, fixed: dv(l.camMonthly).plus(dv(l.otherMonthly)), oneOff: lOne, overlap: { months: Math.min(overlapM, P), monthly: dv(r.currentRentMonthly) } }, P, rm);
  if (overlapM > 0) lLines.push({ label: `Overlap: current rent × ${overlapM} m`, amount: s2(dv(r.currentRentMonthly).times(Math.min(overlapM, P))), kind: "one_off", status: known(r.currentRentMonthly) ? "known" : "unknown" });

  const side = (x: ReturnType<typeof run>, ls_: Line[], complete: boolean, dep: D | null): SideResult => ({
    complete, lines: ls_, total: s2(x.total), recurringTotal: s2(x.recurring), oneOffTotal: s2(x.total.minus(x.recurring)),
    annualAverage: s2(x.total.div(P!).times(12)), initialCash: x.monthly[0], depositNet: dep ? s2(dep) : null,
    initialCashInclDeposit: s2(new Dec(x.monthly[0]).plus(dep ?? 0)), pv: s2(x.pv), monthly: x.monthly, cumulative: x.cumulative,
  });
  const lDep = known(l.deposit) ? dv(l.deposit).minus(dv(l.oldDepositReturned)) : null;
  const renewal = side(rs, rLines, cR.v, known(r.depositChange) ? dv(r.depositChange) : null);
  const relocation = side(ls, lLines, cL.v, lDep);
  const diff = ls.total.minus(rs.total); // >0: relocation costs more
  const pvDiff = ls.pv.minus(rs.pv);
  const cheaper = pvDiff.isZero() ? "equal" : pvDiff.lt(0) ? "relocation" : "renewal";
  let be: number | null = null;
  for (let m = P; m >= 1; m--) { if (new Dec(ls.cumulative[m - 1]).lte(rs.cumulative[m - 1])) be = m; else break; }
  const breakEven = { month: be, text: be === null ? "None within period — relocation stays cumulatively more expensive." : be === 1 ? "Relocation is cumulatively cheaper from month 1." : `Relocation becomes cumulatively cheaper from month ${be} and stays cheaper to month ${P}.` };

  // Risks / negotiation (deterministic)
  if (lOne.gt(0)) risks.push(`Relocation needs ₹${s2(lOne)} of one-off spend up front; overruns on fit-out or downtime move break-even later.`);
  if (be !== null && be > P * 0.75) risks.push("Break-even falls late in the period: small cost overruns can remove the saving.");
  if (overlapM > 0) risks.push(`Overlap of ${overlapM} month(s) paying two rents; delays in fit-out extend it.`);
  if (r.escalation && known(r.escalation.pct) && l.escalation && known(l.escalation.pct) && dv(r.escalation.pct).gt(dv(l.escalation.pct))) risks.push("Renewal escalation is higher than the relocation quote.");
  if (!cR.v || !cL.v) risks.push("Some costs are missing: totals are known costs only and may change the result.");
  const relRel = rs.total.isZero() ? new Dec(0) : diff.abs().div(rs.total);
  if (cheaper !== "equal" && relRel.lt(0.05)) risks.push(`The financial difference is under 5% of renewal cost (₹${s2(diff.abs())}) — within typical estimating error.`);
  // Rent reduction needed to match relocation (renewal-equivalent): diff ÷ number of rent-paying, escalation-weighted months.
  let rentWeight = new Dec(0); const rf = int(r.rentFreeMonths) ?? 0;
  for (let m = rf + 1; m <= P; m++) rentWeight = rentWeight.plus(escF(r.escalation, m));
  if (diff.lt(0) && rentWeight.gt(0)) {
    const cut = diff.abs().div(rentWeight);
    negotiation.push(`Use the relocation quote as leverage: renewal rent would need to fall by about ₹${s2(cut)}/month (to ₹${s2(dv(r.proposedRentMonthly).minus(cut))}) to match relocation's total cost over ${P} months.`);
  }
  negotiation.push("Ask the landlord for rent-free months or a refurbishment contribution in exchange for the renewal term.");
  if (r.escalation && known(r.escalation.pct)) negotiation.push(`Negotiate the ${dv(r.escalation.pct).toString()}% escalation down or to a longer interval.`);
  if (known(r.depositChange) && dv(r.depositChange).gt(0)) negotiation.push("Resist the deposit top-up, or seek interest on it.");
  if (lOne.gt(0)) negotiation.push("For relocation, seek landlord fit-out contribution / rent-free covering the fit-out period.");

  const fin = cheaper as RvrResult["financiallyPreferable"];
  let verdict = `Financially (PV at ${dv(inp.discountRatePct).toString()}%): ${fin === "equal" ? "no difference" : `${fin} is cheaper by ₹${s2(pvDiff.abs())} in present value (₹${s2(diff.abs())} undiscounted)`}. `;
  verdict += operationally ? `Operationally (${both.length} of ${NONFIN.length} criteria scored): ${operationally === "equal" ? "no clear difference" : `${operationally} scores higher (${ra!.toFixed(2)} vs ${la!.toFixed(2)})`}.` : "Operationally: not scored — enter the 1–5 scores.";
  if (fin === "relocation" && operationally !== "relocation") verdict += " Lower cost alone does not justify relocating: the operational case does not support it" + (operationally ? "." : " yet (scores missing).") + " Use the relocation numbers to negotiate the renewal.";
  else if (fin === "relocation" && operationally === "relocation") verdict += " Both views favour relocation; confirm the missing items and risks before advising.";
  else if (fin === "renewal" && operationally === "relocation") verdict += " Relocation costs more but scores better operationally — weigh whether the operational gain is worth the extra cost.";

  return { ...base, ok: true, renewal, relocation, difference: { total: s2(diff), pv: s2(pvDiff), cheaper }, breakEven, financiallyPreferable: fin, verdict, risks, negotiation, missing: [...new Set(missing)] };
}
