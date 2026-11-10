import Decimal from "decimal.js";
import { evaluate, concessionEquivalence, FinanceInputError } from "@/modules/deals/finance/engine";
import type { Concession } from "@/modules/deals/finance/engine";
import type { Num } from "@/modules/deals/finance/types";
import { toFinanceInput, leaseEconomics, type LeaseTerms } from "./lease";

/**
 * Negotiation Comparison ("nego-1.0") — PURE. Offer versions are append-only (Offer 1, Offer 2 …); diffs, financial
 * differences (engine NPV / totals on an equal horizon) and concession-package values all come from fin-1.0.
 * Nothing here accepts, rejects or sends anything; the strategy panel is a deterministic reading of the data.
 */
export const NEGO_FORMULA = "nego-1.0";
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const blank = (x: unknown) => x === null || x === undefined || x === "";
const d = (x: Num | null | undefined) => new Dec(blank(x) ? 0 : (x as Num));
const s2 = (x: Decimal) => x.toFixed(2);

export interface OfferTerms extends LeaseTerms {
  /** Landlord fit-out contribution (₹, paid at signing). null = unresolved. */
  fitoutContribution?: Num | null;
  lockInMonths?: number | null;
  noticeMonths?: number | null;
  breakClause?: string | null;
  possessionDate?: string | null;
  handover?: string | null;
  restoration?: string | null;
  other?: string | null;
}
export interface OfferVersion { no: number; label: string; terms: OfferTerms; createdAt: string; note?: string | null }

export type DiffStatus = "improved" | "worse" | "unchanged" | "unresolved" | "changed";
export interface TermDiff { key: string; label: string; previous: string | null; current: string | null; status: DiffStatus }

type Dir = "lower" | "higher" | "earlier" | "text";
const TERMS: { key: keyof OfferTerms; label: string; dir: Dir }[] = [
  { key: "rentPerSf", label: "Base rent ₹/SF/month", dir: "lower" },
  { key: "escalationPct", label: "Escalation %", dir: "lower" },
  { key: "escalationEveryMonths", label: "Escalation every (months)", dir: "higher" },
  { key: "rentFreeMonths", label: "Rent-free months", dir: "higher" },
  { key: "depositMonths", label: "Deposit (months)", dir: "lower" },
  { key: "camPerSf", label: "CAM ₹/SF/month", dir: "lower" },
  { key: "parkingSlots", label: "Parking slots", dir: "text" },
  { key: "parkingRatePerSlot", label: "Parking ₹/slot/month", dir: "lower" },
  { key: "fitoutContribution", label: "Fit-out contribution ₹", dir: "higher" },
  { key: "tenureMonths", label: "Tenure (months)", dir: "text" },
  { key: "lockInMonths", label: "Lock-in (months)", dir: "lower" },
  { key: "noticeMonths", label: "Notice (months)", dir: "lower" },
  { key: "breakClause", label: "Break clause", dir: "text" },
  { key: "possessionDate", label: "Possession date", dir: "earlier" },
  { key: "handover", label: "Handover condition", dir: "text" },
  { key: "restoration", label: "Restoration", dir: "text" },
  { key: "other", label: "Other", dir: "text" },
];
export const NEGO_TERMS = TERMS;

const str = (v: unknown) => (blank(v) ? null : String(v));

export function diffOffers(prev: OfferTerms | null, cur: OfferTerms): TermDiff[] {
  return TERMS.map(({ key, label, dir }) => {
    const p = prev ? str(prev[key]) : null;
    const c = str(cur[key]);
    let status: DiffStatus;
    if (c === null) status = "unresolved";
    else if (!prev || p === null) status = "changed";
    else if (dir === "text") status = p.trim() === c.trim() ? "unchanged" : "changed";
    else if (dir === "earlier") status = p === c ? "unchanged" : c < p ? "improved" : "worse";
    else {
      const cmp = new Dec(c).cmp(new Dec(p));
      status = cmp === 0 ? "unchanged" : (cmp < 0) === (dir === "lower") ? "improved" : "worse";
    }
    return { key: String(key), label, previous: p, current: c, status };
  });
}

