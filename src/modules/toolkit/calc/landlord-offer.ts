import Decimal from "decimal.js";
import { z } from "zod";
import { compareLeaseOffers, occupancyEconomics, validateTerms, LEASE_FORMULA, type LeaseTerms } from "./lease";

/**
 * Landlord offer comparator ("offer-cmp-1.0"). PURE. A LandlordOffer is the fixed, typed shape of a landlord's commercial
 * offer (stored on a quote version as `quote.offer`, kind='landlord_offer'). Every money figure comes from the existing
 * lease-1.0 / occ-1.0 calculators (fin-1.0 engine); this file only maps offers → LeaseTerms, aligns them on one
 * commencement date for an equal comparison, and lays the result out line by line. Blank = unknown, never 0.
 */
export const OFFER_CMP_FORMULA = "offer-cmp-1.0";
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const OFFER_FACT_STATUSES = ["reported", "currently_confirmed", "ai_inference"] as const;
export type OfferFactStatus = (typeof OFFER_FACT_STATUSES)[number];
const factStatus = z.enum(OFFER_FACT_STATUSES);
const nn = z.number().finite().min(0).nullable().optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();

/** Offer fields that carry their own fact status (fieldStatus[key]). */
export const OFFER_FIELDS = [
  "areaSf", "areaBasis", "efficiencyPct", "rentPerSf", "escalationPct", "escalationEveryMonths", "lockInMonths", "termMonths",
  "securityDepositMonths", "rentFreeMonths", "fitoutAllowanceInr", "camPerSf", "carParks", "carParkRatePerSlot",
  "powerBackup", "possessionDate", "leaseCommencement", "validUntil", "seats",
] as const;
export type OfferField = (typeof OFFER_FIELDS)[number];

export const landlordOfferSchema = z.object({
  name: z.string().min(1).max(200).describe("Option label, e.g. 'Tower B, 6th floor'"),
  assetId: z.string().uuid().nullable().optional().describe("Building (asset) id"),
  spaceId: z.string().uuid().nullable().optional().describe("Space id"),
  buildingName: z.string().max(200).nullable().optional(),
  floorUnit: z.string().max(100).nullable().optional(),
  areaSf: nn.describe("Area in SF on areaBasis; null = unknown"),
  areaBasis: z.enum(["chargeable", "carpet"]).nullable().optional(),
  efficiencyPct: z.number().gt(0).max(100).nullable().optional().describe("Carpet ÷ chargeable × 100"),
  rentPerSf: nn.describe("₹/SF/month on areaBasis"),
  escalationPct: nn, escalationEveryMonths: z.number().int().min(1).max(120).nullable().optional(),
  lockInMonths: z.number().int().min(0).max(600).nullable().optional(),
  termMonths: z.number().int().min(1).max(600).nullable().optional(),
  securityDepositMonths: nn, rentFreeMonths: z.number().int().min(0).max(60).nullable().optional(),
  fitoutAllowanceInr: nn.describe("Landlord fit-out allowance, total ₹ (0 = none)"),
  camPerSf: nn.describe("CAM/maintenance ₹/SF/month on areaBasis (0 = included/none)"),
  carParks: z.number().int().min(0).nullable().optional(), carParkRatePerSlot: nn.describe("₹ per car park per month (0 = free)"),
  powerBackup: z.string().max(200).nullable().optional(),
  possessionDate: date, leaseCommencement: date, validUntil: date,
  seats: z.number().int().min(1).nullable().optional().describe("Seats the space supports, if known"),
  sourceDoc: z.string().max(300).nullable().optional(), sourcePage: z.union([z.number().int(), z.string().max(20)]).nullable().optional(),
  factStatus: factStatus.default("reported").describe("Default status of every field"),
  fieldStatus: z.record(z.string(), factStatus).optional().describe("Per-field status overrides, e.g. {rentPerSf: 'currently_confirmed'}"),
  notes: z.string().max(2000).nullable().optional(),
});
export type LandlordOffer = z.infer<typeof landlordOfferSchema>;

export const blank = (x: unknown) => x === null || x === undefined || x === "";
export function statusOf(o: LandlordOffer, f: OfferField): OfferFactStatus | null {
  if (blank((o as Record<string, unknown>)[f])) return null;
  return (o.fieldStatus?.[f] as OfferFactStatus | undefined) ?? o.factStatus ?? "reported";
}

