"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import { scoreEntity, recalcOrg, recalcStale, overridePriority, clearOverride, addFeedback, saveVersion, activateVersion, setModelActive, preview, activeVersion, ScoringError } from "./service";
import type { ModelKey, ModelVersion, Unknown } from "./engine";
import { MODEL_KEYS } from "./models";

const key = (k: unknown): ModelKey => { if (!MODEL_KEYS.includes(k as ModelKey)) throw new ScoringError("Unknown model."); return k as ModelKey; };
const err = (e: unknown): ActionState => ({ error: e instanceof ScoringError ? e.message : errorMessage(e) });

export async function recalcAction(model: string, id: string, _p: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const k = key(model);
    if (["company", "lead", "relationship"].includes(k)) await recalcOrg(ctx.db, ctx.workspaceId, id, "manual");
    else await scoreEntity(ctx.db, ctx.workspaceId, k, id, "manual");
    revalidatePath(`/scoring/${model}/${id}`); revalidatePath("/scoring");
    return { ok: true, message: "Recalculated. If nothing changed, no new history entry was added." };
  } catch (e) { return err(e); }
}

export async function bulkAction(_p: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireContext("admin");
    const r = await recalcStale(ctx.db, ctx.workspaceId, { limit: 60, staleDays: 0, trigger: "bulk" });
    revalidatePath("/scoring");
    return { ok: true, message: `Scored ${r.companies} companies and their contacts, requirements and deals.${r.remaining ? ` ${r.remaining} left — press again.` : ""}` };
  } catch (e) { return err(e); }
}

export async function overrideAction(model: string, id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const kind = f.get("kind") === "relationship_assessment" ? "relationship_assessment" : "priority";
    if (f.get("clear") === "1") await clearOverride(ctx.db, ctx.workspaceId, key(model), id);
    else await overridePriority(ctx.db, ctx.workspaceId, ctx.userId, key(model), id, String(f.get("value") ?? ""), String(f.get("reason") ?? ""), kind);
    revalidatePath(`/scoring/${model}/${id}`); revalidatePath("/scoring");
    return { ok: true, message: "Saved. The calculated score is unchanged and kept." };
  } catch (e) { return err(e); }
}

export async function feedbackAction(model: string, id: string, resultId: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    await addFeedback(ctx.db, ctx.workspaceId, ctx.userId, resultId, String(f.get("kind") ?? ""), String(f.get("comment") ?? "").trim() || null);
    revalidatePath(`/scoring/${model}/${id}`);
    return { ok: true, message: "Thanks — feedback recorded for review." };
  } catch (e) { return err(e); }
}

/** Reads the model editor form into a version. */
function readVersion(f: FormData, base: ModelVersion): ModelVersion {
  const factors = base.factors.map((x) => ({
    ...x,
    weight: Number(f.get(`w_${x.key}`) ?? x.weight),
    unknown: (String(f.get(`u_${x.key}`) ?? x.unknown) as Unknown),
  }));
  const bands = String(f.get("bands") ?? "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [min, ...rest] = l.split(/[=:]/); return { min: Number(min), label: rest.join(":").trim() };
  });
  const config = { ...base.config };
  const iw = String(f.get("industry") ?? "").trim();
  if (iw) config.industry_weights = Object.fromEntries(iw.split("\n").map((l) => l.split(/[=:]/)).filter((p) => p.length >= 2).map(([k, v]) => [k.trim().toLowerCase(), Math.max(0, Math.min(1, Number(v)))]));
  const fc = String(f.get("focus") ?? "").trim();
  if (fc) config.focus_cities = fc.split(",").map((c) => c.trim()).filter(Boolean);
  return { factors, bands: bands.length ? bands : base.bands, config };
}

export async function saveModelAction(model: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("admin");
    const k = key(model);
    const av = await activeVersion(ctx.db, ctx.workspaceId, k);
    const v = readVersion(f, av.v);
    if (f.get("intent") === "preview") {
      const sample = String(f.get("sample") ?? "");
      if (!sample) return { error: "Pick a sample record to preview." };
      const p = await preview(ctx.db, ctx.workspaceId, k, v, sample);
      return { ok: true, message: `Preview on sample: now ${p.current.score} (${p.current.band}) → with changes ${p.draft.score} (${p.draft.band}). Nothing saved.` };
    }
    const saved = await saveVersion(ctx.db, ctx.workspaceId, k, v, String(f.get("note") ?? ""));
    revalidatePath("/scoring/models");
    return { ok: true, message: `Saved as version ${saved.version} and made active. Scores update on next recalculation.` };
  } catch (e) { return err(e); }
}

export async function activateVersionAction(model: string, versionId: string, _p: ActionState): Promise<ActionState> {
  try { const ctx = await requireContext("admin"); await activateVersion(ctx.db, ctx.workspaceId, key(model), versionId); revalidatePath("/scoring/models"); return { ok: true, message: "Version activated." }; }
  catch (e) { return err(e); }
}
export async function toggleModelAction(model: string, active: boolean, _p: ActionState): Promise<ActionState> {
  try { const ctx = await requireContext("admin"); await setModelActive(ctx.db, ctx.workspaceId, key(model), active); revalidatePath("/scoring/models"); return { ok: true, message: active ? "Model switched on." : "Model switched off." }; }
  catch (e) { return err(e); }
}
