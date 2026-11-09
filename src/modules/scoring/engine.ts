/**
 * Scoring Engine core — PURE and deterministic (no DB, no AI). Same inputs + same model version = same score.
 *
 *   score = round( Σ weight_i × value_i  /  Σ weight_i (counted factors) × 100 )      value_i ∈ [0,1]
 *
 * Unknown-data policy per factor:  "exclude" — drop from numerator AND denominator (unknown is not negative),
 *                                  "neutral" — counts as 0.5, "zero" — counts as 0.
 * Completeness = known weight / total weight. Mandatory failures and disqualifiers are checked separately and
 * cap the result (they are never "outweighed" by good factors).
 */
export type ModelKey = "company" | "lead" | "contact" | "requirement" | "opportunity" | "relationship";
export type Unknown = "exclude" | "neutral" | "zero";
export interface FactorDef { key: string; label: string; weight: number; unknown: Unknown; description: string }
export interface Band { min: number; label: string }
export interface ModelVersion { factors: FactorDef[]; bands: Band[]; config: Record<string, unknown> }

export interface Evidence { type: string; id?: string; label: string; url?: string | null; date?: string | null; tier?: string | null }
export interface FeatureValue { value: number | null; explanation: string; evidence?: Evidence[] }
export interface Features {
  values: Record<string, FeatureValue>;
  mandatoryFailed?: string[];      // fails a must-have: score capped at 0, band "Disqualified"
  missing?: string[];
  extra?: Record<string, unknown>;
  recommended?: string;
}
export interface FactorResult { key: string; label: string; weight: number; value: number | null; known: boolean; points: number; max: number; explanation: string; evidence: Evidence[] }
export interface ScoreOutput {
  score: number; band: string; disqualified: boolean; confidence: "high" | "medium" | "low" | "insufficient"; completeness: number;
  factors: FactorResult[]; missing: string[]; extra: Record<string, unknown>; recommended: string | null;
}

export class ModelError extends Error {}

/** Validates a version before it can be saved or activated. */
export function validateVersion(v: ModelVersion): string[] {
  const e: string[] = [];
  if (!v.factors.length) e.push("At least one factor is required.");
  const keys = new Set<string>();
  for (const f of v.factors) {
    if (!f.key || keys.has(f.key)) e.push(`Factor key "${f.key}" is missing or duplicated.`);
    keys.add(f.key);
    if (!Number.isFinite(f.weight) || f.weight < 0 || f.weight > 100) e.push(`Weight for ${f.label} must be between 0 and 100.`);
    if (!["exclude", "neutral", "zero"].includes(f.unknown)) e.push(`Unknown policy for ${f.label} is invalid.`);
  }
  const total = v.factors.reduce((a, f) => a + (Number.isFinite(f.weight) ? f.weight : 0), 0);
  if (total <= 0) e.push("Weights must add up to more than 0.");
  const mins = v.bands.map((b) => b.min);
  if (!v.bands.length) e.push("At least one priority band is required.");
  if (mins.some((m) => !Number.isFinite(m) || m < 0 || m > 100)) e.push("Band thresholds must be between 0 and 100.");
  if (new Set(mins).size !== mins.length) e.push("Band thresholds must be different.");
  if (v.bands.length && !mins.includes(0)) e.push("One band must start at 0 so every score has a label.");
  return e;
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function bandFor(score: number, bands: Band[]): string {
  return [...bands].sort((a, b) => b.min - a.min).find((b) => score >= b.min)?.label ?? "Unrated";
}

const TIER_RANK: Record<string, number> = { documentary_current: 4, currently_confirmed: 4, credible_reported: 3, corroborated_public: 3, records: 3, single_unverified: 2, reported: 2, inference: 1, ai_inference: 1 };

export function compute(v: ModelVersion, f: Features): ScoreOutput {
  const errs = validateVersion(v);
  if (errs.length) throw new ModelError(errs.join(" "));
  const totalW = v.factors.reduce((a, x) => a + x.weight, 0);
  let num = 0, den = 0, knownW = 0;
  const rows: FactorResult[] = v.factors.map((d) => {
    const fv = f.values[d.key];
    const known = fv?.value !== null && fv?.value !== undefined && Number.isFinite(fv.value);
    let value: number | null = known ? clamp01(fv!.value as number) : null;
    if (known) knownW += d.weight;
    let counted = true;
    if (!known) {
      if (d.unknown === "exclude") counted = false;
      else value = d.unknown === "neutral" ? 0.5 : 0;
    }
    if (counted) { num += d.weight * (value as number); den += d.weight; }
    const max = Math.round((d.weight / totalW) * 100);
    return { key: d.key, label: d.label, weight: d.weight, value: known ? value : null, known, points: counted ? Math.round((d.weight / totalW) * 100 * (value as number)) : 0, max,
      explanation: fv?.explanation ?? "No data.", evidence: fv?.evidence ?? [] };
  });
  const raw = den > 0 ? (num / den) * 100 : 0;
  const disqualified = !!f.mandatoryFailed?.length;
  const score = disqualified ? 0 : Math.round(raw);
  const completeness = Math.round((knownW / totalW) * 100);
  // Confidence = how much is known AND how strong the evidence behind it is.
  const ev = rows.flatMap((r) => r.evidence);
  const best = Math.max(0, ...ev.map((e) => TIER_RANK[e.tier ?? ""] ?? 2));
  const confidence = completeness < 25 || den === 0 ? "insufficient" : completeness >= 70 && best >= 3 ? "high" : completeness >= 45 && best >= 2 ? "medium" : "low";
  return {
    score, band: disqualified ? "Disqualified" : bandFor(score, v.bands), disqualified, confidence, completeness, factors: rows,
    missing: [...new Set([...(f.missing ?? []), ...(f.mandatoryFailed ?? []).map((m) => `Fails: ${m}`)])],
    extra: f.extra ?? {}, recommended: f.recommended ?? null,
  };
}

/** Stable hash of the inputs, so an unchanged record is not re-scored or re-stored. */
export function inputsHash(versionId: string, f: Features): string {
  const s = JSON.stringify([versionId, Object.entries(f.values).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, x.value, x.explanation]), f.mandatoryFailed ?? []]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