/** Map a landlord offer to the existing quote terms_json keys so older deal screens keep working. */
export function offerToQuoteTerms(o: LandlordOffer): Record<string, unknown> {
  return {
    rent: o.rentPerSf ?? null, rent_basis: o.areaBasis ?? null, cam_per_sf: o.camPerSf ?? null, cam_included: o.camPerSf === 0 ? true : null,
    parking_per_slot: o.carParkRatePerSlot ?? null, escalation_pct: o.escalationPct ?? null, escalation_every_months: o.escalationEveryMonths ?? null,
    rent_free_months: o.rentFreeMonths ?? null, deposit_months: o.securityDepositMonths ?? null, capex_support: o.fitoutAllowanceInr ?? null,
    lockin_months: o.lockInMonths ?? null, tenure_months: o.termMonths ?? null, area_sf: o.areaSf ?? null,
  };
}

/** What the comparator needs to compute money for an offer. */
export function offerGaps(o: LandlordOffer): string[] {
  const g: string[] = [];
  if (blank(o.areaSf) || Number(o.areaSf) <= 0) g.push("area (SF)");
  if (blank(o.areaBasis)) g.push("area basis (chargeable/carpet)");
  if (blank(o.rentPerSf)) g.push("rent ₹/SF/month");
  if (blank(o.termMonths)) g.push("term (months)");
  if (!blank(o.escalationPct) && Number(o.escalationPct) > 0 && blank(o.escalationEveryMonths)) g.push("escalation interval (months)");
  if (!blank(o.carParks) && Number(o.carParks) > 0 && blank(o.carParkRatePerSlot)) g.push("car park rate (₹/slot/month)");
  return g;
}

export interface CompareOptions { discountRatePct: number; baseDate: string }

export function offerToLeaseTerms(o: LandlordOffer, opt: CompareOptions): LeaseTerms {
  const allowance = !blank(o.fitoutAllowanceInr) && Number(o.fitoutAllowanceInr) > 0 ? Number(o.fitoutAllowanceInr) : 0;
  return {
    name: o.name, label: (o.factStatus ?? "reported") === "ai_inference" ? "estimated" : "quoted",
    areaSf: o.areaSf as number, areaBasis: o.areaBasis as "chargeable" | "carpet", rentPerSf: o.rentPerSf as number,
    leaseCommencement: opt.baseDate, tenureMonths: o.termMonths as number,
    rentFreeMonths: o.rentFreeMonths ?? 0,
    escalationPct: o.escalationPct ?? null, escalationEveryMonths: o.escalationEveryMonths ?? null,
    camPerSf: o.camPerSf ?? null,
    parkingSlots: o.carParks ?? null, parkingRatePerSlot: o.carParkRatePerSlot ?? null,
    depositMonths: o.securityDepositMonths ?? null,
    otherRecurringState: "unknown",
    // landlord contribution at signing is a negative one-off (reduces contractual spend and NPV)
    nonRecurring: allowance ? [{ label: "Landlord fit-out allowance", amount: -allowance, leaseMonth: 0 }] : [],
    discountRatePct: opt.discountRatePct,
  };
}

export type Cell = string | number | null;
export interface OfferLine { key: string; label: string; unit: string; values: Cell[]; status: (OfferFactStatus | null)[]; best: number | null; note?: string }
export interface OfferComparisonResult {
  formula: string; leaseFormula: string; baseDate: string; discountRatePct: number; horizonMonths: number | null;
  names: string[];
  lines: OfferLine[];
  computed: boolean[];
  ranking: { rank: number; name: string; npv: string; nominalTco: string; deltaNpvVsBest: string; complete: boolean }[];
  unknowns: { offer: string; fields: string[] }[];
  assumptions: string[];
  missing: string[];
  leaseComparison: ReturnType<typeof compareLeaseOffers> | null;
}

const lowest = (vals: Cell[]): number | null => {
  let bi: number | null = null; let bv: Decimal | null = null;
  vals.forEach((v, i) => { if (v === null || v === "" || isNaN(Number(v))) return; const d = new Dec(v); if (!bv || d.lt(bv)) { bv = d; bi = i; } });
  return bi;
};
const highest = (vals: Cell[]): number | null => {
  const neg = vals.map((v) => (v === null || v === "" || isNaN(Number(v)) ? null : new Dec(v).neg().toString()));
  return lowest(neg);
};

