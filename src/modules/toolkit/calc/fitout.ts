/**
 * Fit-out budget + partner quotation comparison — formula "fitout-1.0". PURE, deterministic (decimal.js), never AI.
 * Rules: unknown stays unknown (null ≠ 0); tax is always explicit (amounts are entered EXCLUDING tax, tax % per line);
 * every partner (including any tenant-preferred partner) goes through the same normalisation and ranking.
 */
import Decimal from "decimal.js";
import { assertValidInputs } from "./validate";

export const FITOUT_FORMULA = "fitout-1.0";
export const FITOUT_CATEGORIES = [
  "interior_design", "civil", "flooring", "ceiling", "electrical", "hvac", "lighting", "furniture", "workstations",
  "meeting_rooms", "cabins", "reception", "pantry", "it", "network", "security", "fire_safety", "other",
] as const;
export type FitoutCategory = (typeof FITOUT_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<FitoutCategory, string> = {
  interior_design: "Interior design", civil: "Civil", flooring: "Flooring", ceiling: "Ceiling", electrical: "Electrical",
  hvac: "HVAC", lighting: "Lighting", furniture: "Furniture", workstations: "Workstations", meeting_rooms: "Meeting rooms",
  cabins: "Cabins", reception: "Reception", pantry: "Pantry", it: "IT", network: "Network", security: "Security",
  fire_safety: "Fire & safety", other: "Other",
};
export const STAGES = ["estimated", "approved", "actual"] as const;
export type Stage = (typeof STAGES)[number];

type Num = string | number | null | undefined;
export interface FitoutLine {
  category: FitoutCategory; description?: string; quantity?: Num; unit?: string; unitPrice?: Num;
  vendor?: string; quoteRef?: string; taxPct?: Num;
  /** Pre-tax amounts. estimated defaults to quantity × unit price when blank (labelled "derived"). */
  estimated?: Num; approved?: Num; actual?: Num;
}
export interface FitoutInput { lines: FitoutLine[]; areaSf?: Num; seats?: Num }

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export function num(v: Num): Decimal | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[,₹\s]/g, "").trim();
  if (!s || /^(na|n\/a|-|tbd|unknown)$/i.test(s)) return null;
  try { const d = new D(s); return d.isFinite() ? d : null; } catch { return null; }
}
const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export interface StageTotal { net: string; tax: string; gross: string; lines: number; unknownLines: number; unknownTaxLines: number }
interface Acc { net: Decimal; tax: Decimal; lines: number; unknown: number; unknownTax: number }
const acc = (): Acc => ({ net: new D(0), tax: new D(0), lines: 0, unknown: 0, unknownTax: 0 });
const out = (a: Acc): StageTotal => ({ net: r2(a.net), tax: r2(a.tax), gross: r2(a.net.plus(a.tax)), lines: a.lines, unknownLines: a.unknown, unknownTaxLines: a.unknownTax });

export interface FitoutResult {
  formula: string;
  lines: Array<{ index: number; category: FitoutCategory; estimatedSource: "entered" | "derived" | "unknown" } & Record<Stage, { net: string | null; tax: string | null; gross: string | null }>>;
  byCategory: Array<{ category: FitoutCategory; label: string } & Record<Stage, StageTotal>>;
  totals: Record<Stage, StageTotal>;
  variance: { approvedVsEstimated: string | null; actualVsApproved: string | null; actualVsEstimated: string | null };
  perSf: Record<Stage, string | null>; perSeat: Record<Stage, string | null>;
  missing: string[];
}

