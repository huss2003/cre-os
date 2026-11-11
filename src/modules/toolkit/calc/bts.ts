/**
 * Built-to-Suit model — formula "bts-1.0". PURE, deterministic (decimal.js), never AI (S5).
 *
 * Project cost = land + hard + soft + interest during construction (IDC).
 *   land: purchase → the stated land cost (drawn in month 1); lease → land rent payable during construction is
 *         capitalised; after completion the annual land rent is an ongoing developer cost recovered through rent.
 *   hard = area × construction cost per SF (both on the SAME stated area basis — never converted, §8.12).
 *   soft = hard × soft-cost %.
 *   IDC (only when included): hard + soft are drawn per the draw schedule (% per construction month; straight-line if
 *        none); land purchase is drawn in month 1; at the end of each month interest = balance × annual% ÷ 12 is added
 *        to the balance (capitalised).
 * Rent: yield mode → year-1 annual rent = yield × project cost (+ year-1 land rent if land is leased);
 *       required rent per SF per month = that ÷ area ÷ 12.
 *       rent mode  → implied yield = (target rent × area × 12 − year-1 land rent) ÷ project cost.
 * Rent schedule: month m rent = rent₀ × (1+e)^floor((m−1)/every); months 1..rent-free are free.
 * Tenant total occupancy cost = rent paid + tenant fit-out (month 1). Refundable deposit kept SEPARATE (not in TCO/NPV).
 * NPV: monthly rate (1+r)^(1/12)−1, payments in advance (month m discounted (m−1) periods).
 * Unknown inputs → dependent outputs are null with a reason in `nulls`; never treated as zero (S6).
 */
import Decimal from "decimal.js";
import { assertValidInputs } from "./validate";

export const BTS_FORMULA = "bts-1.0";
const Dec = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
type D = Decimal;
export type N = number | string | null | undefined;
export const AREA_BASES = ["built_up", "chargeable", "leasable", "carpet"] as const;
export type AreaBasis = (typeof AREA_BASES)[number];

const known = (x: N) => x !== null && x !== undefined && String(x).trim() !== "" && Number.isFinite(Number(String(x).trim()));
const dn = (x: N): D | null => (known(x) ? new Dec(String(x).trim()) : null);
const f2 = (d: D | null) => (d === null ? null : d.toDecimalPlaces(2).toFixed(2));

export interface LeaseAlternative {
  name: string; areaSf: N; areaBasis: AreaBasis | null; rentPerSfMonth: N; escalationPct: N; escalationEveryMonths: N;
  rentFreeMonths: N; depositMonths: N; fitout: N; termMonths?: N;
}
export interface BtsInput {
  land: { mode: "purchase" | "lease" | null; cost?: N; leaseRentMonthly?: N };
  areaSf: N; areaBasis: AreaBasis | null;
  constructionCostPerSf: N; softCostPct: N;
  constructionMonths: N; drawSchedulePct?: N[] | null;
  includeConstructionInterest?: boolean; constructionInterestPct?: N;
  mode: "yield" | "rent"; yieldOnCostPct?: N; targetRentPerSfMonth?: N;
  leaseTermMonths: N; escalationPct: N; escalationEveryMonths: N; rentFreeMonths: N; depositMonths: N; tenantFitout: N;
  discountRatePct: N;
  alternative?: LeaseAlternative | null;
}
export interface RentYear { year: number; months: number; rentPerSfMonth: string | null; rentPaid: string | null }
export interface TenantCost { rentPaid: string | null; fitout: string | null; nominal: string | null; npv: string | null; deposit: string | null }
export interface BtsResult {
  formula: string; areaSf: string | null; areaBasis: AreaBasis | null;
  projectCost: { land: string | null; hard: string | null; soft: string | null; interest: string | null; total: string | null; perSf: string | null };
  draws: { month: number; draw: string; interest: string; balance: string }[];
  rent: { mode: "yield" | "rent"; requiredRentPerSfMonth: string | null; impliedYieldPct: string | null; year1AnnualRent: string | null; landRentAnnual: string | null };
  schedule: RentYear[];
  tenant: TenantCost;
  comparison: null | { name: string; comparable: boolean; reason: string | null; alternative: TenantCost; btsMinusAlternativeNominal: string | null; btsMinusAlternativeNpv: string | null; cheaper: "bts" | "alternative" | "equal" | null };
  nulls: Record<string, string>; missing: string[]; assumptions: string[]; method: string[];
}

