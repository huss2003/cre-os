/**
 * Commercial real-estate investment model — formula "inv-1.0". PURE, deterministic (decimal.js), never AI (S5).
 *
 * Timeline: acquisition at t=0; annual periods 1..H (holding years); income built month-by-month then summed per year.
 * Tenancy rent in month m (from acquisition) = area × rent × (1+e)^floor((m−1)/every) up to its expiry month; then
 *   `downtime` void months; then re-let at the re-letting rent with its own escalation counted from the re-let start.
 * CAM recovery = tenancy area × recovery ₹/SF/month while occupied. Opex = leasable area × opex ₹/SF/month (+ annual
 *   opex escalation). Capex reserve = leasable area × ₹/SF/year. NOI = rent + CAM recovery − opex − capex reserve.
 * Exit value = NOI of year H+1 ÷ exit cap rate; net exit = exit value × (1 − sale costs %).
 * Acquisition cost = price × (1 + stamp duty/registration %) + other acquisition costs.
 * Unlevered CF: t0 = −acquisition cost; t1..H = NOI; tH += net exit.
 * Debt (optional): loan = LTV × price; annual rate; interest-only or amortising (annuity over tenor). Levered CF:
 *   t0 = −acquisition cost + loan; t = NOI − debt service; tH += net exit − outstanding balance. DSCR = NOI ÷ debt service.
 * IRR: deterministic bracketed bisection on NPV(r) over [−99%, 1000%] with a convergence guard → null if no sign
 *   change / no convergence. NPV at the stated discount rate. Equity multiple = Σ inflows ÷ Σ outflows.
 * Sensitivities: exit cap ±50 bps, all rental income ±10%.
 * Unknown required inputs → dependent outputs null with a reason (S6). Area basis is stated, never converted.
 */
import Decimal from "decimal.js";
import type { AreaBasis } from "./bts";
import { assertValidInputs } from "./validate";

export const INV_FORMULA = "inv-1.0";
const Dec = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
type D = Decimal;
export type N = number | string | null | undefined;
const known = (x: N) => x !== null && x !== undefined && String(x).trim() !== "" && Number.isFinite(Number(String(x).trim()));
const dn = (x: N): D | null => (known(x) ? new Dec(String(x).trim()) : null);
const f2 = (d: D | null) => (d === null ? null : d.toDecimalPlaces(2).toFixed(2));
const pct = (d: D | null) => (d === null ? null : d.times(100).toDecimalPlaces(4).toFixed(4));

export interface Tenancy {
  name: string; areaSf: N; rentPerSfMonth: N; escalationPct: N; escalationEveryMonths: N;
  expiryMonth: N; downtimeMonths: N; reletRentPerSfMonth: N; reletEscalationPct?: N; camRecoveryPerSfMonth: N;
}
export interface Debt { ltvPct: N; ratePct: N; tenorYears: N; amortisation: "interest_only" | "amortising" }
export interface InvestmentInput {
  purchasePrice: N; stampDutyPct: N; otherAcquisitionCosts: N;
  leasableAreaSf: N; areaBasis: AreaBasis | null;
  tenancies: Tenancy[];
  opexPerSfMonth: N; opexEscalationPct: N; capexReservePerSfYear: N;
  holdingYears: N; exitCapRatePct: N; saleCostsPct: N; discountRatePct: N;
  debt?: Debt | null;
}
export interface YearRow { year: number; rent: string; camRecovery: string; opex: string; capex: string; noi: string; debtService: string | null; dscr: string | null; unlevered: string; levered: string | null }
export interface Metrics { irrPct: string | null; npv: string | null; equityMultiple: string | null }
export interface InvestmentResult {
  formula: string; ok: boolean;
  acquisition: { price: string | null; duties: string | null; other: string | null; total: string | null; loan: string | null; equity: string | null };
  years: YearRow[]; forwardNoi: string | null;
  yieldOnCostPct: string | null; goingInCapPct: string | null;
  exit: { value: string | null; saleCosts: string | null; net: string | null; loanBalance: string | null };
  unlevered: Metrics; levered: Metrics | null; minDscr: string | null;
  sensitivities: { label: string; exitValue: string | null; unleveredIrrPct: string | null; leveredIrrPct: string | null; npv: string | null }[];
  vacantAreaSf: string | null;
  nulls: Record<string, string>; missing: string[]; assumptions: string[]; method: string[];
}

