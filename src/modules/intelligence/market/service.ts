import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured, AiUnavailableError } from "@/lib/ai/gateway";
import { getAiMode, type AiMode } from "@/lib/ai/policy";
import { proposeChange } from "@/lib/services/changes";
import { notify } from "@/modules/brief/db";
import type { AiCall } from "../common";
import { comparables, factsFromTrend, supplyAbsorptionRatio, deriveVacancy, marketDisclaimer, type Observation, type TxLite, type CompsQuery } from "./series";
import { analyseMarket, caveatsFor, sourceKey, type GeoInfo, type SourceInfo, type SeriesView, type AnalysisFlag } from "./analysis";

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

/** Licensed source permits public/marketing use when one of its allowed purposes says so (explicit opt-in only). */
export function permitsPublication(allowedPurposes: unknown): boolean {
  return Array.isArray(allowedPurposes) && allowedPurposes.some((p) => typeof p === "string" && /publi|marketing|external/i.test(p));
}

export interface LoadedMarket {
  observations: Observation[];
  geos: GeoInfo[];
  sources: Map<string, SourceInfo & { licensed_source_id: string | null; licensed_name: string | null; permits_publication: boolean; permits_ai: boolean }>;
}

export async function loadObservations(db: Db, workspaceId: string): Promise<LoadedMarket & { geoNames: Map<string, string> }> {
  const { data, error } = await db.from("market_observation")
    .select("id, metric, geography_id, geography_raw, period_start, period_end, period_type, unit, value, definition, release_date, source_object_id, source_version")
    .eq("workspace_id", workspaceId).is("archived_at", null).order("period_start").limit(5000);
  if (error) throw error;
  const observations = ((data ?? []) as Row[]).map((o) => ({ ...(o as unknown as Observation), value: num(o.value) }));
  const { data: g } = await db.from("geography").select("id, name, aliases").eq("workspace_id", workspaceId).is("archived_at", null).limit(5000);
  const geos: GeoInfo[] = ((g ?? []) as Row[]).map((r) => ({ id: String(r.id), name: String(r.name), aliases: Array.isArray(r.aliases) ? (r.aliases as string[]) : [] }));
  const geoNames = new Map(geos.map((x) => [x.id, x.name]));
  const soIds = [...new Set(observations.map((o) => o.source_object_id).filter((x): x is string => !!x))];
  const sources: LoadedMarket["sources"] = new Map();
  if (soIds.length) {
    const { data: so } = await db.from("source_object").select("id, file_name, uri, licensed_source_id").eq("workspace_id", workspaceId).in("id", soIds);
    const lsIds = [...new Set(((so ?? []) as Row[]).map((r) => r.licensed_source_id).filter(Boolean) as string[])];
    const { data: ls } = lsIds.length ? await db.from("licensed_source").select("id, name, allowed_purposes, permits_ai_processing").eq("workspace_id", workspaceId).in("id", lsIds) : { data: [] };
    const lsBy = new Map(((ls ?? []) as Row[]).map((r) => [String(r.id), r]));
    for (const r of (so ?? []) as Row[]) {
      const l = r.licensed_source_id ? lsBy.get(String(r.licensed_source_id)) : undefined;
      sources.set(String(r.id), {
        name: l ? `${String(l.name)} — ${String(r.file_name ?? "file")}` : String(r.file_name ?? r.uri ?? "uploaded file"),
        licensed: !!r.licensed_source_id, licensed_source_id: (r.licensed_source_id as string | null) ?? null, licensed_name: l ? String(l.name) : null,
        permits_publication: l ? permitsPublication(l.allowed_purposes) : !r.licensed_source_id, permits_ai: l ? !!l.permits_ai_processing : true,
      });
    }
  }
  for (const o of observations) if (!o.source_object_id && o.source_version) {
    const k = sourceKey(o);
    if (!sources.has(k)) sources.set(k, { name: o.source_version, licensed: false, licensed_source_id: null, licensed_name: null, permits_publication: true, permits_ai: true });
  }
  return { observations, geos, sources, geoNames };
}

export type { SeriesView };

/**
 * Gated series (metric × geography × unit × period family) with period/unit/source per chart, excluded and superseded
 * observations with reasons (shown, never hidden), inconsistency flags and supply/absorption ratios on matched series only.
 */