interface Sched { months: D[]; paid: D | null; npv: D | null }
/** Rent cash-flow per month (pure). rent0 = monthly rent for the whole area. */
function schedule(rent0: D, term: number, escPct: D | null, every: number, rentFree: number, rMonthly: D | null): Sched {
  const months: D[] = []; let paid = new Dec(0); let npv = rMonthly ? new Dec(0) : null;
  for (let m = 1; m <= term; m++) {
    const f = escPct && !escPct.isZero() ? escPct.div(100).plus(1).pow(Math.floor((m - 1) / every)) : new Dec(1);
    const amt = m <= rentFree ? new Dec(0) : rent0.times(f);
    months.push(amt); paid = paid.plus(amt);
    if (npv && rMonthly) npv = npv.plus(amt.div(rMonthly.plus(1).pow(m - 1)));
  }
  return { months, paid, npv };
}
const monthlyRate = (annualPct: D) => annualPct.div(100).plus(1).pow(new Dec(1).div(12)).minus(1);
function byYear(months: D[], area: D): RentYear[] {
  const out: RentYear[] = [];
  for (let i = 0; i < months.length; i += 12) {
    const chunk = months.slice(i, i + 12);
    const top = chunk.reduce((a, b) => (b.gt(a) ? b : a), new Dec(0));
    out.push({ year: i / 12 + 1, months: chunk.length, rentPerSfMonth: f2(top.div(area)), rentPaid: f2(chunk.reduce((a, b) => a.plus(b), new Dec(0))) });
  }
  return out;
}

function intOr(x: N, missing: string[], label: string, min = 0): number | null {
  if (!known(x)) { missing.push(label); return null; }
  const v = Number(x);
  if (!Number.isInteger(v) || v < min) throw new Error(`${label} must be a whole number ≥ ${min}`);
  return v;
}