/** Map an offer to engine input; fit-out contribution is landlord capex support received at signing. */
export function offerFinanceInput(o: OfferTerms, horizonMonths?: number) {
  const fin = toFinanceInput(o, { horizonMonths });
  if (!blank(o.fitoutContribution) && d(o.fitoutContribution).gt(0)) {
    fin.capex = { fitoutCost: 0, landlordContribution: String(o.fitoutContribution), spendPeriod: 0 };
  }
  return fin;
}

export interface OfferFinance { no: number; label: string; npv: string; nominalTotal: string; rentTotal: string; depositAmount: string | null; contractualExpenditure: string; complete: boolean; gaps: string[] }
export interface FinancialDiff { from: number; to: number; npvChange: string; nominalChange: string; rentChange: string; depositChange: string | null; better: "to" | "from" | "equal" }

export function offerFinance(v: OfferVersion, H: number): OfferFinance {
  const fin = offerFinanceInput(v.terms, H);
  const r = evaluate(fin);
  const le = leaseEconomics(v.terms, { horizonMonths: H });
  return {
    no: v.no, label: v.label, npv: r.totals.npv, nominalTotal: r.totals.nominalTco, rentTotal: r.categoryTotals.rent ?? "0.00",
    depositAmount: le.deposit?.amount ?? null, contractualExpenditure: le.totals.contractualExpenditure, complete: r.complete, gaps: r.gaps.map((g) => g.label),
  };
}

export function financialDiff(a: OfferFinance, b: OfferFinance): FinancialDiff {
  const npvChange = d(b.npv).minus(a.npv);
  return {
    from: a.no, to: b.no, npvChange: s2(npvChange), nominalChange: s2(d(b.nominalTotal).minus(a.nominalTotal)),
    rentChange: s2(d(b.rentTotal).minus(a.rentTotal)),
    depositChange: a.depositAmount && b.depositAmount ? s2(d(b.depositAmount).minus(a.depositAmount)) : null,
    better: npvChange.isZero() ? "equal" : npvChange.lt(0) ? "to" : "from",
  };
}

// ---------------------------------------------------------------------------------------------- concession packages
export type PackageItem =
  | { type: "lower_rent"; perSf: Num }
  | { type: "longer_rent_free"; months: number }
  | { type: "lower_deposit"; months: Num }
  | { type: "reduced_escalation"; pctPoints: Num }
  | { type: "fitout_contribution"; amount: Num }
  | { type: "extra_parking"; slots: number }
  | { type: "earlier_possession"; months: number; parallelRentMonthly?: Num | null }
  | { type: "flexible_lock_in"; months: number };
export interface ConcessionPackage { name: string; items: PackageItem[] }
export interface PackageValue {
  name: string; items: PackageItem[];
  /** NPV saving to the occupier (positive = better for occupier); null where not financially modelled. */
  npvValue: string | null;
  nominalValue: string | null;
  itemValues: { item: PackageItem; npvValue: string | null; equivalentRentFreeMonths: string | null; note: string | null }[];
  notes: string[];
}

function toConcession(i: PackageItem): Concession | null {
  switch (i.type) {
    case "lower_rent": return { type: "rent_rate", rate: d(i.perSf).neg().toString() };
    case "longer_rent_free": return { type: "rent_free", months: i.months };
    case "lower_deposit": return { type: "deposit_months", months: d(i.months).neg().toString() };
    case "reduced_escalation": return { type: "escalation_pct", pct: d(i.pctPoints).neg().toString() };
    case "fitout_contribution": return { type: "capex_support", amount: String(i.amount), period: 0 };
    default: return null;
  }
}

