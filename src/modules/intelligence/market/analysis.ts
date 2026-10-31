/**
 * Market analyst — pure analysis over gated observations (workflow 19).
 *  - Series are grouped by metric × resolved geography × UNIT × period family (annual / quarterly / monthly), so mixed units
 *    are never drawn on one axis and quarterly/monthly rows are their own series (never silently dropped).
 *  - Geography is resolved explicitly: geography_id ("mapped") or an approved alias ("alias"). A raw name that only equals a
 *    geography's name ("name_match_only") or matches nothing ("unmapped") stays separate and is flagged with a mapping
 *    proposal (raw name → geography id goes through proposeChange).
 *  - A definition change inside a series breaks comparability and is flagged.
 *  - Every series carries period, unit and sources (name + release date) so each chart can show them.
 */
import { gateObservations, metricKind, periodFamily, seriesTrend, type Observation, type PeriodFamily, type TrendPoint, type Superseded } from "./series";

export interface GeoInfo { id: string; name: string; aliases: string[] }
export type GeoStatus = "mapped" | "alias" | "name_match_only" | "unmapped" | "unspecified";
export interface ResolvedGeo { key: string; label: string; status: GeoStatus; geography_id: string | null; raw: string | null; suggestion: { id: string; name: string } | null }

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export function resolveGeography(o: Pick<Observation, "geography_id" | "geography_raw">, geos: GeoInfo[]): ResolvedGeo {
  if (o.geography_id) {
    const g = geos.find((x) => x.id === o.geography_id);
    return { key: o.geography_id, label: g?.name ?? o.geography_raw ?? o.geography_id, status: "mapped", geography_id: o.geography_id, raw: o.geography_raw, suggestion: null };
  }
  const raw = o.geography_raw?.trim() || null;
  if (!raw) return { key: "raw:unspecified", label: "Unspecified geography", status: "unspecified", geography_id: null, raw: null, suggestion: null };
  const alias = geos.find((g) => g.aliases.some((a) => norm(a) === norm(raw)));
  if (alias) return { key: alias.id, label: alias.name, status: "alias", geography_id: alias.id, raw, suggestion: null };
  const byName = geos.find((g) => norm(g.name) === norm(raw));
  if (byName) return { key: `raw:${norm(raw)}`, label: raw, status: "name_match_only", geography_id: null, raw, suggestion: { id: byName.id, name: byName.name } };
  const loose = geos.find((g) => norm(raw).includes(norm(g.name)) || norm(g.name).includes(norm(raw)));
  return { key: `raw:${norm(raw)}`, label: raw, status: "unmapped", geography_id: null, raw, suggestion: loose ? { id: loose.id, name: loose.name } : null };
}

export interface SourceRef { key: string; name: string; release_date: string | null; source_object_id: string | null; licensed: boolean }
export interface SourceInfo { name: string; licensed: boolean }

export interface SeriesView {
  key: string;
  metric: string; kind: string;
  geography: string; geographyLabel: string; geographyStatus: GeoStatus; geographyRaw: string | null; geographySuggestion: { id: string; name: string } | null;
  unit: string; family: PeriodFamily; periodLabel: string;
  definitions: string[];
  points: TrendPoint[];
  sources: SourceRef[];
  sampleSize: number;
  hasForecast: boolean;
  flags: string[];
}

export interface AnalysisFlag { kind: "definition_change" | "geography_unmapped" | "geography_name_only" | "mixed_units" | "revision" | "excluded" | "forecast_present" | "multiple_period_families"; severity: "info" | "warn"; series: string | null; detail: string }

export interface MarketAnalysis {
  series: SeriesView[];
  excluded: { id: string; metric: string; reason: string }[];
  flags: AnalysisFlag[];
  hasForecast: boolean;
  total: number;
}

const FAMILY_LABEL: Record<PeriodFamily, string> = { annual: "annual", quarter: "quarterly", month: "monthly" };

export function sourceKey(o: { source_object_id: string | null; source_version: string | null }): string {
  return o.source_object_id ?? `v:${o.source_version ?? "unknown"}`;
}