/** Compare 1..10 offers. Offers missing area/rent/term are shown line by line but excluded from money totals. */
export function compareLandlordOffers(offers: LandlordOffer[], opt: CompareOptions): OfferComparisonResult {
  if (!offers.length) throw new Error("at least one offer required");
  const parsed = offers.map((o) => landlordOfferSchema.parse(o));
  const names = parsed.map((o, i) => (parsed.findIndex((x) => x.name === o.name) === i ? o.name : `${o.name} (${i + 1})`));
  const withNames = parsed.map((o, i) => ({ ...o, name: names[i] }));
  const gaps = withNames.map(offerGaps);
  const computed = gaps.map((g) => g.length === 0);
  const terms = withNames.map((o, i) => (computed[i] ? offerToLeaseTerms(o, opt) : null));
  const ok = terms.filter((t): t is LeaseTerms => !!t);
  for (const t of ok) { const v = validateTerms(t); if (v.length) throw new Error(`${t.name}: missing ${v.join(", ")}`); }
  const cmp = ok.length ? compareLeaseOffers(ok) : null;
  const occ = withNames.map((o, i) => (terms[i] ? occupancyEconomics({ terms: terms[i]!, extras: {} }) : null));
  const econ = new Map(cmp?.offers.map((e) => [e.name, e]) ?? []);
  const rank = new Map(cmp?.rows.map((r) => [r.name, r]) ?? []);
  const E = (i: number) => econ.get(names[i]) ?? null;

  const raw = (f: OfferField): Cell[] => withNames.map((o) => { const v = (o as Record<string, unknown>)[f]; return blank(v) ? null : (v as Cell); });
  const st = (f: OfferField) => withNames.map((o) => statusOf(o, f));
  const calc = (fn: (i: number) => Cell): Cell[] => withNames.map((_, i) => fn(i));
  const none = withNames.map(() => null);
  const lines: OfferLine[] = [];
  const push = (key: string, label: string, unit: string, values: Cell[], status: (OfferFactStatus | null)[], better: "low" | "high" | null, note?: string) =>
    lines.push({ key, label, unit, values, status, best: better === "low" ? lowest(values) : better === "high" ? highest(values) : null, ...(note ? { note } : {}) });

  push("building", "Building / space", "", withNames.map((o) => [o.buildingName, o.floorUnit].filter(Boolean).join(" · ") || null), none, null);
  push("areaSf", "Area", "SF", raw("areaSf"), st("areaSf"), null);
  push("areaBasis", "Area basis", "", raw("areaBasis"), st("areaBasis"), null);
  push("efficiencyPct", "Efficiency (carpet ÷ chargeable)", "%", raw("efficiencyPct"), st("efficiencyPct"), "high");
  push("rentPerSf", "Rent", "₹/SF/month", raw("rentPerSf"), st("rentPerSf"), "low");
  // rent on carpet for like-for-like: chargeable rent ÷ efficiency (only when efficiency is known)
  push("rentPerCarpetSf", "Rent on carpet area", "₹/SF/month", withNames.map((o) => {
    if (blank(o.rentPerSf) || !o.areaBasis) return null;
    if (o.areaBasis === "carpet") return new Dec(o.rentPerSf!).toFixed(2);
    return blank(o.efficiencyPct) ? null : new Dec(o.rentPerSf!).div(new Dec(o.efficiencyPct!).div(100)).toFixed(2);
  }), none, "low", "Chargeable rent ÷ efficiency; unknown if efficiency is not stated");
  push("escalation", "Escalation", "", withNames.map((o) => blank(o.escalationPct) ? null : Number(o.escalationPct) === 0 ? "none" : `${o.escalationPct}% every ${o.escalationEveryMonths ?? "?"} months`), st("escalationPct"), null);
  push("termMonths", "Term", "months", raw("termMonths"), st("termMonths"), null);
  push("lockInMonths", "Lock-in", "months", raw("lockInMonths"), st("lockInMonths"), "low");
  push("rentFreeMonths", "Rent-free", "months", raw("rentFreeMonths"), st("rentFreeMonths"), "high");
  push("securityDepositMonths", "Security deposit", "months of rent", raw("securityDepositMonths"), st("securityDepositMonths"), "low");
  push("fitoutAllowanceInr", "Fit-out allowance", "₹", raw("fitoutAllowanceInr"), st("fitoutAllowanceInr"), "high");
  push("camPerSf", "CAM / maintenance", "₹/SF/month", raw("camPerSf"), st("camPerSf"), "low");
  push("carParks", "Car parks", "slots", raw("carParks"), st("carParks"), "high");
  push("carParkRatePerSlot", "Car park rate", "₹/slot/month", raw("carParkRatePerSlot"), st("carParkRatePerSlot"), "low");
  push("powerBackup", "Power backup", "", raw("powerBackup"), st("powerBackup"), null);
  push("possessionDate", "Possession date", "", raw("possessionDate"), st("possessionDate"), null);
  push("validUntil", "Offer valid until", "", raw("validUntil"), st("validUntil"), null);
  push("seats", "Seats", "", raw("seats"), st("seats"), "high");
  // ---- calculated (lease-1.0 / occ-1.0)
  push("monthlyRent", "Month-1 rent", "₹/month", calc((i) => E(i)?.monthly.baseRent ?? null), none, "low");
  push("effectiveRentPerSf", "Effective rent (after rent-free, escalation)", "₹/SF/month", calc((i) => occ[i]?.effectiveRentPerSf ?? null), none, "low");
  push("pvEffectiveRentPerSf", "PV-equivalent rent", "₹/SF/month", calc((i) => occ[i]?.pvEffectiveRentPerSf ?? null), none, "low");
  push("totalRent", "Total rent over horizon", "₹", calc((i) => E(i)?.totals.rent ?? null), none, "low");
  push("totalCam", "Total CAM over horizon", "₹", calc((i) => E(i)?.totals.cam ?? null), none, "low");
  push("totalParking", "Total car parks over horizon", "₹", calc((i) => E(i)?.totals.parking ?? null), none, "low");
  push("depositAmount", "Security deposit amount", "₹", calc((i) => (E(i) ? E(i)!.deposit?.amount ?? (blank(withNames[i].securityDepositMonths) ? null : "0.00") : null)), none, "low");
  push("totalCost", "Total cost over horizon (net of fit-out allowance)", "₹", calc((i) => E(i)?.totals.contractualExpenditure ?? null), none, "low");
  push("npv", `NPV of cost @ ${opt.discountRatePct}%`, "₹", calc((i) => rank.get(names[i])?.npv ?? null), none, "low");
  push("costPerSeat", "Total cost per seat", "₹/seat", calc((i) => {
    const e = E(i); const s = withNames[i].seats; return e && !blank(s) ? new Dec(e.totals.contractualExpenditure).div(s!).toFixed(2) : null;
  }), none, "low");
  push("monthlyPerSeat", "Month-1 rent per seat", "₹/seat/month", calc((i) => {
    const e = E(i); const s = withNames[i].seats; return e && !blank(s) ? new Dec(e.monthly.baseRent).div(s!).toFixed(2) : null;
  }), none, "low");
  push("complete", "Totals complete?", "", calc((i) => (E(i) ? (E(i)!.complete ? "complete" : `INCOMPLETE — excludes ${E(i)!.gaps.join(", ")}`) : "not computed")), none, null);

  const unknowns = withNames.map((o) => ({ offer: o.name, fields: OFFER_FIELDS.filter((f) => blank((o as Record<string, unknown>)[f])) as string[] }));
  const missing: string[] = [];
  withNames.forEach((o, i) => { if (gaps[i].length) missing.push(`${o.name}: not costed — missing ${gaps[i].join(", ")}`); });
  for (const e of cmp?.offers ?? []) if (e.gaps.length) missing.push(`${e.name}: totals exclude unknown ${e.gaps.join(", ")}`);
  const bestNpv = cmp?.rows.length ? cmp.rows.reduce((a, r) => (new Dec(r.npv).lt(a) ? new Dec(r.npv) : a), new Dec(cmp.rows[0].npv)) : null;
  const ranking = (cmp?.rows ?? []).slice().sort((a, b) => a.rank - b.rank).map((r) => ({ rank: r.rank, name: r.name, npv: r.npv, nominalTco: r.nominalTco, deltaNpvVsBest: new Dec(r.npv).minus(bestNpv!).toFixed(2), complete: r.complete }));
  const assumptions = [
    `All offers costed from a common commencement ${opt.baseDate} so the horizon and discounting are equal; actual possession dates are listed per offer`,
    `Discount rate ${opt.discountRatePct}% p.a.; NPV is the present value of cost (lower is better)`,
    cmp && new Set(ok.map((t) => t.tenureMonths)).size > 1 ? `Equal horizon ${cmp.horizonMonths} months: shorter terms continue on the same terms to the horizon` : null,
    "Fit-out allowance treated as a landlord payment at signing (reduces total cost and NPV)",
    "Other recurring charges (property tax, insurance, utilities) are not in the offers and are left unknown",
    "Rent on carpet area uses the stated efficiency only; it is not estimated",
    ...(cmp?.warnings ?? []),
  ].filter(Boolean) as string[];
  return {
    formula: OFFER_CMP_FORMULA, leaseFormula: LEASE_FORMULA, baseDate: opt.baseDate, discountRatePct: opt.discountRatePct, horizonMonths: cmp?.horizonMonths ?? null,
    names, lines, computed, ranking, unknowns, assumptions, missing, leaseComparison: cmp,
  };
}
