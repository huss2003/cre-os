/**
 * Market analyst — deterministic series rules (spec Part I §8 "Market analyst", Part III "Historical periods").
 *  - Definition / date / source gating: an observation without a definition, release date and source is excluded and reported.
 *  - Stock is a snapshot: never summed across periods.
 *  - No invented supply: a year with no observation is UNKNOWN (null), never 0 and never copied forward.
 *  - Annual comparisons are blocked across mismatched period types (full_year vs ytd vs forecast vs quarter).
 *  - No vacancy from stock minus gross absorption; months-of-supply needs available inventory and net take-up.
 */
import { median, percentile } from "../common";

export type PeriodType = "full_year" | "ytd" | "quarter" | "month" | "forecast" | "snapshot";
export interface Observation {
  id: string; metric: string; geography_id: string | null; geography_raw: string | null;
  period_start: string; period_end: string | null; period_type: PeriodType; unit: string | null; value: number | null;
  definition: string | null; release_date: string | null; source_object_id: string | null; source_version: string | null;
}

export type MetricKind = "stock" | "flow" | "rate" | "price";
export function metricKind(metric: string): MetricKind {
  const m = metric.toLowerCase();
  if (/stock|inventory|available_inventory/.test(m)) return "stock";
  if (/vacancy|occupancy|rate|yield|share/.test(m)) return "rate";
  if (/rent|price|rental|cam/.test(m)) return "price";
  return "flow"; // absorption, supply, completions, transactions, take-up
}

export interface GateResult { accepted: Observation[]; excluded: { id: string; metric: string; reason: string }[] }

export function gateObservations(obs: Observation[]): GateResult {
  const accepted: Observation[] = [];
  const excluded: GateResult["excluded"] = [];
  for (const o of obs) {
    const reasons: string[] = [];
    if (o.value === null || o.value === undefined || Number.isNaN(Number(o.value))) reasons.push("value missing");
    if (!o.definition || !o.definition.trim()) reasons.push("no metric definition");
    if (!o.release_date) reasons.push("no release date");
    if (!o.source_object_id && !o.source_version) reasons.push("no source");
    if (!o.unit) reasons.push("no unit");
    if (!o.period_start) reasons.push("no period");
    if (reasons.length) excluded.push({ id: o.id, metric: o.metric, reason: reasons.join(", ") });
    else accepted.push(o);
  }
  return { accepted, excluded };
}

export interface TrendPoint {
  label: string; period_start: string; period_type: PeriodType; value: number | null; unit: string | null;
  observation_id: string | null; release_date: string | null; is_forecast: boolean; comparable_to_previous: boolean | null; change: number | null; note?: string;
  definition?: string | null; source_object_id?: string | null; source_version?: string | null;
}

export type PeriodFamily = "annual" | "quarter" | "month";
export function periodFamily(t: PeriodType): PeriodFamily { return t === "quarter" ? "quarter" : t === "month" ? "month" : "annual"; }

function yearOf(d: string) { return Number(d.slice(0, 4)); }
const normDef = (d: string | null | undefined) => (d ?? "").replace(/\s+/g, " ").trim().toLowerCase();
/** Actual beats YTD beats forecast for the same period; then the latest release wins. */
const PRIORITY: Record<PeriodType, number> = { full_year: 3, snapshot: 3, quarter: 3, month: 3, ytd: 2, forecast: 1 };

function periodKey(o: Observation, fam: PeriodFamily): string {
  if (fam === "annual") return o.period_start.slice(0, 4);
  if (fam === "quarter") return `${o.period_start.slice(0, 4)}-Q${Math.floor((Number(o.period_start.slice(5, 7)) - 1) / 3) + 1}`;
  return o.period_start.slice(0, 7);
}
function labelFor(key: string, o: Observation | null, fam: PeriodFamily): string {
  const base = fam === "quarter" ? key.replace("-", " ") : key;
  if (!o) return base;
  return `${base}${o.period_type === "ytd" ? " YTD" : o.period_type === "forecast" ? " (forecast)" : ""}`;
}
function periodKeys(keys: string[], fam: PeriodFamily): string[] {
  if (!keys.length) return [];
  const sorted = [...keys].sort();
  const out: string[] = [];
  if (fam === "annual") { for (let y = Number(sorted[0]); y <= Number(sorted[sorted.length - 1]); y++) out.push(String(y)); return out; }
  if (fam === "quarter") {
    let [y, q] = [Number(sorted[0].slice(0, 4)), Number(sorted[0].slice(6))];
    const [ey, eq] = [Number(sorted[sorted.length - 1].slice(0, 4)), Number(sorted[sorted.length - 1].slice(6))];
    while (y < ey || (y === ey && q <= eq)) { out.push(`${y}-Q${q}`); q++; if (q > 4) { q = 1; y++; } if (out.length > 400) break; }
    return out;
  }
  let [y, m] = [Number(sorted[0].slice(0, 4)), Number(sorted[0].slice(5, 7))];
  const [ey, em] = [Number(sorted[sorted.length - 1].slice(0, 4)), Number(sorted[sorted.length - 1].slice(5, 7))];
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } if (out.length > 600) break; }
  return out;
}

