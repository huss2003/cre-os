"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { actOnSignal, ingestText, scanWorkspace, SignalError } from "./service";
import { runSignalForm, FormProblem, ACTION_MESSAGE, counterMessage } from "./ui-data";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import { escapeLike } from "@/lib/util/like";

const str = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" && v.trim() ? v.trim() : undefined; };

export async function signalAction(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("viewer");
    const { action } = await runSignalForm(ctx, id, form, actOnSignal as never);
    revalidatePath("/signals"); revalidatePath(`/signals/${id}`);
    return { ok: true, message: ACTION_MESSAGE[action] ?? "Saved." };
  } catch (e) { return { error: e instanceof SignalError || e instanceof FormProblem ? e.message : errorMessage(e) }; }
}

/** Sources page: pause / resume / reconnect / manual refresh. Admins manage sources; editors may refresh. */
export async function sourceAction(registryId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const op = String(form.get("op") ?? "");
    const ctx = await requireContext(op === "refresh" ? "editor" : "admin");
    const src = await import("./sources");
    if (op === "pause" || op === "resume") { await src.setSourcePaused(ctx.db, ctx.workspaceId, registryId, op === "pause"); }
    else if (op === "reconnect") {
      const r = await src.reconnectSource(ctx.db, ctx.workspaceId, registryId) as { connectionStatus?: string; message?: string } | undefined;
      revalidatePath("/signals/sources");
      if (r?.connectionStatus === "needs_access") return { error: r.message ?? "This source still needs access." };
    } else throw new FormProblem("Unknown source action.");
    revalidatePath("/signals/sources");
    return { ok: true, message: op === "pause" ? "Paused." : op === "resume" ? "Resumed." : "Reconnected." };
  } catch (e) { return { error: e instanceof FormProblem ? e.message : errorMessage(e) }; }
}

export async function refreshNowAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const { refreshNow } = await import("./refresh");
    const orgId = str(form, "org_id");
    const r = await refreshNow(ctx.db, ctx.workspaceId, { orgId, actorUserId: ctx.userId }) as Record<string, unknown>;
    revalidatePath("/signals"); revalidatePath("/signals/sources");
    const n = Object.entries(r ?? {}).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(", ");
    return { ok: true, message: `Refresh done${n ? ` — ${n}` : ""}.` };
  } catch (e) { return { error: errorMessage(e) }; }
}

export async function retryItemAction(itemId: string, _prev: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const { retrySourceItem } = await import("./pipeline");
    await retrySourceItem(ctx.db, ctx.workspaceId, itemId);
    revalidatePath("/signals/sources"); revalidatePath("/signals");
    return { ok: true, message: "Retried." };
  } catch (e) { return { error: errorMessage(e) }; }
}

export async function universeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("admin");
    const cap = Number(form.get("cap"));
    if (!Number.isInteger(cap) || cap < 50 || cap > 8000) return { error: "Enter a whole number between 50 and 8,000." };
    const { setUniverseCap } = await import("./refresh");
    await setUniverseCap(ctx.db, ctx.workspaceId, cap);
    revalidatePath("/signals/sources");
    return { ok: true, message: `Research universe capped at ${cap.toLocaleString("en-IN")} companies.` };
  } catch (e) { return { error: errorMessage(e) }; }
}

export async function ingestAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const r = await ingestText(ctx.db, ctx.workspaceId, {
      text: String(form.get("text") ?? ""), companyName: str(form, "company"), orgId: str(form, "org_id"), sourceName: str(form, "source"),
      sourceUrl: str(form, "url"), publishedOn: str(form, "published_on"), actorUserId: ctx.userId, signalId: str(form, "signal_id"),
    });
    revalidatePath("/signals");
    for (const u of r.counterFor) revalidatePath(`/signals/${u.id}`);
    if (r.counterFor.length) return { ok: true, message: counterMessage(r.counterFor) };
    if (!r.detected) return { ok: true, message: "No CRE signal found in that text. Nothing was created." };
    const unresolved = r.resolution && !r.resolution.orgId
      ? ` Company “${r.rawName ?? "unknown"}” not matched${r.resolution.candidates.length ? ` (maybe: ${r.resolution.candidates.map((c) => c.name).join(", ")})` : ""} — confirm it or add it as a new company on the signal.` : "";
    return { ok: true, message: `${r.detected} signal(s) found, ${r.signals.filter((s) => s.created).length} new.${unresolved}` };
  } catch (e) { return { error: e instanceof SignalError ? e.message : errorMessage(e) }; }
}

export async function scanAction(_prev: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const r = await scanWorkspace(ctx.db, ctx.workspaceId);
    revalidatePath("/signals");
    return { ok: true, message: `Scan done: ${r.lease} new lease signal(s), ${r.claims} new evidence signal(s).` };
  } catch (e) { return { error: errorMessage(e) }; }
}

