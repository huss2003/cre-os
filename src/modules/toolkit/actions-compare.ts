"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import type { ActionState } from "@/modules/admin/ui/client";
import { runComparison, saveRatingModel } from "./comparison";
import { getAnalysis } from "./store";
import type { AreaBasis, RatingFactor, RatingProperty, RatingRule } from "./calc/rating";

const s = (f: FormData, k: string) => { const v = f.get(k); return v === null ? "" : String(v).trim(); };
/** Blank stays unknown (null) — never coerced to 0. */
const n = (f: FormData, k: string) => { const v = s(f, k).replace(/,/g, ""); if (v === "") return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
const err = (e: unknown) => ({ error: e instanceof Error ? e.message.slice(0, 500) : "Something went wrong" });

function manualRows(f: FormData): RatingProperty[] {
  const out: RatingProperty[] = [];
  for (let i = 0; i < 6; i++) {
    const name = s(f, `m${i}_name`);
    if (!name) continue;
    const b = s(f, `m${i}_basis`);
    const esc = n(f, `m${i}_esc`), escYears = n(f, `m${i}_escyears`);
    out.push({
      key: `manual-${i + 1}`, name, source: "manual", microMarket: s(f, `m${i}_mm`) || null, grade: s(f, `m${i}_grade`) || null,
      areaSf: n(f, `m${i}_area`), areaBasis: (b === "carpet" || b === "chargeable" ? b : null) as AreaBasis | null, rentBasis: (b === "carpet" || b === "chargeable" ? b : null) as AreaBasis | null,
      rent: n(f, `m${i}_rent`), cam: n(f, `m${i}_cam`), depositMonths: n(f, `m${i}_dep`), rentFreeMonths: n(f, `m${i}_rf`),
      escalationPct: esc, escalationEveryMonths: escYears === null ? null : escYears * 12, metroKm: n(f, `m${i}_metro`),
      evidence: (s(f, `m${i}_evidence`) || "manual") as RatingProperty["evidence"],
    });
  }
  return out;
}

export async function createComparisonAction(_: ActionState, f: FormData): Promise<ActionState> {
  let id: string;
  try {
    const ctx = await requireContext("editor");
    const r = await runComparison(ctx.db, ctx.workspaceId, ctx.userId, {
      title: s(f, "title") || "Property comparison", requirementId: s(f, "requirement_id") || null,
      assetIds: f.getAll("asset_ids").map(String).filter(Boolean), manual: manualRows(f), modelId: s(f, "model_id") || null, termMonths: n(f, "term_months"),
    });
    id = r.id;
  } catch (e) { return err(e); }
  revalidatePath("/toolkit/compare");
  redirect(`/toolkit/compare/${id}`);
}

/** Re-run with the CURRENT data (DB rows re-read, manual rows kept) as a new immutable version. */
export async function rerunComparisonAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const a = (await getAnalysis(ctx.db, ctx.workspaceId, s(f, "id"))) as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!a) return { error: "Comparison not found" };
    const inp = a.inputs as { properties?: RatingProperty[]; modelId?: string | null; requirement?: { termMonths?: number | null } };
    const r = await runComparison(ctx.db, ctx.workspaceId, ctx.userId, {
      id: a.id, title: a.title, requirementId: a.requirement_id, assetIds: a.asset_ids ?? [],
      manual: (inp.properties ?? []).filter((p) => p.source === "manual"), modelId: s(f, "model_id") || inp.modelId || null,
      termMonths: inp.requirement?.termMonths ?? null, note: s(f, "note") || "Re-run",
    });
    revalidatePath(`/toolkit/compare/${a.id}`);
    return { ok: true, message: `Saved as version ${r.version}.` };
  } catch (e) { return err(e); }
}

export async function saveRatingModelAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const factors = JSON.parse(s(f, "factors") || "[]") as RatingFactor[];
    const rules = JSON.parse(s(f, "rules") || "[]") as RatingRule[];
    await saveRatingModel(ctx.db, ctx.workspaceId, ctx.userId, { name: s(f, "name"), factors: factors.map((x) => ({ ...x, weight: Number(x.weight) })), rules, isDefault: f.get("is_default") === "on" });
  } catch (e) { return err(e); }
  revalidatePath("/toolkit/models");
  return { ok: true, message: "Saved as a new model version." };
}
