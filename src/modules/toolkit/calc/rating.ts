/**
 * Property Comparison Engine — weighted rating. PURE + deterministic (decimal.js); no AI arithmetic, no I/O.
 * FORMULA "rating-1.0":
 *   factor score f_i ∈ [0,1] computed from data (each with a reason). Unknown data => factor EXCLUDED (never 0)
 *   and listed under `missing`.
 *   score = 100 × Σ(w_i·f_i) / Σ(w_i)   over KNOWN factors only;   coverage = Σ(w_i known) / 100.
 *   Factors:
 *     location      1 if micro-market is in the requirement's preferred list, else 0.
 *     area          max(0, 1 − 2·|A − T| / T)   A = property area on the requirement's basis, T = target (else min).
 *     commercial    min(C) / C   where C = effective occupancy cost ₹/sf/month over the term:
 *                   C = (Σ_{m=1..M} rent_m − rentFreeMonths·rent_1) / M + CAM,
 *                   rent_m = rent·(1+esc)^floor((m−1)/escEveryMonths), M = term months (default 60, labelled).
 *                   Refundable deposit is NOT part of C (kept separate, reported on its own).
 *     quality       grade map A+ 1 · A 0.8 · B+ 0.6 · B 0.4 · C 0.2.
 *     connectivity  max(0, 1 − metroKm / 5).
 *     amenities     share of required amenities present; if none required: min(1, count / 5).
 *     custom keys   manual 0–1 score supplied per property.
 *   Mandatory rule failed or disqualifying rule hit => "not_eligible" (cannot be recommended, whatever the score).
 *   A mandatory rule that cannot be checked (data unknown) => "unconfirmed" (not recommended until verified).
 */
import Decimal from "decimal.js";

export const RATING_FORMULA = "rating-1.0";
export const DEFAULT_TERM_MONTHS = 60;
export const STALE_AVAILABILITY_DAYS = 90;

export interface RatingFactor { key: string; label: string; weight: number }
export type RuleField = "areaSf" | "rent" | "cam" | "occupancyCost" | "microMarket" | "grade" | "depositMonths" | "metroKm";
export type RuleOp = "gte" | "lte" | "eq" | "in" | "not_in";
/** value may reference the requirement: "$areaMin", "$areaMax", "$budgetMax", "$microMarkets". */
export interface RatingRule { kind: "mandatory" | "disqualify"; field: RuleField; op: RuleOp; value: number | string | string[]; label: string }
export interface RatingModel { name: string; version?: number; factors: RatingFactor[]; rules: RatingRule[] }

export type AreaBasis = "carpet" | "chargeable";
export interface RatingRequirement {
  title?: string;
  areaMinSf?: number | null; areaTargetSf?: number | null; areaMaxSf?: number | null; areaBasis?: AreaBasis | null;
  budgetMax?: number | null;            // ₹/sf/month (rent)
  microMarkets?: string[];              // preferred
  requiredAmenities?: string[];
  termMonths?: number | null;
}
export type Evidence = "estimated" | "quoted" | "approved" | "actual" | "manual";
export interface RatingProperty {
  key: string; name: string; source: "db" | "manual";
  microMarket?: string | null; grade?: string | null;
  areaSf?: number | null; areaBasis?: AreaBasis | null; efficiency?: number | null; // carpet / chargeable
  rent?: number | null; rentBasis?: AreaBasis | "seat" | null; cam?: number | null;
  depositMonths?: number | null; rentFreeMonths?: number | null;
  escalationPct?: number | null; escalationEveryMonths?: number | null;
  metroKm?: number | null; amenities?: string[] | null;
  customScores?: Record<string, number | null | undefined>;
  availabilityStatus?: string | null; availabilityAsOf?: string | null; factStatus?: string | null;
  evidence?: Evidence | null;
}

export interface FactorResult { key: string; label: string; weight: number; score: number | null; points: number | null; reason: string }
export interface RuleResult { label: string; kind: RatingRule["kind"]; outcome: "pass" | "fail" | "unknown"; detail: string }
export type Eligibility = "eligible" | "not_eligible" | "unconfirmed";
export interface PropertyRating {
  key: string; name: string; source: RatingProperty["source"]; evidence: Evidence | null;
  score: number | null; coverage: number; occupancyCost: number | null; depositMonths: number | null;
  factors: FactorResult[]; rules: RuleResult[]; eligibility: Eligibility;
  advantages: string[]; disadvantages: string[]; limitations: string[]; missing: string[]; verification: string[];
  rank: number | null;
}
export interface RatingResult {
  formula: typeof RATING_FORMULA; model: { name: string; version: number | null }; termMonths: number; termAssumed: boolean;
  properties: PropertyRating[];
  recommendation: { key: string | null; explanation: string; tie: boolean };
}