export async function researchNowAction(orgId: string, _prev: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const { researchCompany } = await import("./research");
    const r = await researchCompany(ctx.db, ctx.workspaceId, orgId, { actorUserId: ctx.userId });
    revalidatePath("/research"); revalidatePath("/signals");
    if (r.skipped) return { error: `Research didn't finish: ${r.skipped}` };
    return { ok: true, message: r.stored ? `Found ${r.stored} new item(s) — see Signals.` : "Searched. Nothing new found." };
  } catch (e) { return { error: errorMessage(e) }; }
}

export async function saveSettingsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("admin");
    const weekly = Math.max(1, Math.min(500, Number(form.get("weekly")) || 25));
    const cities = String(form.get("cities") ?? "Pune").split(",").map((c) => c.trim()).filter(Boolean).slice(0, 10);
    const { data: cur } = await ctx.db.from("workspace_setting").select("value").eq("workspace_id", ctx.workspaceId).eq("key", "signals").maybeSingle();
    const value = { ...((cur?.value as object) ?? {}), weeklyCompanyLimit: weekly, focusCities: cities.length ? cities : ["Pune"] };
    const { error } = await ctx.db.from("workspace_setting").upsert({ workspace_id: ctx.workspaceId, key: "signals", value, updated_at: new Date().toISOString() });
    if (error) throw error;
    revalidatePath("/research");
    return { ok: true, message: "Saved." };
  } catch (e) { return { error: errorMessage(e) }; }
}

export async function discoverAction(_prev: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const { discoverMarket } = await import("./research");
    const r = await discoverMarket(ctx.db, ctx.workspaceId, { actorUserId: ctx.userId });
    revalidatePath("/research"); revalidatePath("/signals");
    if (r.skipped) return { error: `Scan didn't run: ${r.skipped}` };
    if (!r.picked) return { ok: true, message: "No new company picked — see the reason on the run below." };
    return { ok: true, message: `New prospect: ${r.picked} — ${r.score}/100. Open it in Live research.` };
  } catch (e) { return { error: errorMessage(e) }; }
}

/** Saves a prospect found by the market scan as a company, and links its assessment and signals. */
export async function addProspectAction(runId: string, _prev: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const { data: run } = await ctx.db.from("research_run").select("assessment").eq("workspace_id", ctx.workspaceId).eq("id", runId).maybeSingle();
    const a = run?.assessment as { company: string; orgId: string | null } | null;
    if (!a || a.orgId) return { error: "Already saved." };
    const { resolveOrg } = await import("./service");
    const existing = await resolveOrg(ctx.db, ctx.workspaceId, a.company);
    let orgId = existing.orgId;
    if (!orgId) {
      const { data: org, error } = await ctx.db.from("organisation").insert({ workspace_id: ctx.workspaceId, display_name: a.company, owner_user_id: ctx.userId }).select("id").single();
      if (error) throw error;
      orgId = org.id as string;
    }
    await ctx.db.from("research_run").update({ org_id: orgId, assessment: { ...a, orgId } }).eq("workspace_id", ctx.workspaceId).eq("id", runId);
    const { data: sigs } = await ctx.db.from("signal").select("id").eq("workspace_id", ctx.workspaceId).is("org_id", null).ilike("entity_name_raw", escapeLike(a.company));
    for (const sg of sigs ?? []) await actOnSignal(ctx.db, ctx.workspaceId, ctx.userId, sg.id, "correct_company", { org_id: orgId });
    revalidatePath(`/research/assessment/${runId}`); revalidatePath("/signals"); revalidatePath("/research");
    return { ok: true, message: `${a.company} saved to your companies.` };
  } catch (e) { return { error: errorMessage(e) }; }
}

/** Turns an unmatched company name on a signal into a real company record and links it. */
export async function addCompanyFromSignalAction(id: string, _prev: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const { data: sig } = await ctx.db.from("signal").select("entity_name_raw, org_id").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle();
    if (!sig?.entity_name_raw || sig.org_id) return { error: "Nothing to add." };
    const { data: org, error } = await ctx.db.from("organisation").insert({ workspace_id: ctx.workspaceId, display_name: sig.entity_name_raw, owner_user_id: ctx.userId }).select("id").single();
    if (error) throw error;
    await actOnSignal(ctx.db, ctx.workspaceId, ctx.userId, id, "correct_company", { org_id: org.id });
    revalidatePath(`/signals/${id}`); revalidatePath("/signals");
    return { ok: true, message: `${sig.entity_name_raw} added to your companies and linked.` };
  } catch (e) { return { error: errorMessage(e) }; }
}

export async function assessAction(orgId: string, _prev: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const { assessCompany } = await import("./assess");
    const r = await assessCompany(ctx.db, ctx.workspaceId, orgId, { actorUserId: ctx.userId });
    revalidatePath("/research");
    return { ok: true, message: `${r.assessment.company}: ${r.assessment.score}/100 (${r.assessment.band}). Open it in Live research.` };
  } catch (e) { return { error: errorMessage(e) }; }
}

export async function assessFormAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orgId = String(form.get("org_id") ?? "");
  if (!orgId) return { error: "Choose a company." };
  return assessAction(orgId, null);
}