export function computeFitout(input: FitoutInput): FitoutResult {
  assertValidInputs(input);
  const missing: string[] = [];
  const totals = { estimated: acc(), approved: acc(), actual: acc() } as Record<Stage, Acc>;
  const cats = new Map<FitoutCategory, Record<Stage, Acc>>();
  const lines: FitoutResult["lines"] = [];
  input.lines.forEach((l, i) => {
    if (!FITOUT_CATEGORIES.includes(l.category)) throw new Error(`Unknown category on line ${i + 1}`);
    const taxPct = num(l.taxPct);
    if (taxPct === null) missing.push(`Line ${i + 1}: tax % not given (tax is never assumed)`);
    const qty = num(l.quantity), up = num(l.unitPrice);
    let estSource: "entered" | "derived" | "unknown" = "unknown";
    const amounts: Record<Stage, Decimal | null> = { estimated: num(l.estimated), approved: num(l.approved), actual: num(l.actual) };
    if (amounts.estimated) estSource = "entered";
    else if (qty && up) { amounts.estimated = qty.times(up); estSource = "derived"; }
    if (!cats.has(l.category)) cats.set(l.category, { estimated: acc(), approved: acc(), actual: acc() });
    const c = cats.get(l.category)!;
    const row = { index: i, category: l.category, estimatedSource: estSource } as FitoutResult["lines"][number];
    for (const s of STAGES) {
      const amt = amounts[s];
      for (const a of [totals[s], c[s]]) {
        if (amt === null) { a.unknown++; continue; }
        a.lines++; a.net = a.net.plus(amt);
        if (taxPct === null) a.unknownTax++; else a.tax = a.tax.plus(amt.times(taxPct).div(100));
      }
      const tax = amt && taxPct !== null ? amt.times(taxPct).div(100) : null;
      row[s] = { net: amt ? r2(amt) : null, tax: tax ? r2(tax) : null, gross: amt && tax ? r2(amt.plus(tax)) : null };
    }
    lines.push(row);
  });
  if (!input.lines.length) missing.push("No line items yet");
  const T = { estimated: out(totals.estimated), approved: out(totals.approved), actual: out(totals.actual) };
  const has = (s: Stage) => totals[s].lines > 0;
  const g = (s: Stage) => totals[s].net.plus(totals[s].tax);
  const diff = (a: Stage, b: Stage) => (has(a) && has(b) ? r2(g(a).minus(g(b))) : null);
  const area = num(input.areaSf), seats = num(input.seats);
  const per = (d: Decimal | null) => Object.fromEntries(STAGES.map((s) => [s, d && d.gt(0) && has(s) ? r2(g(s).div(d)) : null])) as Record<Stage, string | null>;
  return {
    formula: FITOUT_FORMULA, lines,
    byCategory: FITOUT_CATEGORIES.filter((k) => cats.has(k)).map((k) => ({ category: k, label: CATEGORY_LABEL[k], estimated: out(cats.get(k)!.estimated), approved: out(cats.get(k)!.approved), actual: out(cats.get(k)!.actual) })),
    totals: T,
    variance: { approvedVsEstimated: diff("approved", "estimated"), actualVsApproved: diff("actual", "approved"), actualVsEstimated: diff("actual", "estimated") },
    perSf: per(area), perSeat: per(seats), missing,
  };
}

/* ---------------- Partner quotation comparison ---------------- */
export interface PartnerQuote {
  partnerName: string; partnerId?: string | null; scope?: FitoutCategory[]; exclusions?: string[];
  price?: Num; taxPct?: Num; deliveryWeeks?: Num; paymentSchedule?: string; warrantyMonths?: Num;
  validUntil?: string | null; documentsUrl?: string | null; status?: "quoted" | "approved";
}
export interface QuoteCriteria { price: number; scope: number; timeline: number; warranty: number }
export const DEFAULT_CRITERIA: QuoteCriteria = { price: 40, scope: 30, timeline: 15, warranty: 15 };
export interface QuoteCompareInput {
  quotes: PartnerQuote[]; requiredScope: FitoutCategory[]; asOf: string; criteria?: QuoteCriteria;
  preferredIndex?: number | null; preferredReason?: string | null;
}
export interface QuoteRow {
  index: number; partnerName: string; priceExTax: string | null; tax: string | null; priceInclTax: string | null;
  coverage: string | null; scopeGaps: FitoutCategory[]; extraScope: FitoutCategory[]; exclusions: string[];
  expired: boolean | null; flags: string[];
  scores: { price: string; scope: string; timeline: string; warranty: string; total: string }; rank: number;
}
export interface QuoteCompareResult { formula: string; criteria: QuoteCriteria; method: string; rows: QuoteRow[]; preferred: { index: number; reason: string } | null; missing: string[] }

/**
 * Transparent ranking: each criterion scored 0–1 then multiplied by its stated weight.
 * price: lowest incl.-tax ÷ this; scope: covered required ÷ required; timeline: fastest weeks ÷ this; warranty: this ÷ longest.
 * Unknown values score 0 for that criterion and are flagged (unknown is never treated as best or as zero cost).
 * Ties are broken by partner name so order never depends on input order or on who the partner is.
 */