/** Value each package against a base offer. Single items use engine.concessionEquivalence; packages re-run evaluate. */
export function valuePackages(base: OfferTerms, packages: ConcessionPackage[]): PackageValue[] {
  const baseFin = offerFinanceInput(base);
  const baseRes = evaluate(baseFin);
  return packages.map((pkg) => {
    const notes: string[] = [];
    const itemValues = pkg.items.map((item) => {
      const c = toConcession(item);
      if (c) {
        try {
          const [v] = concessionEquivalence(baseFin, [c]);
          return { item, npvValue: v.npvValue, equivalentRentFreeMonths: v.equivalentRentFreeMonths, note: null };
        } catch (e) { return { item, npvValue: null, equivalentRentFreeMonths: null, note: (e as Error).message }; }
      }
      if (item.type === "extra_parking") {
        if (!baseFin.parking) return { item, npvValue: null, equivalentRentFreeMonths: null, note: "base offer has no priced parking — value not modelled" };
        const x = structuredClone(baseFin);
        x.parking!.slots = Math.max(0, x.parking!.slots - item.slots); // extra slots free of charge ≡ fewer charged slots
        if (x.parking!.slots === 0) { x.parking = null; x.costStates = { ...x.costStates, parking: "none" }; }
        return { item, npvValue: s2(d(baseRes.totals.npv).minus(evaluate(x).totals.npv)), equivalentRentFreeMonths: null, note: "extra slots at no charge" };
      }
      if (item.type === "earlier_possession") {
        if (blank(item.parallelRentMonthly)) return { item, npvValue: null, equivalentRentFreeMonths: null, note: "more fit-out time; cash value needs the current premises' monthly rent" };
        const x = structuredClone(baseFin);
        x.move = { parallelRentMonthly: "0", parallelMonths: 0 };
        const y = structuredClone(baseFin);
        y.move = { parallelRentMonthly: String(item.parallelRentMonthly), parallelFromPeriod: 1, parallelMonths: item.months };
        return { item, npvValue: s2(d(evaluate(y).totals.npv).minus(evaluate(x).totals.npv)), equivalentRentFreeMonths: null, note: "parallel rent avoided" };
      }
      return { item, npvValue: null, equivalentRentFreeMonths: null, note: "flexibility / option value — not a cash flow, not modelled" };
    });
    // combined package value: apply all financial items together through the engine
    const x = structuredClone(baseFin);
    let modelled = false;
    for (const item of pkg.items) {
      switch (item.type) {
        case "lower_rent": x.rent!.rate = d(x.rent!.rate).minus(d(item.perSf)).toString(); modelled = true; break;
        case "longer_rent_free": x.rent!.rentFreeMonths = (x.rent!.rentFreeMonths ?? 0) + item.months; modelled = true; break;
        case "lower_deposit": if (x.deposit) { x.deposit.months = Dec.max(0, d(x.deposit.months).minus(d(item.months))).toString(); modelled = true; } break;
        case "reduced_escalation": if (x.rent!.escalation) { x.rent!.escalation.pct = Dec.max(0, d(x.rent!.escalation.pct).minus(d(item.pctPoints))).toString(); modelled = true; } break;
        case "fitout_contribution": x.capex = { fitoutCost: x.capex?.fitoutCost ?? 0, spendPeriod: 0, landlordContribution: d(x.capex?.landlordContribution).plus(d(item.amount)).toString() }; modelled = true; break;
        case "extra_parking": if (x.parking) { x.parking.slots = Math.max(0, x.parking.slots - item.slots); modelled = true; } break;
        case "earlier_possession": if (!blank(item.parallelRentMonthly)) notes.push("earlier possession valued separately (parallel rent avoided) and added"); break;
        case "flexible_lock_in": notes.push(`flexible lock-in (${item.months} months) is not a cash flow — weigh qualitatively`); break;
      }
    }
    let npv: Decimal | null = null, nominal: Decimal | null = null;
    if (modelled) {
      const w = evaluate(x);
      npv = d(baseRes.totals.npv).minus(w.totals.npv);
      nominal = d(baseRes.totals.nominalTco).minus(w.totals.nominalTco);
    }
    const ep = itemValues.find((v) => v.item.type === "earlier_possession" && v.npvValue !== null);
    if (ep) { npv = (npv ?? new Dec(0)).plus(ep.npvValue!); nominal = nominal ?? new Dec(0); }
    return { name: pkg.name, items: pkg.items, npvValue: npv ? s2(npv) : null, nominalValue: nominal ? s2(nominal) : null, itemValues, notes };
  });
}

// ---------------------------------------------------------------------------------------------- full analysis + strategy
export interface Strategy { preferredOutcome: string; acceptableAlternative: string | null; unresolved: string[]; risks: string[] }
export interface NegotiationAnalysis {
  formulaVersion: string;
  horizonMonths: number;
  offers: OfferFinance[];
  diffs: { from: number | null; to: number; terms: TermDiff[]; financial: FinancialDiff | null }[];
  packages: PackageValue[];
  strategy: Strategy;
  warnings: string[];
}