export async function marketOverview(db: Db, workspaceId: string) {
  const loaded = await loadObservations(db, workspaceId);
  const a = analyseMarket(loaded.observations, loaded.geos, loaded.sources);
  const ratios = a.series.filter((s) => /supply/i.test(s.metric) && s.family === "annual").map((s) => {
    const abs = a.series.find((x) => /absorption/i.test(x.metric) && x.geography === s.geography && x.family === "annual" && x.unit === s.unit);
    return abs ? { geography: s.geographyLabel, unit: s.unit, rows: supplyAbsorptionRatio(s.points, abs.points), sources: [...s.sources, ...abs.sources] } : null;
  }).filter(Boolean) as { geography: string; unit: string; rows: ReturnType<typeof supplyAbsorptionRatio>; sources: SeriesView["sources"] }[];
  const hasVacancy = a.series.some((s) => /vacancy|available_inventory/i.test(s.metric));
  const vacancy = hasVacancy ? null : deriveVacancy({});
  return { series: a.series, excluded: a.excluded, flags: a.flags, ratios, vacancyNote: vacancy?.reason ?? null, disclaimer: marketDisclaimer(a.hasForecast), hasForecast: a.hasForecast, total: a.total, sources: loaded.sources, geos: loaded.geos };
}

/** Raw geography name → geography id: proposed as an approved alias on the geography (S4: goes through proposeChange). */
export const GeoMappingInput = z.object({ raw: z.string().min(1).max(200), geographyId: z.string().uuid() });
export async function proposeGeographyMapping(db: Db, workspaceId: string, raw: z.input<typeof GeoMappingInput>, userId: string) {
  const i = GeoMappingInput.parse(raw);
  const { data: g, error } = await db.from("geography").select("id, name, aliases, row_version").eq("workspace_id", workspaceId).eq("id", i.geographyId).maybeSingle();
  if (error) throw error;
  if (!g) throw new Error("Geography not found or not visible.");
  const aliases = Array.isArray(g.aliases) ? (g.aliases as string[]) : [];
  if (aliases.some((a) => a.trim().toLowerCase() === i.raw.trim().toLowerCase())) return { status: "already_mapped" as const, proposal: null };
  const proposal = await proposeChange(db, workspaceId, {
    targetType: "geography", targetId: g.id, operation: "update", expectedVersion: Number(g.row_version),
    patch: [{ op: "replace", path: "/aliases", value: [...aliases, i.raw.trim()] }],
    reason: `Market analyst: map raw geography “${i.raw.trim()}” in market releases to “${g.name}”. Once approved, those observations join the ${g.name} series.`,
    idempotencyKey: `market.geomap:${g.id}:${i.raw.trim().toLowerCase()}`, ownerUserId: userId, proposedByKind: "user",
  });
  return { status: "proposed" as const, proposal };
}

export async function pendingGeographyMappings(db: Db, workspaceId: string): Promise<string[]> {
  const { data } = await db.from("change_proposal").select("idempotency_key").eq("workspace_id", workspaceId).eq("target_type", "geography").eq("state", "proposed").like("idempotency_key", "market.geomap:%").limit(200);
  return ((data ?? []) as Row[]).map((r) => String(r.idempotency_key).split(":").slice(2).join(":"));
}

// ------------------------------------------------------------------ analysis runs (job + manual)
export interface AnalysisRunInput { trigger: "release" | "scheduled" | "manual"; triggerKey?: string | null; ownerUserId?: string | null }

/**
 * Refresh trends and flag inconsistencies. Writes one market_analysis row (deduped per trigger key) and an in-app notice to
 * the importing user when warnings exist. Callers using the service role must pass the workspace explicitly (done here).
 */