export const DEFAULT_FACTORS: RatingFactor[] = [
  { key: "location", label: "Location", weight: 20 },
  { key: "area", label: "Area fit", weight: 20 },
  { key: "commercial", label: "Commercials", weight: 25 },
  { key: "quality", label: "Building quality", weight: 15 },
  { key: "connectivity", label: "Connectivity", weight: 10 },
  { key: "amenities", label: "Amenities", weight: 10 },
];
export const DEFAULT_RULES: RatingRule[] = [
  { kind: "mandatory", field: "areaSf", op: "gte", value: "$areaMin", label: "Area ≥ requirement minimum" },
  { kind: "mandatory", field: "rent", op: "lte", value: "$budgetMax", label: "Rent ≤ budget" },
  { kind: "mandatory", field: "microMarket", op: "in", value: "$microMarkets", label: "Micro-market in preferred list" },
];
export const DEFAULT_MODEL: RatingModel = { name: "Default", version: 1, factors: DEFAULT_FACTORS, rules: DEFAULT_RULES };
export const BUILTIN_FACTORS = ["location", "area", "commercial", "quality", "connectivity", "amenities"];
const GRADE: Record<string, number> = { "A+": 1, A: 0.8, "B+": 0.6, B: 0.4, C: 0.2 };

export class RatingModelError extends Error {}

export function validateModel(m: RatingModel): string[] {
  const errs: string[] = [];
  if (!m.factors.length) errs.push("Add at least one factor.");
  const keys = new Set<string>();
  let sum = new Decimal(0);
  for (const f of m.factors) {
    if (!f.key || !/^[a-z][a-z0-9_]*$/.test(f.key)) errs.push(`Factor key "${f.key}" must be lower-case letters, digits or _.`);
    if (keys.has(f.key)) errs.push(`Factor "${f.key}" appears twice.`);
    keys.add(f.key);
    if (!Number.isFinite(f.weight) || f.weight < 0) errs.push(`Weight for "${f.label || f.key}" must be 0 or more.`);
    else sum = sum.plus(f.weight);
  }
  if (!sum.eq(100)) errs.push(`Weights must add up to 100 (currently ${sum.toString()}).`);
  for (const r of m.rules) if (!r.label) errs.push("Every rule needs a label.");
  return errs;
}

const known = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const norm = (s: string) => s.trim().toLowerCase();
const r4 = (d: Decimal) => d.toDecimalPlaces(4).toNumber();
const fmt = (n: number, dp = 2) => new Decimal(n).toDecimalPlaces(dp).toString();

/** Area on the requirement's basis; converts with efficiency when bases differ, else null (unknown, not guessed). */
function areaOnBasis(p: RatingProperty, basis: AreaBasis | null | undefined): { value: number | null; note?: string } {
  if (!known(p.areaSf)) return { value: null };
  if (!basis || !p.areaBasis || basis === p.areaBasis) {
    return { value: p.areaSf, note: !basis || !p.areaBasis ? "area basis not stated on both sides — compared as given" : undefined };
  }
  if (!known(p.efficiency) || p.efficiency <= 0) return { value: null, note: `area is ${p.areaBasis}, requirement is ${basis}; no efficiency to convert` };
  const v = p.areaBasis === "chargeable" ? new Decimal(p.areaSf).times(p.efficiency) : new Decimal(p.areaSf).div(p.efficiency);
  return { value: v.toDecimalPlaces(0).toNumber(), note: `converted ${p.areaBasis}→${basis} at ${fmt(p.efficiency * 100, 1)}% efficiency` };
}

/** Effective occupancy cost ₹/sf/month over the term (rent with escalation, less rent-free, plus CAM). Null if unknown. */
export function occupancyCost(p: RatingProperty, termMonths: number): number | null {
  if (!known(p.rent) || !known(p.cam)) return null;
  const escPct = known(p.escalationPct) ? p.escalationPct : null;
  const every = known(p.escalationEveryMonths) && p.escalationEveryMonths > 0 ? p.escalationEveryMonths : null;
  if (escPct === null || (escPct > 0 && every === null)) return null;
  if (!known(p.rentFreeMonths)) return null;
  const rent = new Decimal(p.rent); const esc = new Decimal(escPct).div(100);
  let total = new Decimal(0);
  for (let m = 1; m <= termMonths; m++) {
    const steps = every ? Math.floor((m - 1) / every) : 0;
    total = total.plus(rent.times(esc.plus(1).pow(steps)));
  }
  total = total.minus(rent.times(Math.min(p.rentFreeMonths, termMonths)));
  return r4(total.div(termMonths).plus(p.cam));
}