const fmt = (x: string) => `₹${new Dec(x).toDecimalPlaces(0).toNumber().toLocaleString("en-IN")}`;

export function strategyFor(versions: OfferVersion[], offers: OfferFinance[], packages: PackageValue[]): Strategy {
  const latest = versions[versions.length - 1].terms;
  const unresolved = TERMS.filter(({ key }) => blank(latest[key]) && !["other", "escalationEveryMonths"].includes(String(key))).map((t) => t.label);
  const risks: string[] = [];
  const best = [...offers].sort((a, b) => d(a.npv).cmp(d(b.npv)))[0];
  const lastOffer = offers[offers.length - 1];
  if (best.no !== lastOffer.no) risks.push(`Latest offer (${lastOffer.label}) costs ${fmt(d(lastOffer.npv).minus(best.npv).toString())} more in NPV than ${best.label}.`);
  if (!blank(latest.lockInMonths) && Number(latest.lockInMonths) * 2 > latest.tenureMonths) risks.push(`Lock-in ${latest.lockInMonths} months is over half the ${latest.tenureMonths}-month tenure.`);
  if (!blank(latest.depositMonths) && d(latest.depositMonths).gt(6)) risks.push(`Deposit of ${latest.depositMonths} months ties up cash until the end of the lease.`);
  if (blank(latest.restoration)) risks.push("Restoration obligation is not agreed — exit cost unknown.");
  if (latest.possessionDate && latest.rentCommencement && latest.possessionDate > latest.rentCommencement) risks.push("Possession is after rent commencement — rent would be payable before you can fit out.");
  for (const o of offers) if (!o.complete) risks.push(`${o.label}: incomplete — excludes unknown ${o.gaps.join(", ")}.`);
  const ranked = packages.filter((p) => p.npvValue !== null).sort((a, b) => d(b.npvValue!).cmp(d(a.npvValue!)));
  return {
    preferredOutcome: ranked[0] ? `${ranked[0].name}: worth ${fmt(ranked[0].npvValue!)} NPV to the occupier vs ${lastOffer.label}.` : `${best.label} (lowest NPV ${fmt(best.npv)}).`,
    acceptableAlternative: ranked[1] ? `${ranked[1].name}: worth ${fmt(ranked[1].npvValue!)} NPV.` : ranked[0] ? `${best.label} as it stands (NPV ${fmt(best.npv)}).` : null,
    unresolved, risks,
  };
}

export function analyseNegotiation(versions: OfferVersion[], packages: ConcessionPackage[] = []): NegotiationAnalysis {
  if (!versions.length) throw new FinanceInputError("add at least one offer");
  const dates = new Set(versions.map((v) => v.terms.leaseCommencement));
  const warnings: string[] = [];
  if (dates.size > 1) warnings.push("Offers have different lease commencement dates; each is valued from its own commencement.");
  const H = Math.max(...versions.map((v) => v.terms.tenureMonths));
  if (versions.some((v) => v.terms.tenureMonths !== H)) warnings.push(`Tenures differ: all offers compared over ${H} months; shorter ones assumed to continue on the same terms.`);
  const rates = new Set(versions.map((v) => String(v.terms.discountRatePct)));
  if (rates.size > 1) throw new FinanceInputError("all offers must use the same discount rate for a fair comparison");
  const offers = versions.map((v) => offerFinance(v, H));
  const diffs = versions.map((v, i) => ({
    from: i ? versions[i - 1].no : null, to: v.no,
    terms: diffOffers(i ? versions[i - 1].terms : null, v.terms),
    financial: i ? financialDiff(offers[i - 1], offers[i]) : null,
  }));
  const pk = packages.length ? valuePackages(versions[versions.length - 1].terms, packages) : [];
  return { formulaVersion: NEGO_FORMULA, horizonMonths: H, offers, diffs, packages: pk, strategy: strategyFor(versions, offers, pk), warnings };
}

/** Append a new offer version (never overwrites). */
export function appendOffer(versions: OfferVersion[], terms: OfferTerms, createdAt: string, note?: string | null): OfferVersion[] {
  const no = versions.length ? Math.max(...versions.map((v) => v.no)) + 1 : 1;
  return [...versions, { no, label: `Offer ${no}`, terms: { ...terms, name: `Offer ${no}` }, createdAt, note: note ?? null }];
}
