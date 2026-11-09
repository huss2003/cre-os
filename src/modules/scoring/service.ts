/**
 * Scoring Engine service: model registry + versions, scoring with history, overrides, feedback, recalculation.
 * Calculated scores are never overwritten by a person: overrides live in score_override and are shown beside them.
 */
import type { Db } from "@/lib/supabase/server";
import { compute, inputsHash, validateVersion, ModelError, type ModelKey, type ModelVersion, type ScoreOutput } from "./engine";
import { MODELS, MODEL_KEYS } from "./models";
import { extract, ENTITY_FOR } from "./features";

type Row = Record<string, any>;
export class ScoringError extends Error {}

/** Creates version 1 of every model for this workspace if missing. Idempotent. */
export async function ensureModels(db: Db, ws: string): Promise<Record<ModelKey, Row>> {
  const { data } = await db.from("scoring_model").select("id, key, name, purpose, active, active_version_id").eq("workspace_id", ws);
  const have = new Map((data ?? []).map((m) => [m.key, m]));
  for (const key of MODEL_KEYS) {
    if (have.get(key)?.active_version_id) continue;
    const def = MODELS[key];
    let m = have.get(key);
    if (!m) {
      const ins = await db.from("scoring_model").insert({ workspace_id: ws, key, name: def.name, purpose: def.purpose }).select("id, key, name, purpose, active, active_version_id").single();
      if (ins.error) { const again = await db.from("scoring_model").select("id, key, name, purpose, active, active_version_id").eq("workspace_id", ws).eq("key", key).single(); m = again.data!; }
      else m = ins.data;
    }
    if (!m!.active_version_id) {
      const v = await db.from("scoring_model_version").insert({ workspace_id: ws, model_id: m!.id, version: 1, factors: def.version.factors, bands: def.version.bands, config: def.version.config, note: "Default model" }).select("id").single();
      const vid = v.data?.id ?? (await db.from("scoring_model_version").select("id").eq("model_id", m!.id).eq("version", 1).single()).data!.id;
      await db.from("scoring_model").update({ active_version_id: vid }).eq("id", m!.id);
      m = { ...m!, active_version_id: vid };
    }
    have.set(key, m!);
  }
  return Object.fromEntries(have) as Record<ModelKey, Row>;
}

export async function activeVersion(db: Db, ws: string, key: ModelKey): Promise<{ id: string; version: number; v: ModelVersion; active: boolean }> {
  const models = await ensureModels(db, ws);
  const m = models[key];
  const { data } = await db.from("scoring_model_version").select("id, version, factors, bands, config").eq("id", m.active_version_id).single();
  return { id: data!.id, version: data!.version, v: { factors: data!.factors, bands: data!.bands, config: data!.config }, active: m.active };
}

function changeReason(prev: Row | null, out: ScoreOutput): string | null {
  if (!prev) return "First calculation";
  const before = new Map<string, Row>((prev.factors as Row[]).map((f) => [f.key, f]));
  const diffs = out.factors.filter((f) => (before.get(f.key)?.points ?? null) !== f.points)
    .map((f) => `${f.label} ${before.get(f.key)?.points ?? "–"}→${f.points}`);
  return diffs.length ? diffs.join("; ") : prev.model_version_id ? "Model version changed" : null;
}

/** Scores one entity. Unchanged inputs + same model version => no new row (returns the current one). */
export async function scoreEntity(db: Db, ws: string, key: ModelKey, entityId: string, trigger = "manual"): Promise<Row> {
  const av = await activeVersion(db, ws, key);
  if (!av.active) throw new ScoringError(`${MODELS[key].name} is switched off.`);
  const features = await extract(db, ws, key, entityId, av.v.config as Row);
  const out = compute(av.v, features);
  const hash = inputsHash(av.id, features);
  const { data: prev } = await db.from("score_result").select("*").eq("workspace_id", ws).eq("model_key", key).eq("entity_id", entityId).eq("is_current", true).maybeSingle();
  if (prev && prev.inputs_hash === hash) return prev;
  const row = {
    workspace_id: ws, model_key: key, model_version_id: av.id, entity_type: ENTITY_FOR[key], entity_id: entityId,
    score: out.score, band: out.band, disqualified: out.disqualified, confidence: out.confidence, completeness: out.completeness,
    factors: out.factors, extra: { ...out.extra, model_version: av.version }, missing: out.missing, recommended_action: out.recommended,
    inputs_hash: hash, trigger, previous_score: prev?.score ?? null, change_reason: changeReason(prev, out), is_current: true,
  };
  if (prev) await db.from("score_result").update({ is_current: false }).eq("id", prev.id).eq("is_current", true);
  const ins = await db.from("score_result").insert(row).select("*").single();
  if (ins.error) {
    // A parallel run already stored the current score: return it (no duplicate history rows).
    const { data: cur } = await db.from("score_result").select("*").eq("workspace_id", ws).eq("model_key", key).eq("entity_id", entityId).eq("is_current", true).maybeSingle();
    if (cur) return cur;
    throw new ScoringError(ins.error.message);
  }
  return ins.data;
}