function ruleValue(v: RatingRule["value"], req: RatingRequirement): number | string | string[] | null {
  if (typeof v === "string" && v.startsWith("$")) {
    switch (v) {
      case "$areaMin": return known(req.areaMinSf) ? req.areaMinSf : null;
      case "$areaMax": return known(req.areaMaxSf) ? req.areaMaxSf : null;
      case "$budgetMax": return known(req.budgetMax) ? req.budgetMax : null;
      case "$microMarkets": return req.microMarkets?.length ? req.microMarkets : null;
      default: return null;
    }
  }
  return v;
}

function evalRule(rule: RatingRule, p: RatingProperty, req: RatingRequirement, ctx: { area: number | null; cost: number | null }): RuleResult {
  const target = ruleValue(rule.value, req);
  const base = { label: rule.label, kind: rule.kind };
  if (target === null) return { ...base, outcome: "pass", detail: "Requirement value not set — rule not applied" };
  const actual: unknown = rule.field === "areaSf" ? ctx.area : rule.field === "occupancyCost" ? ctx.cost : (p as unknown as Record<string, unknown>)[rule.field];
  if (actual === null || actual === undefined || actual === "") return { ...base, outcome: "unknown", detail: `${rule.field} unknown — cannot check` };
  let hit: boolean;
  const list = (Array.isArray(target) ? target : [String(target)]).map((x) => norm(String(x)));
  switch (rule.op) {
    case "gte": hit = new Decimal(Number(actual)).gte(Number(target)); break;
    case "lte": hit = new Decimal(Number(actual)).lte(Number(target)); break;
    case "eq": hit = norm(String(actual)) === norm(String(target)); break;
    case "in": hit = list.includes(norm(String(actual))); break;
    case "not_in": hit = !list.includes(norm(String(actual))); break;
  }
  const shown = `${String(actual)} vs ${Array.isArray(target) ? target.join(", ") : String(target)}`;
  // mandatory: condition must hold. disqualify: condition holding disqualifies.
  const failed = rule.kind === "mandatory" ? !hit : hit;
  return { ...base, outcome: failed ? "fail" : "pass", detail: shown };
}

function scoreFactor(f: RatingFactor, p: RatingProperty, req: RatingRequirement, area: { value: number | null; note?: string }, cost: number | null, minCost: number | null): { score: number | null; reason: string } {
  switch (f.key) {
    case "location": {
      if (!req.microMarkets?.length) return { score: null, reason: "Requirement has no preferred micro-markets" };
      if (!p.microMarket) return { score: null, reason: "Micro-market unknown" };
      const ok = req.microMarkets.map(norm).includes(norm(p.microMarket));
      return { score: ok ? 1 : 0, reason: ok ? `${p.microMarket} is a preferred micro-market` : `${p.microMarket} is outside ${req.microMarkets.join(", ")}` };
    }
    case "area": {
      const t = known(req.areaTargetSf) ? req.areaTargetSf : known(req.areaMinSf) ? req.areaMinSf : null;
      if (t === null || t <= 0) return { score: null, reason: "Requirement area unknown" };
      if (area.value === null) return { score: null, reason: area.note ?? "Property area unknown" };
      const dev = new Decimal(area.value).minus(t).abs().div(t);
      const s = Decimal.max(0, new Decimal(1).minus(dev.times(2)));
      return { score: r4(s), reason: `${fmt(area.value, 0)} sf vs ${fmt(t, 0)} sf target (${fmt(dev.times(100).toNumber(), 1)}% off)` };
    }
    case "commercial": {
      if (cost === null || minCost === null) return { score: null, reason: "Rent, CAM, escalation or rent-free unknown" };
      return { score: r4(new Decimal(minCost).div(cost)), reason: `Effective ₹${fmt(cost)}/sf/month vs best ₹${fmt(minCost)}` };
    }
    case "quality": {
      const g = p.grade ? GRADE[p.grade.trim().toUpperCase()] : undefined;
      if (g === undefined) return { score: null, reason: p.grade ? `Grade "${p.grade}" not on scale` : "Grade unknown" };
      return { score: g, reason: `Grade ${p.grade}` };
    }
    case "connectivity": {
      if (!known(p.metroKm)) return { score: null, reason: "Metro / transit distance unknown" };
      return { score: r4(Decimal.max(0, new Decimal(1).minus(new Decimal(p.metroKm).div(5)))), reason: `${fmt(p.metroKm, 1)} km to metro` };
    }
    case "amenities": {
      if (!p.amenities) return { score: null, reason: "Amenities unknown" };
      const req_ = req.requiredAmenities ?? [];
      if (req_.length) {
        const have = new Set(p.amenities.map(norm));
        const hitN = req_.filter((a) => have.has(norm(a))).length;
        return { score: r4(new Decimal(hitN).div(req_.length)), reason: `${hitN} of ${req_.length} required amenities` };
      }
      return { score: r4(Decimal.min(1, new Decimal(p.amenities.length).div(5))), reason: `${p.amenities.length} amenities listed` };
    }
    default: {
      const v = p.customScores?.[f.key];
      if (!known(v)) return { score: null, reason: `${f.label} not scored` };
      const c = Math.min(1, Math.max(0, v));
      return { score: c, reason: `Manual score ${fmt(c * 100, 0)}%` };
    }
  }
}