// ───────────── finance primitives ─────────────
export function npv(rate: Decimal.Value, cfs: Decimal.Value[]): D {
  const r = new Dec(rate); let s = new Dec(0);
  cfs.forEach((c, t) => { s = s.plus(new Dec(c).div(r.plus(1).pow(t))); });
  return s;
}
/** IRR by bracketed bisection; null when cash flows don't change sign, NPV has no root in [−0.99, 10], or it fails to converge. */
export function irr(cfs: Decimal.Value[], opts: { lo?: number; hi?: number; tol?: string; maxIter?: number } = {}): D | null {
  const c = cfs.map((x) => new Dec(x));
  if (!c.some((x) => x.gt(0)) || !c.some((x) => x.lt(0))) return null;
  // scan a fixed grid for the first sign change (deterministic), then bisect inside it
  const grid = [-0.99, -0.9, -0.75, -0.5, -0.25, -0.1, 0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 10].filter((g) => g >= (opts.lo ?? -0.99) && g <= (opts.hi ?? 10));
  let a: D | null = null, b: D | null = null;
  for (let k = 0; k < grid.length - 1; k++) {
    const x = new Dec(grid[k]), y = new Dec(grid[k + 1]);
    const fx = npv(x, c), fy = npv(y, c);
    if (fx.isZero()) return x;
    if (fx.isNegative() !== fy.isNegative()) { a = x; b = y; break; }
  }
  if (!a || !b) return null;
  let lo: D = a, hi: D = b;
  const tol = new Dec(opts.tol ?? "1e-12"); let fa = npv(lo, c);
  for (let it = 0; it < (opts.maxIter ?? 400); it++) {
    const mid: D = lo.plus(hi).div(2); const fm = npv(mid, c);
    if (fm.isZero() || hi.minus(lo).abs().lt(tol)) return mid;
    if (fa.isNegative() === fm.isNegative()) { lo = mid; fa = fm; } else hi = mid;
  }
  return null; // convergence guard
}
export function annuity(principal: Decimal.Value, ratePct: Decimal.Value, years: number): D {
  const P = new Dec(principal), r = new Dec(ratePct).div(100);
  if (r.isZero()) return P.div(years);
  return P.times(r).div(new Dec(1).minus(r.plus(1).pow(-years)));
}
function multiple(cfs: D[]): D | null {
  const inn = cfs.filter((x) => x.gt(0)).reduce((a, b) => a.plus(b), new Dec(0));
  const out = cfs.filter((x) => x.lt(0)).reduce((a, b) => a.plus(b.abs()), new Dec(0));
  return out.isZero() ? null : inn.div(out);
}

// ───────────── core ─────────────
interface Core { years: { rent: D; cam: D; opex: D; capex: D; noi: D }[]; forward: D }
function operate(i: InvestmentInput, H: number, rentFactor: D): Core {
  const area = new Dec(String(i.leasableAreaSf));
  const opex = new Dec(String(i.opexPerSfMonth)), opEsc = new Dec(String(i.opexEscalationPct)).div(100), capex = new Dec(String(i.capexReservePerSfYear));
  const years: Core["years"] = [];
  for (let y = 1; y <= H + 1; y++) years.push({ rent: new Dec(0), cam: new Dec(0), opex: area.times(opex).times(12).times(opEsc.plus(1).pow(y - 1)), capex: area.times(capex), noi: new Dec(0) });
  for (const t of i.tenancies) {
    const a = new Dec(String(t.areaSf)), r = new Dec(String(t.rentPerSfMonth)), e = new Dec(String(t.escalationPct)).div(100);
    const every = known(t.escalationEveryMonths) && Number(t.escalationEveryMonths) > 0 ? Number(t.escalationEveryMonths) : 12;
    const exp = Number(t.expiryMonth), down = Number(t.downtimeMonths);
    const rr = new Dec(String(t.reletRentPerSfMonth)), re = new Dec(known(t.reletEscalationPct) ? String(t.reletEscalationPct) : String(t.escalationPct)).div(100);
    const cam = new Dec(String(t.camRecoveryPerSfMonth));
    const reletStart = exp + down + 1;
    for (let m = 1; m <= (H + 1) * 12; m++) {
      const y = years[Math.floor((m - 1) / 12)];
      let rent: D | null = null;
      if (m <= exp) rent = a.times(r).times(e.plus(1).pow(Math.floor((m - 1) / every)));
      else if (m >= reletStart) rent = a.times(rr).times(re.plus(1).pow(Math.floor((m - reletStart) / every)));
      if (rent) { y.rent = y.rent.plus(rent.times(rentFactor)); y.cam = y.cam.plus(a.times(cam)); }
    }
  }
  for (const y of years) y.noi = y.rent.plus(y.cam).minus(y.opex).minus(y.capex);
  return { years: years.slice(0, H), forward: years[H].noi };
}