export function analyseMarket(observations: Observation[], geos: GeoInfo[], sources: Map<string, SourceInfo> = new Map()): MarketAnalysis {
  const gate = gateObservations(observations);
  const excluded: MarketAnalysis["excluded"] = [...gate.excluded];
  const groups = new Map<string, { metric: string; geo: ResolvedGeo; unit: string; family: PeriodFamily; rows: Observation[] }>();
  for (const o of gate.accepted) {
    const geo = resolveGeography(o, geos);
    const fam = periodFamily(o.period_type);
    const unit = String(o.unit).trim();
    const key = `${o.metric}|${geo.key}|${unit}|${fam}`;
    const g = groups.get(key) ?? { metric: o.metric, geo, unit, family: fam, rows: [] };
    g.rows.push(o);
    groups.set(key, g);
  }
  const flags: AnalysisFlag[] = [];
  const series: SeriesView[] = [];
  for (const [key, g] of groups) {
    const { points, superseded } = seriesTrend(g.rows, g.family);
    for (const s of superseded) excluded.push(supersededRow(s));
    const used = points.filter((p) => p.value !== null);
    const srcMap = new Map<string, SourceRef>();
    for (const p of used) {
      const sk = sourceKey({ source_object_id: p.source_object_id ?? null, source_version: p.source_version ?? null });
      const info = sources.get(sk);
      const k2 = `${sk}@${p.release_date ?? ""}`;
      if (!srcMap.has(k2)) srcMap.set(k2, { key: sk, name: info?.name ?? p.source_version ?? "source on file", release_date: p.release_date, source_object_id: p.source_object_id ?? null, licensed: !!info?.licensed });
    }
    const defs = [...new Set(g.rows.map((r) => (r.definition ?? "").trim()).filter(Boolean))];
    const label = `${g.metric.replace(/_/g, " ")} · ${g.geo.label} · ${g.unit} · ${FAMILY_LABEL[g.family]}`;
    const sflags: string[] = [];
    if (new Set(used.map((p) => norm(p.definition))).size > 1) {
      sflags.push("Definition changes within this series — periods across the change are not compared.");
      flags.push({ kind: "definition_change", severity: "warn", series: label, detail: `Definitions used: ${defs.map((d) => `“${d}”`).join(" / ")}` });
    }
    if (g.geo.status === "name_match_only") {
      sflags.push(`Geography matched only by raw name “${g.geo.raw}” — kept separate from “${g.geo.suggestion?.name}” until a mapping is approved.`);
      flags.push({ kind: "geography_name_only", severity: "warn", series: label, detail: `Raw “${g.geo.raw}” equals geography “${g.geo.suggestion?.name}” by name only; propose a mapping.` });
    } else if (g.geo.status === "unmapped" || g.geo.status === "unspecified") {
      sflags.push(g.geo.status === "unspecified" ? "No geography on these observations." : `Geography “${g.geo.raw}” is not mapped to a known geography.`);
      flags.push({ kind: "geography_unmapped", severity: "warn", series: label, detail: g.geo.status === "unspecified" ? "Observations without geography." : `Raw geography “${g.geo.raw}” unmapped${g.geo.suggestion ? ` (closest: ${g.geo.suggestion.name})` : ""}.` });
    }
    const revisions = superseded.filter((s) => /revised/.test(s.reason));
    if (revisions.length) flags.push({ kind: "revision", severity: "info", series: label, detail: revisions.map((r) => r.reason).join("; ") });
    const hasForecast = used.some((p) => p.is_forecast);
    if (hasForecast) sflags.push("Includes the source's forecast figures (labelled).");
    const labelled = used.map((p) => p.label);
    series.push({
      key, metric: g.metric, kind: metricKind(g.metric),
      geography: g.geo.key, geographyLabel: g.geo.label, geographyStatus: g.geo.status, geographyRaw: g.geo.raw, geographySuggestion: g.geo.suggestion,
      unit: g.unit, family: g.family,
      periodLabel: labelled.length ? `${labelled[0]} – ${labelled[labelled.length - 1]} (${FAMILY_LABEL[g.family]})` : FAMILY_LABEL[g.family],
      definitions: defs, points, sources: [...srcMap.values()].sort((a, b) => (a.release_date ?? "").localeCompare(b.release_date ?? "")),
      sampleSize: used.length, hasForecast, flags: sflags,
    });
  }
  // same metric + geography in different units => separate charts, flagged (never one axis)
  const byMG = new Map<string, Set<string>>();
  for (const s of series) { const k = `${s.metric}|${s.geography}`; byMG.set(k, (byMG.get(k) ?? new Set()).add(s.unit)); }
  for (const [k, units] of byMG) if (units.size > 1) {
    const [metric] = k.split("|");
    const geo = series.find((s) => `${s.metric}|${s.geography}` === k)!.geographyLabel;
    flags.push({ kind: "mixed_units", severity: "warn", series: `${metric.replace(/_/g, " ")} · ${geo}`, detail: `Reported in ${[...units].join(" and ")} — shown as separate charts, never on one axis.` });
    for (const s of series) if (`${s.metric}|${s.geography}` === k) s.flags.push(`Also reported in ${[...units].filter((u) => u !== s.unit).join(", ")} — see the separate chart; not converted.`);
  }
  const byMGF = new Map<string, Set<PeriodFamily>>();
  for (const s of series) { const k = `${s.metric}|${s.geography}|${s.unit}`; byMGF.set(k, (byMGF.get(k) ?? new Set()).add(s.family)); }
  for (const [k, fams] of byMGF) if (fams.size > 1) flags.push({ kind: "multiple_period_families", severity: "info", series: k.split("|")[0].replace(/_/g, " "), detail: `Published as ${[...fams].map((f) => FAMILY_LABEL[f]).join(" and ")} figures — shown as separate series; quarters/months are not added up into years.` });
  if (gate.excluded.length) flags.push({ kind: "excluded", severity: "warn", series: null, detail: `${gate.excluded.length} observation(s) failed the definition/date/source/unit gate.` });
  const hasForecast = series.some((s) => s.hasForecast);
  if (hasForecast) flags.push({ kind: "forecast_present", severity: "info", series: null, detail: "Some releases include forecast figures; they are labelled as forecasts and never compared with actuals." });
  series.sort((a, b) => a.metric.localeCompare(b.metric) || a.geographyLabel.localeCompare(b.geographyLabel) || a.family.localeCompare(b.family) || a.unit.localeCompare(b.unit));
  return { series, excluded, flags, hasForecast, total: observations.length };
}

function supersededRow(s: Superseded) { return { id: s.id, metric: s.metric, reason: s.reason }; }

/** Caveats that are ALWAYS shown with a note or chart set (sample size + not comprehensive + forecast honesty). */
export function caveatsFor(s: Pick<SeriesView, "sampleSize" | "sources" | "hasForecast" | "flags">): string[] {
  const c = [
    `Sample: ${s.sampleSize} observation(s) from ${new Set(s.sources.map((x) => `${x.key}@${x.release_date}`)).size} source release(s) imported into CRE OS.`,
    "Not comprehensive: only the releases imported here are used; other sources may report different figures or definitions.",
    s.hasForecast ? "Points marked forecast are the source's own forecasts, not CRE OS predictions." : "Descriptive only — not a forecast.",
  ];
  return [...c, ...s.flags];
}
