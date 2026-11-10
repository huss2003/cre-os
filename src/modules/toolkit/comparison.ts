import "server-only";
import type { Db } from "@/lib/supabase/server";
import { saveAnalysis } from "./store";
import { DEFAULT_MODEL, RATING_FORMULA, rateProperties, validateModel, type AreaBasis, type RatingFactor, type RatingModel, type RatingProperty, type RatingRequirement, type RatingRule } from "./calc/rating";

/** Property Comparison service: loads requirement + buildings through the user's RLS client, adds manual rows, rates, saves. */
type Row = Record<string, any>;
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const basis = (v: unknown): AreaBasis | null => (v === "carpet" || v === "chargeable" ? v : null);

export interface ComparisonInput {
  id?: string | null; title: string; requirementId?: string | null; assetIds: string[]; manual: RatingProperty[];
  modelId?: string | null; termMonths?: number | null; note?: string | null;
}

export async function listRatingModels(db: Db, ws: string) {
  const { data } = await db.from("property_rating_model").select("id, name, version, is_default, factors, rules, created_at").eq("workspace_id", ws).is("archived_at", null).order("name").order("version", { ascending: false });
  return (data ?? []) as Row[];
}
/** Latest version per model name. */
export function latestModels(rows: Row[]) {
  const seen = new Map<string, Row>();
  for (const r of rows) if (!seen.has(r.name) || seen.get(r.name)!.version < r.version) seen.set(r.name, r);
  return [...seen.values()];
}
export async function loadModel(db: Db, ws: string, id?: string | null): Promise<RatingModel & { id: string | null }> {
  if (id) {
    const { data } = await db.from("property_rating_model").select("*").eq("workspace_id", ws).eq("id", id).maybeSingle();
    if (data) return { id: data.id, name: data.name, version: data.version, factors: data.factors as RatingFactor[], rules: data.rules as RatingRule[] };
  }
  const { data } = await db.from("property_rating_model").select("*").eq("workspace_id", ws).eq("is_default", true).is("archived_at", null).order("version", { ascending: false }).limit(1).maybeSingle();
  if (data) return { id: data.id, name: data.name, version: data.version, factors: data.factors as RatingFactor[], rules: data.rules as RatingRule[] };
  return { ...DEFAULT_MODEL, id: null };
}
/** Saves a model as a NEW version row (never overwrites old versions, so past comparisons stay reproducible). */
export async function saveRatingModel(db: Db, ws: string, userId: string, m: { name: string; factors: RatingFactor[]; rules: RatingRule[]; isDefault: boolean }) {
  const errs = validateModel({ name: m.name, factors: m.factors, rules: m.rules });
  if (!m.name.trim()) errs.unshift("Name the model.");
  if (errs.length) throw new Error(errs.join(" "));
  const { data: prev } = await db.from("property_rating_model").select("version").eq("workspace_id", ws).eq("name", m.name).order("version", { ascending: false }).limit(1).maybeSingle();
  if (m.isDefault) await db.from("property_rating_model").update({ is_default: false }).eq("workspace_id", ws).eq("is_default", true);
  const { data, error } = await db.from("property_rating_model").insert({ workspace_id: ws, owner_user_id: userId, name: m.name.trim(), version: (prev?.version ?? 0) + 1, is_default: m.isDefault, factors: m.factors, rules: m.rules }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

export async function listRequirementsForPicker(db: Db, ws: string) {
  const { data } = await db.from("requirement").select("id, title").eq("workspace_id", ws).is("archived_at", null).order("updated_at", { ascending: false }).limit(200);
  return (data ?? []) as Row[];
}
export async function listAssetsForPicker(db: Db, ws: string) {
  const { data } = await db.from("asset").select("id, name, grade, micro:micro_market_id(name)").eq("workspace_id", ws).is("archived_at", null).order("name").limit(500);
  return (data ?? []) as Row[];
}

export async function loadRequirement(db: Db, ws: string, id: string): Promise<RatingRequirement> {
  const { data: r } = await db.from("requirement").select("*").eq("workspace_id", ws).eq("id", id).maybeSingle();
  if (!r) throw new Error("Requirement not found");
  const geoIds = (r.preferred_geography_ids ?? []) as string[];
  const { data: geos } = geoIds.length ? await db.from("geography").select("name").in("id", geoIds) : { data: [] as Row[] };
  const c = (r.constraints ?? {}) as Row;
  return {
    title: r.title, areaMinSf: num(r.area_min_sf), areaTargetSf: num(r.area_target_sf), areaMaxSf: num(r.area_max_sf), areaBasis: basis(r.area_basis),
    // Budget only used as a rent ceiling when stated per sf per month (never coerced from other bases).
    budgetMax: !r.budget_basis || String(r.budget_basis).includes("sf") ? num(r.budget_max) : null,
    microMarkets: (geos ?? []).map((g: Row) => g.name as string),
    requiredAmenities: Array.isArray(c.amenities) ? c.amenities.map(String) : undefined,
    termMonths: num(c.term_months) ?? num(c.tenure_months),
  };
}

/** Building -> one comparable row: latest live quote on its spaces, else latest availability snapshot. */
export async function loadAssetProperties(db: Db, ws: string, assetIds: string[], reqBasis: AreaBasis | null): Promise<{ props: RatingProperty[]; quoteRefs: { id: string; version: number }[] }> {
  if (!assetIds.length) return { props: [], quoteRefs: [] };
  const { data: assets } = await db.from("asset").select("id, name, grade, specs, micro:micro_market_id(name)").eq("workspace_id", ws).in("id", assetIds);
  const { data: spaces } = await db.from("space").select("id, asset_id, carpet_sf, chargeable_sf, efficiency").eq("workspace_id", ws).in("asset_id", assetIds).is("archived_at", null);
  const spaceIds = (spaces ?? []).map((s: Row) => s.id);
  const { data: avail } = spaceIds.length ? await db.from("availability").select("space_id, as_of, status, asking_rent_min, asking_rent_max, rent_basis, fact_status").eq("workspace_id", ws).in("space_id", spaceIds).order("as_of", { ascending: false }) : { data: [] as Row[] };
  const { data: quotes } = spaceIds.length ? await db.from("quote").select("id, version, space_id, terms_json, approved_at, valid_until, created_at").eq("workspace_id", ws).in("space_id", spaceIds).is("superseded_by", null).order("created_at", { ascending: false }) : { data: [] as Row[] };
  const quoteRefs: { id: string; version: number }[] = [];
  const props = (assets ?? []).map((a: Row): RatingProperty => {
    const sp = (spaces ?? []).filter((s: Row) => s.asset_id === a.id);
    const q = (quotes ?? []).find((x: Row) => sp.some((s: Row) => s.id === x.space_id));
    const av = (avail ?? []).find((x: Row) => (q ? x.space_id === q.space_id : sp.some((s: Row) => s.id === x.space_id)));
    const space = sp.find((s: Row) => s.id === (q?.space_id ?? av?.space_id)) ?? sp[0];
    const t = (q?.terms_json ?? {}) as Row;
    const specs = (a.specs ?? {}) as Row;
    const areaBasis: AreaBasis | null = space ? (reqBasis === "carpet" ? (space.carpet_sf ? "carpet" : space.chargeable_sf ? "chargeable" : null) : (space.chargeable_sf ? "chargeable" : space.carpet_sf ? "carpet" : null)) : null;
    const areaSf = space ? num(areaBasis === "carpet" ? space.carpet_sf : space.chargeable_sf) : null;
    if (q) quoteRefs.push({ id: q.id, version: q.version });
    const rent = q ? num(t.rent) : av ? num(av.asking_rent_min) : null;
    return {
      key: a.id, name: a.name, source: "db", microMarket: a.micro?.name ?? null, grade: a.grade ?? null,
      areaSf, areaBasis, efficiency: space ? num(space.efficiency) : null,
      rent, rentBasis: q ? (t.rent_basis ?? null) : (av?.rent_basis ?? null),
      cam: q ? (t.cam_included === true ? 0 : num(t.cam_per_sf)) : null,
      depositMonths: q ? num(t.deposit_months) : null, rentFreeMonths: q ? num(t.rent_free_months) : null,
      escalationPct: q ? num(t.escalation_pct) : null, escalationEveryMonths: q ? num(t.escalation_every_months) : null,
      metroKm: num(specs.metro_km), amenities: Array.isArray(specs.amenities) ? specs.amenities.map(String) : null,
      availabilityStatus: av?.status ?? null, availabilityAsOf: av?.as_of ?? null, factStatus: av?.fact_status ?? null,
      evidence: q ? (q.approved_at ? "approved" : "quoted") : rent !== null ? "estimated" : null,
    };
  });
  return { props, quoteRefs };
}

export async function runComparison(db: Db, ws: string, userId: string, input: ComparisonInput) {
  const req: RatingRequirement = input.requirementId ? await loadRequirement(db, ws, input.requirementId) : {};
  if (input.termMonths) req.termMonths = input.termMonths;
  const { props, quoteRefs } = await loadAssetProperties(db, ws, input.assetIds, req.areaBasis ?? null);
  const properties = [...props, ...input.manual.map((m, i) => ({ ...m, key: m.key || `manual-${i + 1}`, source: "manual" as const }))];
  if (!properties.length) throw new Error("Pick at least one building or add a manual property.");
  const model = await loadModel(db, ws, input.modelId);
  const asOf = new Date().toISOString().slice(0, 10);
  const outputs = rateProperties(model, req, properties, { asOf });
  const missing = outputs.recommendation.key ? [] : ["No eligible property to recommend"];
  return saveAnalysis(db, ws, userId, {
    id: input.id, kind: "property_comparison", title: input.title, requirementId: input.requirementId ?? null, assetIds: input.assetIds, quoteRefs,
    inputs: { requirement: req, properties, model, modelId: model.id, asOf }, outputs, formulaVersion: RATING_FORMULA, missing, note: input.note ?? null,
  });
}