export interface Superseded { id: string; metric: string; reason: string }

/**
 * Trend for ONE series (caller has already grouped by metric, geography, unit and period family). Gaps stay null.
 * One point per period: actual > YTD > forecast, then latest release; every other observation is returned in `superseded`
 * with its reason (never silently dropped; revisions with a different value are called out). Change vs previous only when
 * both points are actuals of the same period type, unit and definition.
 */
export function seriesTrend(rows: Observation[], fam: PeriodFamily, years?: number[]): { points: TrendPoint[]; superseded: Superseded[] } {
  const byKey = new Map<string, Observation>();
  const superseded: Superseded[] = [];
  const better = (a: Observation, b: Observation) => PRIORITY[a.period_type] !== PRIORITY[b.period_type] ? PRIORITY[a.period_type] > PRIORITY[b.period_type] : (a.release_date ?? "") > (b.release_date ?? "");
  for (const o of rows) {
    const k = periodKey(o, fam);
    const cur = byKey.get(k);
    if (!cur) { byKey.set(k, o); continue; }
    const [win, lose] = better(o, cur) ? [o, cur] : [cur, o];
    byKey.set(k, win);
    const revised = lose.period_type === win.period_type && Number(lose.value) !== Number(win.value);
    superseded.push({ id: lose.id, metric: lose.metric, reason: lose.period_type !== win.period_type
      ? `${labelFor(k, lose, fam)}: ${lose.period_type} figure not charted because a ${win.period_type} figure exists for the same period`
      : `${labelFor(k, lose, fam)}: superseded by the release of ${win.release_date ?? "unknown date"}${revised ? ` (revised ${lose.value} → ${win.value})` : ""}` });
  }
  const keys = fam === "annual" && years ? years.map(String) : periodKeys([...byKey.keys()], fam);
  const out: TrendPoint[] = keys.map((k) => {
    const o = byKey.get(k);
    if (!o) return { label: labelFor(k, null, fam), period_start: fam === "annual" ? `${k}-01-01` : fam === "quarter" ? `${k.slice(0, 4)}-${String((Number(k.slice(6)) - 1) * 3 + 1).padStart(2, "0")}-01` : `${k}-01`, period_type: fam === "annual" ? "full_year" : (fam as PeriodType), value: null, unit: null, observation_id: null, release_date: null, is_forecast: false, comparable_to_previous: null, change: null, note: "No observation — unknown (not zero, not carried forward)." };
    return { label: labelFor(k, o, fam), period_start: o.period_start, period_type: o.period_type, value: Number(o.value), unit: o.unit, observation_id: o.id, release_date: o.release_date, is_forecast: o.period_type === "forecast", comparable_to_previous: null, change: null, definition: o.definition, source_object_id: o.source_object_id, source_version: o.source_version };
  });
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i];
    if (a.value === null || b.value === null) { b.comparable_to_previous = null; continue; }
    const actual = (t: PeriodType) => t === "full_year" || t === "snapshot" || t === "quarter" || t === "month";
    const sameDef = normDef(a.definition) === normDef(b.definition);
    const ok = a.period_type === b.period_type && actual(a.period_type) && a.unit === b.unit && sameDef;
    b.comparable_to_previous = ok;
    if (ok) b.change = round(b.value - a.value, 4);
    else {
      const why = [a.period_type !== b.period_type ? `${a.period_type} vs ${b.period_type}` : !actual(b.period_type) ? `${b.period_type} figures` : "", a.unit !== b.unit ? `${a.unit} vs ${b.unit}` : "", !sameDef ? "definition changed" : ""].filter(Boolean).join(", ");
      b.note = `Not comparable with ${a.label}: ${why}.`;
    }
  }
  return { points: out, superseded };
}

