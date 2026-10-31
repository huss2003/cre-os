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
}

function yearOf(d: string) { return Number(d.slice(0, 4)); }

/**
 * Annual trend for one metric/geography. Gaps stay null. Change vs previous is computed only when both points are
 * full_year actuals with the same unit (or both forecasts flagged as such). Latest release wins per period.
 */
export function annualTrend(obs: Observation[], metric: string, geography: string | null, years?: number[]): TrendPoint[] {
  const rows = obs.filter((o) => o.metric === metric && (geography === null || (o.geography_id ?? o.geography_raw) === geography) && o.period_type !== "quarter" && o.period_type !== "month");
  const byYear = new Map<number, Observation>();
  for (const o of rows) {
    const y = yearOf(o.period_start);
    const cur = byYear.get(y);
    if (!cur || (o.release_date ?? "") > (cur.release_date ?? "")) byYear.set(y, o);
  }
  const ys = years ?? (byYear.size ? range(Math.min(...byYear.keys()), Math.max(...byYear.keys())) : []);
  const out: TrendPoint[] = [];
  for (const y of ys) {
    const o = byYear.get(y);
    if (!o) {
      out.push({ label: String(y), period_start: `${y}-01-01`, period_type: "full_year", value: null, unit: null, observation_id: null, release_date: null, is_forecast: false, comparable_to_previous: null, change: null, note: "No observation — unknown (not zero, not carried forward)." });
      continue;
    }
    out.push({ label: `${y}${o.period_type === "ytd" ? " YTD" : o.period_type === "forecast" ? " (forecast)" : ""}`, period_start: o.period_start, period_type: o.period_type, value: Number(o.value), unit: o.unit, observation_id: o.id, release_date: o.release_date, is_forecast: o.period_type === "forecast", comparable_to_previous: null, change: null });
  }
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i];
    if (a.value === null || b.value === null) { b.comparable_to_previous = null; continue; }
    const ok = a.period_type === b.period_type && (a.period_type === "full_year" || a.period_type === "snapshot") && a.unit === b.unit;
    b.comparable_to_previous = ok;
    if (ok) b.change = round(b.value - a.value, 4);
    else b.note = `Not comparable with ${a.label}: ${a.period_type} vs ${b.period_type}${a.unit !== b.unit ? `, ${a.unit} vs ${b.unit}` : ""}.`;
  }
  return out;
}

function range(a: number, b: number) { const r: number[] = []; for (let i = a; i <= b; i++) r.push(i); return r; }
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

/** Deterministic facts sentence list for a market note (no LLM numbers). */
export function factsFromTrend(metric: string, geography: string, trend: TrendPoint[]): { text: string; observation_id: string | null }[] {
  return trend.filter((p) => p.value !== null).map((p) => ({
    text: `${metric.replace(/_/g, " ")} — ${geography} — ${p.label}: ${p.value} ${p.unit ?? ""}${p.change !== null ? ` (change vs previous comparable period: ${p.change > 0 ? "+" : ""}${p.change})` : p.comparable_to_previous === false ? " (not comparable with previous period)" : ""}`.replace(/\s+/g, " ").trim(),
    observation_id: p.observation_id,
  }));
}