export function computeBts(i: BtsInput): BtsResult {
  assertValidInputs(i);
  const missing: string[] = []; const nulls: Record<string, string> = {}; const assumptions: string[] = [];
  const miss = (label: string, key?: string, why?: string) => { if (!missing.includes(label)) missing.push(label); if (key) nulls[key] = why ?? `Unknown because ${label.toLowerCase()} is missing.`; };

  const area = dn(i.areaSf);
  if (area !== null && area.lte(0)) throw new Error("Area must be greater than 0");
  if (area === null) miss("Area (SF)");
  if (!i.areaBasis) miss("Area basis (built-up / chargeable / leasable / carpet)");
  const cps = dn(i.constructionCostPerSf); if (cps === null) miss("Construction cost per SF");
  const softPct = dn(i.softCostPct); if (softPct === null) miss("Soft costs %");
  const cMonths = intOr(i.constructionMonths, missing, "Construction period (months)", 1);

  // Land
  let land: D | null = null; let landRentMonthly: D | null = null;
  if (i.land.mode === "purchase") { land = dn(i.land.cost); if (land === null) miss("Land cost", "land"); }
  else if (i.land.mode === "lease") {
    landRentMonthly = dn(i.land.leaseRentMonthly);
    if (landRentMonthly === null) miss("Land lease rent per month", "land");
    else if (cMonths !== null) land = landRentMonthly.times(cMonths);
    else nulls.land = "Land rent during construction needs the construction period.";
  } else miss("Land: purchase or lease", "land", "Unknown until you say whether land is bought or leased.");

  const hard = area && cps ? area.times(cps) : null;
  if (!hard) nulls.hard = "Needs area and construction cost per SF.";
  const soft = hard && softPct ? hard.times(softPct).div(100) : null;
  if (!soft) nulls.soft = "Needs hard cost and soft-cost %.";

  // Draw schedule + IDC
  let interest: D | null = new Dec(0);
  const draws: BtsResult["draws"] = [];
  let pcts: D[] | null = null;
  if (cMonths !== null) {
    const sch = (i.drawSchedulePct ?? []).filter((x) => known(x));
    if (sch.length) {
      if (sch.length !== cMonths) throw new Error(`Draw schedule has ${sch.length} entries but construction period is ${cMonths} months`);
      pcts = sch.map((x) => new Dec(String(x)));
      const tot = pcts.reduce((a, b) => a.plus(b), new Dec(0));
      if (!tot.minus(100).abs().lte("0.0001")) throw new Error(`Draw schedule must add up to 100% (it adds up to ${tot.toFixed(2)}%)`);
    } else { pcts = Array.from({ length: cMonths }, () => new Dec(100).div(cMonths)); assumptions.push("Draw schedule not given: hard + soft costs drawn straight-line over the construction period."); }
  }
  if (i.includeConstructionInterest) {
    const rate = dn(i.constructionInterestPct);
    if (rate === null) { miss("Construction finance rate %", "interest"); interest = null; }
    else if (!hard || !soft || !pcts || land === null) { interest = null; nulls.interest = "Needs land, hard and soft costs and the construction period."; }
    else {
      const r = rate.div(1200); let bal = new Dec(0); interest = new Dec(0);
      for (let m = 1; m <= pcts.length; m++) {
        let draw = hard.plus(soft).times(pcts[m - 1]).div(100);
        if (i.land.mode === "purchase" && m === 1) draw = draw.plus(land);
        if (i.land.mode === "lease" && landRentMonthly) draw = draw.plus(landRentMonthly);
        bal = bal.plus(draw);
        const it = bal.times(r); interest = interest.plus(it); bal = bal.plus(it);
        draws.push({ month: m, draw: f2(draw)!, interest: f2(it)!, balance: f2(bal)! });
      }
    }
  } else assumptions.push("Interest during construction not included (switch it on and give a rate to include it).");

  const total = land !== null && hard && soft && interest !== null ? land.plus(hard).plus(soft).plus(interest) : null;
  if (!total) nulls.total = "Total project cost needs land, hard, soft (and interest if included).";

  // Rent
  const landRentAnnual = landRentMonthly ? landRentMonthly.times(12) : i.land.mode === "purchase" ? new Dec(0) : null;
  let rent0Sf: D | null = null; let impliedYield: D | null = null; let year1: D | null = null;
  if (i.mode === "yield") {
    const y = dn(i.yieldOnCostPct);
    if (y === null) miss("Developer yield on cost %", "requiredRentPerSfMonth");
    else if (total && area && landRentAnnual !== null) {
      year1 = total.times(y).div(100).plus(landRentAnnual); rent0Sf = year1.div(area).div(12); impliedYield = y;
    } else nulls.requiredRentPerSfMonth = "Required rent needs the total project cost and area.";
  } else {
    rent0Sf = dn(i.targetRentPerSfMonth);
    if (rent0Sf === null) miss("Target rent per SF per month", "impliedYieldPct");
    else if (area) {
      year1 = rent0Sf.times(area).times(12);
      if (total && landRentAnnual !== null) impliedYield = year1.minus(landRentAnnual).div(total).times(100);
      else nulls.impliedYieldPct = "Implied yield needs the total project cost.";
    }
  }

  // Lease + tenant cost
  const term = intOr(i.leaseTermMonths, missing, "Lease term (months)", 1);
  const esc = dn(i.escalationPct); if (esc === null) miss("Rent escalation % (enter 0 if none)");
  const every = known(i.escalationEveryMonths) ? Number(i.escalationEveryMonths) : null;
  if (esc && !esc.isZero() && (every === null || every < 1)) miss("Escalation frequency (months)");
  const rf = intOr(i.rentFreeMonths, missing, "Rent-free months (enter 0 if none)");
  const fit = dn(i.tenantFitout); if (fit === null) miss("Tenant fit-out cost (enter 0 if landlord-provided)");
  const depM = dn(i.depositMonths); if (depM === null) miss("Security deposit (months)");
  const disc = dn(i.discountRatePct); if (disc === null) miss("Discount rate %");
  let sched: Sched | null = null;
  const canSched = rent0Sf && area && term !== null && esc !== null && rf !== null && (esc.isZero() || (every ?? 0) >= 1);
  if (canSched) sched = schedule(rent0Sf!.times(area!), term!, esc, every ?? 12, rf!, disc ? monthlyRate(disc) : null);
  else nulls.schedule = "Rent schedule needs the rent, area, lease term, escalation and rent-free months.";
  const tenant: TenantCost = {
    rentPaid: f2(sched?.paid ?? null), fitout: f2(fit),
    nominal: sched?.paid && fit ? f2(sched.paid.plus(fit)) : null,
    npv: sched?.npv && fit ? f2(sched.npv.plus(fit)) : null,
    deposit: rent0Sf && area && depM ? f2(rent0Sf.times(area).times(depM)) : null,
  };
  if (!tenant.nominal) nulls.tenantNominal = "Tenant total needs the rent schedule and fit-out cost.";
  if (!tenant.npv) nulls.tenantNpv = "NPV needs the rent schedule, fit-out cost and discount rate.";

  // Comparison vs a lease alternative (same area basis only — no conversion)
  let comparison: BtsResult["comparison"] = null;
  const alt = i.alternative;
  if (alt && known(alt.rentPerSfMonth)) {
    const aArea = dn(alt.areaSf); const aRent = dn(alt.rentPerSfMonth)!; const aEsc = dn(alt.escalationPct); const aRf = known(alt.rentFreeMonths) ? Number(alt.rentFreeMonths) : null;
    const aEvery = known(alt.escalationEveryMonths) ? Number(alt.escalationEveryMonths) : null; const aFit = dn(alt.fitout); const aDep = dn(alt.depositMonths);
    const aTerm = known(alt.termMonths) ? Number(alt.termMonths) : term;
    let reason: string | null = null;
    if (!alt.areaBasis || !i.areaBasis) reason = "Area basis missing on one side — cannot compare per SF.";
    else if (alt.areaBasis !== i.areaBasis) reason = `Area bases differ (${i.areaBasis} vs ${alt.areaBasis}); they are not converted. Re-enter the alternative on the ${i.areaBasis} basis to compare.`;
    else if (aTerm !== term) reason = "Lease terms differ — compare over the same term.";
    const altSched = aArea && aEsc !== null && aRf !== null && aTerm && (aEsc.isZero() || (aEvery ?? 0) >= 1) ? schedule(aRent.times(aArea), aTerm, aEsc, aEvery ?? 12, aRf, disc ? monthlyRate(disc) : null) : null;
    const aT: TenantCost = {
      rentPaid: f2(altSched?.paid ?? null), fitout: f2(aFit),
      nominal: altSched?.paid && aFit ? f2(altSched.paid.plus(aFit)) : null, npv: altSched?.npv && aFit ? f2(altSched.npv.plus(aFit)) : null,
      deposit: aArea && aDep ? f2(aRent.times(aArea).times(aDep)) : null,
    };
    if (!altSched || !aFit) reason = reason ?? "Alternative is missing area, escalation, rent-free months or fit-out.";
    const comparable = reason === null && tenant.nominal !== null && aT.nominal !== null;
    if (reason === null && !comparable) reason = "BTS side is incomplete.";
    const dN = comparable ? new Dec(tenant.nominal!).minus(aT.nominal!) : null;
    const dP = comparable && tenant.npv && aT.npv ? new Dec(tenant.npv).minus(aT.npv) : null;
    const basis = dP ?? dN;
    comparison = { name: alt.name || "Lease alternative", comparable, reason, alternative: aT, btsMinusAlternativeNominal: f2(dN), btsMinusAlternativeNpv: f2(dP), cheaper: basis === null ? null : basis.isZero() ? "equal" : basis.lt(0) ? "bts" : "alternative" };
  }

  if (i.areaBasis) assumptions.push(`All per-SF figures are on the ${i.areaBasis.replace("_", "-")} area basis as entered; nothing is converted.`);
  assumptions.push("Refundable deposit is shown separately and excluded from total occupancy cost and NPV.", "Rent is paid monthly in advance; escalation counted from lease start.");
  return {
    formula: BTS_FORMULA, areaSf: f2(area), areaBasis: i.areaBasis,
    projectCost: { land: f2(land), hard: f2(hard), soft: f2(soft), interest: f2(interest), total: f2(total), perSf: total && area ? f2(total.div(area)) : null },
    draws,
    rent: { mode: i.mode, requiredRentPerSfMonth: f2(rent0Sf), impliedYieldPct: impliedYield ? impliedYield.toDecimalPlaces(4).toFixed(4) : null, year1AnnualRent: f2(year1), landRentAnnual: f2(landRentAnnual) },
    schedule: sched && area ? byYear(sched.months, area) : [],
    tenant, comparison, nulls, missing, assumptions,
    method: [
      "Project cost = land + construction (area × cost/SF) + soft costs (% of construction) + interest during construction (if included).",
      "Required rent = (yield × project cost + annual land rent) ÷ area ÷ 12. Implied yield = (annual rent − land rent) ÷ project cost.",
      "Rent in month m = starting rent × (1 + escalation)^floor((m−1) ÷ frequency); rent-free months pay nothing.",
      "Tenant cost = rent paid + fit-out. NPV discounts each month at the monthly equivalent of the annual rate, paid in advance.",
    ],
  };
}