/**
 * Annual trend for one metric/geography (back-compatible helper). Quarterly and monthly observations are NOT mixed in:
 * they form their own series (see analyseMarket) — this helper only reads annual-family rows.
 */
export function annualTrend(obs: Observation[], metric: string, geography: string | null, years?: number[]): TrendPoint[] {
  const rows = obs.filter((o) => o.metric === metric && (geography === null || (o.geography_id ?? o.geography_raw) === geography) && periodFamily(o.period_type) === "annual");
  return seriesTrend(rows, "annual", years).points;
}

function round(n: number, dp: number) { const f = 10 ** dp; return Math.round(n * f) / f; }

export class SeriesRuleError extends Error {}

/** Sum a metric across periods. Refuses stock (snapshot) metrics and mixed period types/units. */
export function sumAcrossPeriods(points: { value: number | null; period_type: PeriodType; unit: string | null }[], metric: string): { total: number | null; missing: number } {
  if (metricKind(metric) === "stock") throw new SeriesRuleError(`${metric} is a stock snapshot; summing it over time is invalid.`);
  if (metricKind(metric) === "rate" || metricKind(metric) === "price") throw new SeriesRuleError(`${metric} is a rate/price; summing it over time is invalid.`);
  const types = new Set(points.map((p) => p.period_type));
  const units = new Set(points.map((p) => p.unit).filter(Boolean));
  if (types.size > 1) throw new SeriesRuleError(`Mixed period types (${[...types].join(", ")}) cannot be summed.`);
  if (units.size > 1) throw new SeriesRuleError(`Mixed units (${[...units].join(", ")}) cannot be summed.`);
  const missing = points.filter((p) => p.value === null).length;
  if (missing) return { total: null, missing };
  return { total: round(points.reduce((s, p) => s + (p.value as number), 0), 6), missing: 0 };
}

export interface VacancyResult { allowed: boolean; value: number | null; reason: string }

/** Vacancy only from a direct vacancy series or available inventory ÷ stock. Never stock minus cumulative gross absorption. */
export function deriveVacancy(input: { vacancyRate?: number | null; availableInventory?: number | null; stock?: number | null; grossAbsorption?: number | null }): VacancyResult {
  if (input.vacancyRate !== null && input.vacancyRate !== undefined) return { allowed: true, value: input.vacancyRate, reason: "Direct vacancy series." };
  if (input.availableInventory !== null && input.availableInventory !== undefined && input.stock) {
    return { allowed: true, value: round(input.availableInventory / input.stock, 6), reason: "Available inventory ÷ stock for the same period and definition." };
  }
  return { allowed: false, value: null, reason: "No vacancy or available-inventory series. Stock minus gross absorption is not a valid vacancy calculation." };
}

/** Months of supply needs available inventory and positive net (not gross) take-up on a matched basis. */
export function monthsOfSupply(input: { availableInventory: number | null; netTakeUpPerMonth: number | null; takeUpIsNet: boolean }): VacancyResult {
  if (input.availableInventory === null || input.netTakeUpPerMonth === null) return { allowed: false, value: null, reason: "Needs available inventory and net take-up." };
  if (!input.takeUpIsNet) return { allowed: false, value: null, reason: "Gross absorption cannot be used as net take-up." };
  if (input.netTakeUpPerMonth <= 0) return { allowed: false, value: null, reason: "Net take-up is not positive; months of supply undefined." };
  return { allowed: true, value: round(input.availableInventory / input.netTakeUpPerMonth, 2), reason: "Available inventory ÷ net take-up per month." };
}

/** Historical supply ÷ absorption for the SAME year and period type — labelled ratio, not months of supply. */
export function supplyAbsorptionRatio(supply: TrendPoint[], absorption: TrendPoint[]): { label: string; ratio: number | null; note: string }[] {
  const byLabel = new Map(absorption.map((a) => [a.period_start.slice(0, 4), a]));
  return supply.map((s) => {
    const a = byLabel.get(s.period_start.slice(0, 4));
    if (!a || s.value === null || a.value === null) return { label: s.label, ratio: null, note: "Unknown — missing supply or absorption." };
    if (s.period_type !== a.period_type) return { label: s.label, ratio: null, note: `Not comparable: supply ${s.period_type} vs absorption ${a.period_type}.` };
    if (s.unit !== a.unit) return { label: s.label, ratio: null, note: `Not comparable: supply in ${s.unit} vs absorption in ${a.unit}.` };
    if (s.is_forecast || a.is_forecast) return { label: s.label, ratio: null, note: "Forecast figures are not combined into ratios." };
    if (a.value <= 0) return { label: s.label, ratio: null, note: "Absorption not positive." };
    return { label: s.label, ratio: round(s.value / a.value, 2), note: "Historical supply-to-gross-absorption ratio (not months of supply, not a forecast)." };
  });
}