/** Everything that depends on one company, in dependency order (company/relationship feed lead/opportunity). */
export async function recalcOrg(db: Db, ws: string, orgId: string, trigger: string) {
  const out: Row[] = [];
  const safe = async (k: ModelKey, id: string) => { try { out.push(await scoreEntity(db, ws, k, id, trigger)); } catch (e) { if (!(e instanceof ScoringError)) throw e; } };
  await safe("company", orgId);
  await safe("relationship", orgId);
  const [{ data: reqs }, { data: emps }, { data: opps }] = await Promise.all([
    db.from("requirement").select("id").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).limit(50),
    db.from("employment").select("person_id").eq("workspace_id", ws).eq("org_id", orgId).eq("is_current", true).is("archived_at", null).limit(100),
    db.from("opportunity").select("id").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).limit(50),
  ]);
  for (const r of reqs ?? []) await safe("requirement", r.id);
  for (const p of new Set((emps ?? []).map((e) => e.person_id))) await safe("contact", p as string);
  await safe("lead", orgId);
  for (const o of opps ?? []) await safe("opportunity", o.id);
  return out;
}

/** Bulk: scores records not yet scored or older than `staleDays` (never every record blindly). */
export async function recalcStale(db: Db, ws: string, opts: { limit?: number; staleDays?: number; trigger?: string } = {}) {
  const limit = opts.limit ?? 150;
  const cutoff = new Date(Date.now() - (opts.staleDays ?? 7) * 86_400_000).toISOString();
  const { data: orgs } = await db.from("organisation").select("id").eq("workspace_id", ws).is("archived_at", null).limit(3000);
  const { data: scored } = await db.from("score_result").select("entity_id, calculated_at").eq("workspace_id", ws).eq("model_key", "company").eq("is_current", true).limit(5000);
  const fresh = new Set((scored ?? []).filter((s) => s.calculated_at >= cutoff).map((s) => s.entity_id));
  const todo = (orgs ?? []).map((o) => o.id).filter((id) => !fresh.has(id)).slice(0, limit);
  let n = 0;
  for (const id of todo) { await recalcOrg(db, ws, id, opts.trigger ?? "scheduled"); n++; }
  return { companies: n, remaining: Math.max(0, (orgs ?? []).length - fresh.size - n) };
}

// ------------------------------------------------------------------ overrides & feedback

export async function overridePriority(db: Db, ws: string, userId: string, key: ModelKey, entityId: string, value: string, reason: string, kind: "priority" | "relationship_assessment" = "priority") {
  if (!reason || reason.trim().length < 3) throw new ScoringError("Give a reason.");
  const { data: cur } = await db.from("score_result").select("score").eq("workspace_id", ws).eq("model_key", key).eq("entity_id", entityId).eq("is_current", true).maybeSingle();
  await db.from("score_override").update({ active: false }).eq("workspace_id", ws).eq("model_key", key).eq("entity_id", entityId).eq("kind", kind).eq("active", true);
  const { error } = await db.from("score_override").insert({ workspace_id: ws, model_key: key, entity_id: entityId, kind, original_score: cur?.score ?? null, value, reason: reason.trim(), owner_user_id: userId });
  if (error) throw new ScoringError(error.message);
  if (kind === "relationship_assessment") await scoreEntity(db, ws, "relationship", entityId, "relationship_assessment");
}
export async function clearOverride(db: Db, ws: string, key: ModelKey, entityId: string) {
  await db.from("score_override").update({ active: false }).eq("workspace_id", ws).eq("model_key", key).eq("entity_id", entityId).eq("kind", "priority").eq("active", true);
}
export async function addFeedback(db: Db, ws: string, userId: string, resultId: string, kind: string, comment: string | null) {
  const { error } = await db.from("score_feedback").insert({ workspace_id: ws, score_result_id: resultId, kind, comment, owner_user_id: userId });
  if (error) throw new ScoringError(error.message);
}

// ------------------------------------------------------------------ model configuration (versioned)

export async function saveVersion(db: Db, ws: string, key: ModelKey, v: ModelVersion, note: string) {
  const errs = validateVersion(v);
  if (errs.length) throw new ScoringError(errs.join(" "));
  const models = await ensureModels(db, ws);
  const m = models[key];
  const { data: last } = await db.from("scoring_model_version").select("version").eq("model_id", m.id).order("version", { ascending: false }).limit(1).single();
  const { data, error } = await db.from("scoring_model_version").insert({ workspace_id: ws, model_id: m.id, version: (last?.version ?? 0) + 1, factors: v.factors, bands: v.bands, config: v.config, note: note || null }).select("id, version").single();
  if (error) throw new ScoringError(error.message);
  await db.from("scoring_model").update({ active_version_id: data.id }).eq("id", m.id);
  return data;
}
export async function activateVersion(db: Db, ws: string, key: ModelKey, versionId: string) {
  const models = await ensureModels(db, ws);
  const { data: v } = await db.from("scoring_model_version").select("id").eq("workspace_id", ws).eq("model_id", models[key].id).eq("id", versionId).maybeSingle();
  if (!v) throw new ScoringError("Version not found.");
  await db.from("scoring_model").update({ active_version_id: versionId }).eq("id", models[key].id);
}
export async function setModelActive(db: Db, ws: string, key: ModelKey, active: boolean) {
  const models = await ensureModels(db, ws);
  await db.from("scoring_model").update({ active }).eq("id", models[key].id);
}
/** Preview a draft version on a sample record without saving anything. */
export async function preview(db: Db, ws: string, key: ModelKey, draft: ModelVersion, entityId: string) {
  const errs = validateVersion(draft);
  if (errs.length) throw new ScoringError(errs.join(" "));
  const av = await activeVersion(db, ws, key);
  const f = await extract(db, ws, key, entityId, draft.config as Row);
  return { current: compute(av.v, f), draft: compute(draft, f) };
}
export { ModelError };