function daysBetween(a: string, b: string) { return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000); }

export function rateProperties(model: RatingModel, req: RatingRequirement, properties: RatingProperty[], opts: { asOf?: string } = {}): RatingResult {
  const errs = validateModel(model);
  if (errs.length) throw new RatingModelError(errs.join(" "));
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const termAssumed = !known(req.termMonths) || req.termMonths <= 0;
  const termMonths = termAssumed ? DEFAULT_TERM_MONTHS : Math.round(req.termMonths as number);

  const costs = properties.map((p) => occupancyCost(p, termMonths));
  const knownCosts = costs.filter(known);
  const minCost = knownCosts.length ? Math.min(...knownCosts) : null;
  const deposits = properties.map((p) => p.depositMonths).filter(known);
  const maxDep = deposits.length ? Math.max(...deposits) : null, minDep = deposits.length ? Math.min(...deposits) : null;

  const rated: PropertyRating[] = properties.map((p, i) => {
    const area = areaOnBasis(p, req.areaBasis);
    const cost = costs[i];
    const factors: FactorResult[] = model.factors.map((f) => {
      const { score, reason } = scoreFactor(f, p, req, area, cost, minCost);
      return { key: f.key, label: f.label, weight: f.weight, score, points: score === null ? null : r4(new Decimal(f.weight).times(score)), reason };
    });
    const knownF = factors.filter((f) => f.score !== null);
    const wKnown = knownF.reduce((s, f) => s.plus(f.weight), new Decimal(0));
    const pts = knownF.reduce((s, f) => s.plus(f.points as number), new Decimal(0));
    const score = wKnown.gt(0) ? pts.div(wKnown).times(100).toDecimalPlaces(1).toNumber() : null;
    const coverage = wKnown.div(100).toDecimalPlaces(2).toNumber();

    const rules = model.rules.map((r) => evalRule(r, p, req, { area: area.value, cost }));
    const failed = rules.filter((r) => r.outcome === "fail");
    const unknownMandatory = rules.filter((r) => r.outcome === "unknown" && r.kind === "mandatory");
    const eligibility: Eligibility = failed.length ? "not_eligible" : unknownMandatory.length ? "unconfirmed" : "eligible";

    const advantages: string[] = [], disadvantages: string[] = [], limitations: string[] = [], verification: string[] = [];
    for (const f of factors) {
      if (f.score === null) continue;
      if (f.score >= 0.8) advantages.push(`${f.label}: ${f.reason}`);
      else if (f.score <= 0.5) disadvantages.push(`${f.label}: ${f.reason}`);
    }
    for (const r of failed) disadvantages.unshift(`Fails "${r.label}" (${r.detail})`);
    if (known(p.depositMonths) && deposits.length > 1 && maxDep !== minDep) {
      if (p.depositMonths === maxDep) disadvantages.push(`Highest refundable deposit (${p.depositMonths} months) — held separately, not in cost`);
      if (p.depositMonths === minDep) advantages.push(`Lowest refundable deposit (${p.depositMonths} months)`);
    }
    if (area.note) limitations.push(`Area: ${area.note}`);
    if (p.rentBasis && req.areaBasis && p.rentBasis !== req.areaBasis) limitations.push(`Rent quoted on ${p.rentBasis} basis, requirement is ${req.areaBasis} — not like-for-like`);
    if (termAssumed && cost !== null) limitations.push(`Term assumed ${DEFAULT_TERM_MONTHS} months for cost comparison`);
    if (known(p.escalationPct) && p.escalationPct === 0) limitations.push("Escalation stated as 0% — confirm");
    const missing = factors.filter((f) => f.score === null).map((f) => `${f.label}: ${f.reason}`);
    for (const r of unknownMandatory) missing.push(`Rule "${r.label}": ${r.detail}`);
    if (!known(p.depositMonths)) missing.push("Refundable deposit unknown");

    if (p.source === "manual") verification.push("Entered manually — verify with landlord / source");
    if (p.availabilityStatus === "unverified") verification.push("Availability unverified");
    if (p.availabilityAsOf && daysBetween(p.availabilityAsOf, asOf) > STALE_AVAILABILITY_DAYS) verification.push(`Availability is old (as of ${p.availabilityAsOf})`);
    if (p.factStatus && p.factStatus !== "currently_confirmed") verification.push(`Facts are "${p.factStatus.replace(/_/g, " ")}", not currently confirmed`);
    if (p.evidence === "estimated") verification.push("Commercials are estimates, not a quote");
    if (eligibility === "unconfirmed") verification.push("Eligibility cannot be confirmed until mandatory data is known");

    return { key: p.key, name: p.name, source: p.source, evidence: p.evidence ?? null, score, coverage, occupancyCost: cost, depositMonths: known(p.depositMonths) ? p.depositMonths : null,
      factors, rules, eligibility, advantages, disadvantages, limitations, missing, verification, rank: null };
  });

  // Rank eligible first by score desc, then lower cost, then higher coverage, then name (deterministic).
  const order = [...rated].filter((r) => r.score !== null).sort((a, b) =>
    (a.eligibility === "eligible" ? 0 : 1) - (b.eligibility === "eligible" ? 0 : 1)
    || (b.score as number) - (a.score as number)
    || (a.occupancyCost ?? Infinity) - (b.occupancyCost ?? Infinity)
    || b.coverage - a.coverage || a.name.localeCompare(b.name));
  order.forEach((r, i) => { r.rank = i + 1; });

  const eligible = order.filter((r) => r.eligibility === "eligible");
  let recommendation: RatingResult["recommendation"];
  if (!eligible.length) {
    const why = rated.length ? rated.map((r) => `${r.name}: ${r.eligibility === "not_eligible" ? "not eligible" : r.eligibility === "unconfirmed" ? "eligibility unconfirmed" : "no score"}`).join("; ") : "no properties";
    recommendation = { key: null, tie: false, explanation: `No property can be recommended — ${why}.` };
  } else {
    const best = eligible[0], second = eligible[1];
    const tie = !!second && best.score === second.score;
    const top = best.factors.filter((f) => f.score !== null).sort((a, b) => (b.points as number) - (a.points as number)).slice(0, 2).map((f) => f.label.toLowerCase());
    let text = `${best.name} scores ${best.score}/100 on ${Math.round(best.coverage * 100)}% of weighted data, led by ${top.join(" and ")}.`;
    if (second && !tie) text += ` Next eligible: ${second.name} at ${second.score}.`;
    if (tie) text += ` Tied with ${second.name} at ${second.score}; ${best.name} ranks first on ${best.occupancyCost !== second.occupancyCost ? "lower effective occupancy cost" : best.coverage !== second.coverage ? "more complete data" : "name order (no material difference — review both)"}.`;
    const excluded = rated.filter((r) => r.eligibility !== "eligible" && r.score !== null && (r.score as number) > (best.score as number));
    if (excluded.length) text += ` Higher-scoring ${excluded.map((r) => r.name).join(", ")} excluded: ${excluded.map((r) => r.eligibility === "not_eligible" ? "fails a mandatory rule" : "mandatory data unknown").join(", ")}.`;
    if (best.missing.length) text += ` Still missing: ${best.missing.length} item(s).`;
    recommendation = { key: best.key, tie, explanation: text };
  }
  return { formula: RATING_FORMULA, model: { name: model.name, version: model.version ?? null }, termMonths, termAssumed, properties: rated, recommendation };
}