export async function runMarketAnalysis(db: Db, workspaceId: string, input: AnalysisRunInput) {
  if (input.triggerKey) {
    const { data: prior } = await db.from("market_analysis").select("*").eq("workspace_id", workspaceId).eq("trigger_key", input.triggerKey).maybeSingle();
    if (prior) return { analysis: prior, duplicate: true };
  }
  const loaded = await loadObservations(db, workspaceId);
  const a = analyseMarket(loaded.observations, loaded.geos, loaded.sources);
  let owner = input.ownerUserId ?? null;
  if (!owner) {
    const { data: m } = await db.from("membership").select("user_id").eq("workspace_id", workspaceId).eq("role", "owner").limit(1).maybeSingle();
    owner = (m?.user_id as string | undefined) ?? null;
  }
  const summary = Object.fromEntries(a.series.map((s) => {
    const last = [...s.points].reverse().find((p) => p.value !== null);
    return [s.key, { label: `${s.metric} · ${s.geographyLabel} · ${s.unit} · ${s.family}`, latest: last ? { period: last.label, value: last.value, release_date: last.release_date, forecast: last.is_forecast } : null, sample: s.sampleSize, sources: s.sources.map((x) => `${x.name} (${x.release_date ?? "undated"})`) }];
  }));
  const sources = [...new Map(a.series.flatMap((s) => s.sources).map((x) => [`${x.key}@${x.release_date}`, x])).values()];
  const { data, error } = await db.from("market_analysis").insert({
    workspace_id: workspaceId, owner_user_id: owner ?? undefined, trigger_kind: input.trigger, trigger_key: input.triggerKey ?? null,
    observation_count: a.total, series_count: a.series.length, excluded_count: a.excluded.length, sources, flags: a.flags, summary,
  }).select().single();
  if (error) throw error;
  const warns = a.flags.filter((f) => f.severity === "warn");
  if (warns.length && owner) {
    await notify(db, workspaceId, owner, "market.analysis", `market.analysis:${data.id}`, {
      title: `Market data check: ${warns.length} issue(s) to review`, reason: warns.slice(0, 5).map((f) => `${f.series ? `${f.series}: ` : ""}${f.detail}`).join("\n"), href: "/market",
    });
  }
  return { analysis: data, duplicate: false };
}

export async function latestAnalysis(db: Db, workspaceId: string) {
  const { data } = await db.from("market_analysis").select("id, trigger_kind, ran_at, observation_count, series_count, excluded_count, flags").eq("workspace_id", workspaceId).is("archived_at", null).order("ran_at", { ascending: false }).limit(1).maybeSingle();
  return data as (Row & { flags: AnalysisFlag[] }) | null;
}

/**
 * Locality of a transaction for comparables: the linked building's locality, else the locality label recorded on the
 * source row (imports keep it in extras.locality_raw). Tracker rows link to a building only on an exact name|locality
 * key, so without the fallback most real deals had no locality (Pune 2022/2023 trackers: 2 of 40 Kharadi deals matched).
 */