export function compareQuotes(input: QuoteCompareInput): QuoteCompareResult {
  assertValidInputs(input.quotes);
  const c = input.criteria ?? DEFAULT_CRITERIA;
  const missing: string[] = [];
  const asOf = input.asOf.slice(0, 10);
  const req = [...new Set(input.requiredScope)];
  const base = input.quotes.map((q, i) => {
    const flags: string[] = [];
    const price = num(q.price), taxPct = num(q.taxPct), weeks = num(q.deliveryWeeks), warr = num(q.warrantyMonths);
    if (price === null) flags.push("Price not given");
    if (taxPct === null) flags.push("Tax % not stated — incl.-tax price unknown");
    if (weeks === null) flags.push("Delivery timeline not given");
    if (warr === null) flags.push("Warranty not given");
    const tax = price && taxPct !== null ? price.times(taxPct).div(100) : null;
    const incl = price && tax ? price.plus(tax) : null;
    const scope = q.scope ?? [];
    const gaps = req.filter((s) => !scope.includes(s));
    const extra = scope.filter((s) => !req.includes(s));
    if (gaps.length) flags.push(`Scope gap: ${gaps.map((g) => CATEGORY_LABEL[g]).join(", ")}`);
    if ((q.exclusions ?? []).length) flags.push(`Exclusions: ${(q.exclusions ?? []).join("; ")}`);
    const expired = q.validUntil ? q.validUntil.slice(0, 10) < asOf : null;
    if (expired) flags.unshift(`EXPIRED on ${q.validUntil!.slice(0, 10)}`);
    if (expired === null) flags.push("Validity date not given");
    const coverage = req.length ? new D(req.length - gaps.length).div(req.length) : null;
    return { i, q, incl, price, tax, weeks, warr, coverage, gaps, extra, expired, flags };
  });
  const known = <T,>(xs: (T | null)[]) => xs.filter((x): x is T => x !== null);
  const minIncl = Decimal.min(...(known(base.map((b) => b.incl)).length ? known(base.map((b) => b.incl)) : [new D(0)]));
  const minWeeks = known(base.map((b) => b.weeks)).filter((w) => w.gt(0));
  const maxWarr = known(base.map((b) => b.warr));
  const fastest = minWeeks.length ? Decimal.min(...minWeeks) : null;
  const longest = maxWarr.length ? Decimal.max(...maxWarr) : null;
  const sc = (d: Decimal) => d.toDecimalPlaces(4).toFixed(4);
  const rows = base.map((b) => {
    const p = b.incl && b.incl.gt(0) ? minIncl.div(b.incl) : new D(0);
    const s = b.coverage ?? new D(0);
    const t = b.weeks && b.weeks.gt(0) && fastest ? fastest.div(b.weeks) : new D(0);
    const w = b.warr && longest && longest.gt(0) ? b.warr.div(longest) : new D(0);
    const total = p.times(c.price).plus(s.times(c.scope)).plus(t.times(c.timeline)).plus(w.times(c.warranty));
    return { b, scores: { price: sc(p), scope: sc(s), timeline: sc(t), warranty: sc(w), total: total.toDecimalPlaces(2).toFixed(2) }, total };
  });
  const order = [...rows].sort((x, y) => y.total.cmp(x.total) || x.b.q.partnerName.localeCompare(y.b.q.partnerName));
  const out: QuoteRow[] = rows.map((r) => ({
    index: r.b.i, partnerName: r.b.q.partnerName,
    priceExTax: r.b.price ? r2(r.b.price) : null, tax: r.b.tax ? r2(r.b.tax) : null, priceInclTax: r.b.incl ? r2(r.b.incl) : null,
    coverage: r.b.coverage ? r.b.coverage.times(100).toDecimalPlaces(1).toFixed(1) : null,
    scopeGaps: r.b.gaps, extraScope: r.b.extra, exclusions: r.b.q.exclusions ?? [], expired: r.b.expired, flags: r.b.flags,
    scores: r.scores, rank: order.indexOf(r) + 1,
  }));
  if (!req.length) missing.push("Required scope not set — scope coverage cannot be compared");
  if (!input.quotes.length) missing.push("No quotations yet");
  let preferred: QuoteCompareResult["preferred"] = null;
  if (input.preferredIndex !== null && input.preferredIndex !== undefined) {
    const reason = (input.preferredReason ?? "").trim();
    if (!input.quotes[input.preferredIndex]) throw new Error("Preferred quotation does not exist");
    if (reason.length < 10) throw new Error("A preferred partner needs a typed reason (at least 10 characters)");
    preferred = { index: input.preferredIndex, reason };
  }
  const method = `Score = price×${c.price} + scope×${c.scope} + timeline×${c.timeline} + warranty×${c.warranty}; each criterion 0–1 (price: lowest incl.-tax ÷ this; scope: required categories covered ÷ required; timeline: fastest ÷ this; warranty: this ÷ longest). Unknown = 0 and flagged. Ties by name.`;
  return { formula: FITOUT_FORMULA, criteria: c, method, rows: out, preferred, missing };
}