export function computeInvestment(i: InvestmentInput): InvestmentResult {
  assertValidInputs(i);
  const missing: string[] = []; const nulls: Record<string, string> = {}; const assumptions: string[] = [];
  const need = (x: N, label: string) => { if (!known(x)) missing.push(label); return dn(x); };
  const price = need(i.purchasePrice, "Purchase price");
  const duty = need(i.stampDutyPct, "Stamp duty + registration %");
  const other = need(i.otherAcquisitionCosts, "Other acquisition costs (enter 0 if none)");
  const area = need(i.leasableAreaSf, "Leasable area (SF)");
  if (!i.areaBasis) missing.push("Area basis");
  need(i.opexPerSfMonth, "Landlord opex ₹/SF/month (enter 0 if fully recovered)");
  need(i.opexEscalationPct, "Opex escalation % per year (enter 0 if none)");
  need(i.capexReservePerSfYear, "Capex reserve ₹/SF/year (enter 0 if none)");
  const Hn = need(i.holdingYears, "Holding period (years)");
  const cap = need(i.exitCapRatePct, "Exit cap rate %");
  const sale = need(i.saleCostsPct, "Sale costs % (enter 0 if none)");
  const disc = need(i.discountRatePct, "Discount rate %");
  if (Hn && (!Hn.isInteger() || Hn.lt(1) || Hn.gt(50))) throw new Error("Holding period must be a whole number of years between 1 and 50");
  if (cap && cap.lte(0)) throw new Error("Exit cap rate must be greater than 0");
  if (!i.tenancies.length) missing.push("At least one tenancy (or model the asset as vacant)");
  let let_ = new Dec(0);
  i.tenancies.forEach((t, k) => {
    const nm = t.name || `Tenancy ${k + 1}`;
    for (const [v, l] of [[t.areaSf, "area"], [t.rentPerSfMonth, "rent ₹/SF/month"], [t.escalationPct, "escalation % (0 if none)"], [t.expiryMonth, "expiry (months from acquisition)"], [t.downtimeMonths, "downtime months after expiry"], [t.reletRentPerSfMonth, "re-letting rent ₹/SF/month"], [t.camRecoveryPerSfMonth, "CAM recovery ₹/SF/month (0 if none)"]] as [N, string][]) if (!known(v)) missing.push(`${nm}: ${l}`);
    if (known(t.areaSf)) let_ = let_.plus(String(t.areaSf));
  });
  const vacant = area ? area.minus(let_) : null;
  if (vacant && vacant.lt(0)) throw new Error("Tenancy areas add up to more than the leasable area");
  if (vacant && vacant.gt(0)) assumptions.push(`${f2(vacant)} SF is not let in the tenancy schedule and earns no rent (add a tenancy with a letting assumption to change this).`);

  let loan: D | null = null; let dRate: D | null = null; let tenor: number | null = null;
  if (i.debt) {
    const ltv = need(i.debt.ltvPct, "Debt: LTV %"); dRate = need(i.debt.ratePct, "Debt: interest rate %"); const tn = need(i.debt.tenorYears, "Debt: tenor (years)");
    if (tn && (!tn.isInteger() || tn.lt(1))) throw new Error("Debt tenor must be a whole number of years ≥ 1");
    tenor = tn ? tn.toNumber() : null;
    loan = ltv && price ? price.times(ltv).div(100) : null;
  }
  const acqTotal = price && duty && other ? price.plus(price.times(duty).div(100)).plus(other) : null;
  const base = (): InvestmentResult => ({
    formula: INV_FORMULA, ok: false,
    acquisition: { price: f2(price), duties: price && duty ? f2(price.times(duty).div(100)) : null, other: f2(other), total: f2(acqTotal), loan: f2(loan), equity: acqTotal ? f2(loan ? acqTotal.minus(loan) : acqTotal) : null },
    years: [], forwardNoi: null, yieldOnCostPct: null, goingInCapPct: null, exit: { value: null, saleCosts: null, net: null, loanBalance: null },
    unlevered: { irrPct: null, npv: null, equityMultiple: null }, levered: i.debt ? { irrPct: null, npv: null, equityMultiple: null } : null, minDscr: null,
    sensitivities: [], vacantAreaSf: f2(vacant), nulls, missing, assumptions, method: METHOD,
  });
  if (missing.length) {
    nulls.all = "NOI, exit value, IRR and NPV need every input listed under Missing — unknown values are never treated as zero.";
    return base();
  }
  const H = Hn!.toNumber();

  const run = (rentFactor: D, capPct: D) => {
    const core = operate(i, H, rentFactor);
    const exitV = core.forward.div(capPct.div(100));
    const saleC = exitV.times(sale!).div(100); const net = exitV.minus(saleC);
    const unl: D[] = [acqTotal!.neg(), ...core.years.map((y) => y.noi)]; unl[H] = unl[H].plus(net);
    let lev: D[] | null = null; const ds: D[] = []; const balloon: D[] = []; let bal: D | null = null;
    if (loan && dRate && tenor) {
      bal = loan; const pay = i.debt!.amortisation === "amortising" ? annuity(loan, dRate, tenor) : null;
      for (let y = 1; y <= H; y++) {
        let service = new Dec(0), extra = new Dec(0);
        if (y <= tenor) {
          const intr = bal.times(dRate).div(100);
          if (pay) { service = pay; bal = bal.minus(pay.minus(intr)); } else service = intr;
          if (bal.abs().lt("0.000001")) bal = new Dec(0);
          if (y === tenor && y < H && bal.gt(0)) { extra = bal; bal = new Dec(0); } // interest-only maturity before exit: repaid from equity
        }
        ds.push(service); balloon.push(extra);
      }
      lev = [acqTotal!.minus(loan).neg(), ...core.years.map((y, k) => y.noi.minus(ds[k]).minus(balloon[k]))]; lev[H] = lev[H].plus(net).minus(bal);
    }
    return { core, exitV, saleC, net, unl, lev, ds, bal };
  };
  const r = run(new Dec(1), cap!);
  const discR = disc!.div(100);
  const m = (cfs: D[]): Metrics => { const x = irr(cfs); return { irrPct: pct(x), npv: f2(npv(discR, cfs)), equityMultiple: multiple(cfs)?.toDecimalPlaces(4).toFixed(4) ?? null }; };
  const out = base();
  out.ok = true;
  out.years = r.core.years.map((y, k) => {
    const ds = r.ds[k] ?? null;
    return { year: k + 1, rent: f2(y.rent)!, camRecovery: f2(y.cam)!, opex: f2(y.opex)!, capex: f2(y.capex)!, noi: f2(y.noi)!, debtService: ds ? f2(ds) : null, dscr: ds && !ds.isZero() ? y.noi.div(ds).toDecimalPlaces(4).toFixed(4) : null, unlevered: f2(r.unl[k + 1])!, levered: r.lev ? f2(r.lev[k + 1]) : null };
  });
  out.forwardNoi = f2(r.core.forward);
  const noi1 = r.core.years[0].noi;
  out.yieldOnCostPct = pct(noi1.div(acqTotal!)); out.goingInCapPct = pct(noi1.div(price!));
  out.exit = { value: f2(r.exitV), saleCosts: f2(r.saleC), net: f2(r.net), loanBalance: r.bal ? f2(r.bal) : null };
  out.unlevered = m(r.unl);
  if (r.lev) {
    out.levered = m(r.lev);
    const ds = r.core.years.map((y, k) => (r.ds[k] && !r.ds[k].isZero() ? y.noi.div(r.ds[k]) : null)).filter((x): x is D => x !== null);
    out.minDscr = ds.length ? Decimal.min(...ds).toDecimalPlaces(4).toFixed(4) : null;
  } else if (i.debt) nulls.levered = "Levered returns need LTV, rate and tenor.";
  if (out.unlevered.irrPct === null) nulls.unleveredIrr = "No IRR: cash flows never change sign or no rate between −99% and 1000% solves NPV = 0.";
  if (out.levered && out.levered.irrPct === null && r.lev) nulls.leveredIrr = "No levered IRR: cash flows never change sign or the solver found no root.";
  const sens: [string, D, D][] = [["Exit cap −50 bps", new Dec(1), cap!.minus("0.5")], ["Exit cap +50 bps", new Dec(1), cap!.plus("0.5")], ["Rent −10%", new Dec("0.9"), cap!], ["Rent +10%", new Dec("1.1"), cap!]];
  out.sensitivities = sens.map(([label, rf, c]) => {
    if (c.lte(0)) return { label, exitValue: null, unleveredIrrPct: null, leveredIrrPct: null, npv: null };
    const s = run(rf, c);
    return { label, exitValue: f2(s.exitV), unleveredIrrPct: pct(irr(s.unl)), leveredIrrPct: s.lev ? pct(irr(s.lev)) : null, npv: f2(npv(discR, s.unl)) };
  });
  if (i.areaBasis) assumptions.push(`Area and all ₹/SF figures are on the ${i.areaBasis.replace("_", "-")} basis as entered; nothing is converted.`);
  assumptions.push("Rent escalation is counted from acquisition; re-let rent escalation from the re-let start.", "Exit value capitalises the NOI of the year after the holding period.", "Debt: annual payments in arrears; loan sized on purchase price.");
  return out;
}

const METHOD = [
  "NOI = rent + CAM recovery − landlord opex − capex reserve, built month by month and summed per year.",
  "Acquisition cost = price × (1 + stamp duty/registration %) + other costs. Yield on cost = year-1 NOI ÷ acquisition cost.",
  "Exit value = year (H+1) NOI ÷ exit cap rate, less sale costs.",
  "IRR solved deterministically by bisection (to 1e-12); shown as unknown if no solution exists. NPV at the stated discount rate.",
  "Equity multiple = total cash received ÷ total cash invested. DSCR = NOI ÷ debt service.",
];