export function txLocality(assetLocality: string | null, extras: unknown): string | null {
  if (assetLocality) return assetLocality;
  const raw = extras && typeof extras === "object" ? (extras as Record<string, unknown>).locality_raw : null;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export async function marketComparables(db: Db, workspaceId: string, q: CompsQuery) {
  const { data, error } = await db.from("market_transaction")
    .select("id, asset_id, tenant_org_id, tenant_name_raw, period_start, deal_type, area_sf, rent_min, rent_max, rent_basis, source_object_id, extras")
    .eq("workspace_id", workspaceId).is("archived_at", null).order("period_start", { ascending: false, nullsFirst: false }).limit(2000);
  if (error) throw error;
  const txs = (data ?? []) as Row[];
  const assetIds = [...new Set(txs.map((t) => t.asset_id).filter(Boolean) as string[])];
  const assets = assetIds.length ? (((await db.from("asset").select("id, name, locality_id").eq("workspace_id", workspaceId).in("id", assetIds)).data ?? []) as Row[]) : [];
  const locIds = [...new Set(assets.map((a) => a.locality_id).filter(Boolean) as string[])];
  const locs = locIds.length ? (((await db.from("geography").select("id, name").eq("workspace_id", workspaceId).in("id", locIds)).data ?? []) as Row[]) : [];
  const locName = new Map(locs.map((l) => [String(l.id), String(l.name)]));
  const assetBy = new Map(assets.map((a) => [String(a.id), { name: String(a.name), locality: a.locality_id ? locName.get(String(a.locality_id)) ?? null : null }]));
  const lite: TxLite[] = txs.map((t) => ({
    id: String(t.id), asset_id: t.asset_id as string | null, asset_name: t.asset_id ? assetBy.get(String(t.asset_id))?.name ?? null : null,
    locality: txLocality(t.asset_id ? assetBy.get(String(t.asset_id))?.locality ?? null : null, t.extras), period_start: t.period_start as string | null, deal_type: t.deal_type as string | null,
    area_sf: num(t.area_sf), rent_min: num(t.rent_min), rent_max: num(t.rent_max), rent_basis: t.rent_basis as string | null, tenant: (t.tenant_name_raw as string | null) ?? null, source_object_id: t.source_object_id as string | null,
  }));
  return { ...comparables(lite, q), localities: [...new Set(lite.map((t) => t.locality).filter(Boolean) as string[])].sort() };
}

// ------------------------------------------------------------------ market notes
export const MarketNoteInput = z.object({
  metric: z.string().min(1).max(80),
  geography: z.string().min(1).max(200),
  /** Exact series (metric|geography|unit|family) when the metric/geography pair has several units or period families. */
  seriesKey: z.string().max(400).optional().nullable(),
  title: z.string().min(2).max(200).optional().nullable(),
  audience: z.string().max(80).optional().nullable(),
});

const Commentary = z.object({ commentary: z.string().max(2000) });

/**
 * Draft a market note: facts are computed deterministically from GATED observations and each names its period, unit,
 * source and release date; sample size and "not comprehensive" caveats are always included. The commentary is AI-drafted
 * (or a deterministic template in mock / budget mode), labelled, descriptive only. Draft status — never published automatically.
 */
export async function draftMarketNote(db: Db, workspaceId: string, raw: z.input<typeof MarketNoteInput>, opts: { userId: string; ai?: AiCall; mode?: AiMode }) {
  const input = MarketNoteInput.parse(raw);
  const overview = await marketOverview(db, workspaceId);
  const candidates = input.seriesKey ? overview.series.filter((x) => x.key === input.seriesKey)
    : overview.series.filter((x) => x.metric === input.metric && (x.geography === input.geography || x.geographyLabel === input.geography));
  if (!candidates.length) throw new Error("No gated observations for that metric and geography.");
  if (candidates.length > 1) throw new Error(`Several series match (${candidates.map((c) => `${c.unit}, ${c.family}`).join("; ")}) — choose one series; units and period types are never mixed.`);
  const s = candidates[0];
  const srcInfo = (p: { source_object_id?: string | null; source_version?: string | null }) => overview.sources.get(sourceKey({ source_object_id: p.source_object_id ?? null, source_version: p.source_version ?? null }));
  const facts = factsFromTrend(s.metric, s.geographyLabel, s.points, (p) => srcInfo(p)?.name ?? p.source_version ?? "source on file");
  const gaps = s.points.filter((p) => p.value === null).map((p) => p.label);
  const notComparable = s.points.filter((p) => p.comparable_to_previous === false).map((p) => p.note ?? p.label);
  const caveats = caveatsFor(s);
  const known = s.points.filter((p) => p.value !== null && Number.isFinite(Number(p.value)) && p.comparable_to_previous !== false);
  const first = known[0], latest = known[known.length - 1];
  const dir = first && latest && first !== latest ? (Number(latest.value) > Number(first.value) ? "higher than" : Number(latest.value) < Number(first.value) ? "lower than" : "the same as") : null;
  const peak = known.length > 2 ? known.reduce((a, b) => (Number(b.value) > Number(a.value) ? b : a)) : null;
  const mock = () => ({
    commentary: [
      `This note describes ${s.metric.replace(/_/g, " ")} for ${s.geographyLabel} (${s.unit}, ${s.periodLabel}) from validated releases only.`,
      latest ? `The latest recorded figure is ${latest.value} ${s.unit} for ${latest.label}${dir ? `, ${dir} the ${first.value} ${s.unit} recorded for ${first.label}` : ""}.` : "",
      peak && peak !== latest ? `The highest figure in this series was ${peak.value} ${s.unit} (${peak.label}).` : "",
      gaps.length ? `No observation exists for ${gaps.join(", ")}; those periods are unknown, not zero.` : "",
      notComparable.length ? `Some periods are not directly comparable: ${notComparable.join(" ")}` : "",
      s.kind === "stock" ? "Stock is a point-in-time snapshot and is not added across years." : "",
      s.hasForecast ? "Figures marked forecast are the source's own forecasts; CRE OS does not forecast." : "This is not a forecast.",
    ].filter(Boolean).join(" "),
  });
  let commentary = mock().commentary;
  const forecastWord = s.hasForecast ? "descriptive only; forecast points are the source's, labelled as forecasts" : "descriptive only, not a forecast";
  let label = `Commentary from the recorded figures — ${forecastWord}. Verify before sharing.`;
  const mode = opts.mode ?? await getAiMode(db, workspaceId, "market.note");
  const sourceRows = s.sources.map((x) => { const i = overview.sources.get(x.key); return { source_object_id: x.source_object_id, name: x.name, release_date: x.release_date, licensed_source_id: i?.licensed_source_id ?? null, licensed_name: i?.licensed_name ?? null, permits_publication: i?.permits_publication ?? true }; });
  const licensedIds = [...new Set(sourceRows.map((r) => r.licensed_source_id).filter((x): x is string => !!x))];
  if (mode !== "off") try {
    const res = await (opts.ai ?? (callStructured as AiCall))({
      workspaceId, workflow: "market.note", tier: "luna",
      system: "You write short, descriptive commentary on Pune office market data for a CRE adviser. Use ONLY the facts given; do not compute new numbers, do not forecast, label any source forecast as a forecast, do not infer vacancy from absorption, do not sum stock across years. State gaps as unknown. Do not imply the data is comprehensive.",
      input: `Metric: ${s.metric}\nGeography: ${s.geographyLabel}\nUnit: ${s.unit}\nPeriod: ${s.periodLabel}\nKind: ${s.kind}\nUnknown periods: ${gaps.join(", ") || "none"}\nNot comparable: ${notComparable.join(" ") || "none"}`,
      evidence: facts.map((f) => f.text).join("\n"), schema: Commentary, schemaName: "market_commentary", maxOutputTokens: 600, mock,
      classification: licensedIds.length ? "licensed_restricted" : undefined, licensedSourceIds: licensedIds.length ? licensedIds : undefined,
    });
    commentary = res.data.commentary;
    if (!res.mocked) label = `AI-drafted commentary — ${forecastWord}. Verify before sharing.`;
  } catch (e) {
    if (!(e instanceof AiUnavailableError)) throw e;
    if (e.reason !== "ai_disabled") label = `Template commentary (AI unavailable: ${e.reason}) — ${forecastWord}.`;
  }
  const sourcesLine = `Sources: ${s.sources.map((x) => `${x.name} (released ${x.release_date ?? "date unknown"})`).join("; ")}.`;
  const body = [...facts.map((f) => `• ${f.text}`), "", commentary, "", sourcesLine, ...caveats.map((c) => `Note: ${c}`), "", marketDisclaimer(s.hasForecast)].join("\n");
  const { data, error } = await db.from("market_note").insert({
    workspace_id: workspaceId, title: input.title ?? `${s.metric.replace(/_/g, " ")} — ${s.geographyLabel} (${s.unit})`, geography_raw: s.geographyLabel, metric: s.metric,
    period_label: s.periodLabel, body, facts, commentary, commentary_label: label, unit: s.unit,
    sources: sourceRows, sample_size: s.sampleSize, caveats, has_forecast: s.hasForecast,
    audience: input.audience ?? null, status: "draft", owner_user_id: opts.userId,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function setMarketNoteStatus(db: Db, workspaceId: string, id: string, status: "draft" | "in_review" | "approved" | "published_manually" | "discarded", confidentialityChecked?: boolean, opts: { userId?: string | null } = {}) {
  const patch: Row = { status };
  if (confidentialityChecked !== undefined) patch.confidentiality_checked = confidentialityChecked;
  if ((status === "approved" || status === "published_manually")) {
    const { data: cur } = await db.from("market_note").select("confidentiality_checked").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
    if (!cur) throw new Error("not found");
    if (!cur.confidentiality_checked && !confidentialityChecked) throw new Error("Confirm the confidentiality check before approving.");
  }
  const { data, error } = await db.from("market_note").update(patch).eq("workspace_id", workspaceId).eq("id", id).select().single();
  if (error) throw error;
  if (status === "approved" && opts.userId) {
    // Trigger for the content editor: approved public facts are available => one linked content idea (deduped per note).
    const { ideaFromApprovedNote } = await import("../content/service");
    await ideaFromApprovedNote(db, workspaceId, id, opts.userId);
  }
  return data;
}

export async function listMarketNotes(db: Db, workspaceId: string) {
  const { data, error } = await db.from("market_note").select("id, title, metric, geography_raw, period_label, status, commentary_label, confidentiality_checked, created_at, body, sources, sample_size, caveats, has_forecast, unit").eq("workspace_id", workspaceId).is("archived_at", null).order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []) as Row[];
}