// ------------------------------------------------------------------ comparables
export interface TxLite {
  id: string; asset_id: string | null; asset_name: string | null; locality: string | null; period_start: string | null; deal_type: string | null;
  area_sf: number | null; rent_min: number | null; rent_max: number | null; rent_basis: string | null; tenant: string | null; source_object_id: string | null;
}
export interface CompsQuery { locality?: string | null; minSf?: number | null; maxSf?: number | null; sinceDate?: string | null; rentBasis?: string | null }
export interface CompsResult {
  rows: (TxLite & { rent_mid: number | null })[];
  stats: { basis: string; n: number; median: number | null; p25: number | null; p75: number | null }[];
  excluded: number;
}

/** Credible comparables: matched filters; rent statistics are computed per rent basis (bases are never mixed). */
export function comparables(txs: TxLite[], q: CompsQuery): CompsResult {
  const rows = txs.filter((t) =>
    (!q.locality || (t.locality ?? "").toLowerCase() === q.locality.toLowerCase()) &&
    (q.minSf === null || q.minSf === undefined || (t.area_sf !== null && t.area_sf >= q.minSf)) &&
    (q.maxSf === null || q.maxSf === undefined || (t.area_sf !== null && t.area_sf <= q.maxSf)) &&
    (!q.sinceDate || (t.period_start !== null && t.period_start >= q.sinceDate)) &&
    (!q.rentBasis || t.rent_basis === q.rentBasis),
  ).map((t) => ({ ...t, rent_mid: t.rent_min !== null && t.rent_max !== null ? (t.rent_min + t.rent_max) / 2 : t.rent_min ?? t.rent_max }));
  const byBasis = new Map<string, number[]>();
  for (const r of rows) if (r.rent_mid !== null) {
    const k = r.rent_basis ?? "basis unknown";
    byBasis.set(k, [...(byBasis.get(k) ?? []), r.rent_mid]);
  }
  const stats = [...byBasis.entries()].map(([basis, xs]) => ({ basis, n: xs.length, median: median(xs), p25: percentile(xs, 25), p75: percentile(xs, 75) }));
  return { rows: rows.sort((a, b) => (b.period_start ?? "").localeCompare(a.period_start ?? "")), stats, excluded: txs.length - rows.length };
}

export interface NoteFact { text: string; observation_id: string | null; period: string; unit: string | null; value: number; source_name: string; release_date: string | null; is_forecast: boolean }

/** Deterministic facts for a market note (no LLM numbers). Each fact names its period, unit, source and release date. */
export function factsFromTrend(metric: string, geography: string, trend: TrendPoint[], sourceName: (p: TrendPoint) => string = (p) => p.source_version ?? "source on file"): NoteFact[] {
  return trend.filter((p) => p.value !== null).map((p) => {
    const src = sourceName(p);
    const text = `${metric.replace(/_/g, " ")} — ${geography} — ${p.label}${p.is_forecast ? " [FORECAST by the source]" : ""}: ${p.value} ${p.unit ?? ""}${p.change !== null ? ` (change vs previous comparable period: ${p.change > 0 ? "+" : ""}${p.change})` : p.comparable_to_previous === false ? " (not comparable with previous period)" : ""} (Source: ${src}, released ${p.release_date ?? "date unknown"})`.replace(/\s+/g, " ").trim();
    return { text, observation_id: p.observation_id, period: p.label, unit: p.unit, value: p.value as number, source_name: src, release_date: p.release_date, is_forecast: p.is_forecast };
  });
}

export function marketDisclaimer(hasForecast: boolean): string {
  return hasForecast
    ? "Descriptive only. Points marked forecast are the publishing source's forecasts, labelled as such — CRE OS does not forecast. Figures carry their source, release date, period type and definition. Not a comprehensive view of the market."
    : "Descriptive only — not a forecast. Figures carry their source, release date, period type and definition. Not a comprehensive view of the market.";
}
