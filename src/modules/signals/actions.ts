"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { actOnSignal, ingestText, scanWorkspace, SignalError, type SignalAction } from "./service";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";

const str = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" && v.trim() ? v.trim() : undefined; };

export async function signalAction(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const action = String(form.get("action") ?? "") as SignalAction;
    const data: Record<string, string | undefined> = {};
    for (const k of ["reason", "until", "title", "opportunity_id", "name", "text", "source", "url", "published_on", "org_id", "band", "review_on"]) data[k] = str(form, k);
    await actOnSignal(ctx.db, ctx.workspaceId, ctx.userId, id, action, data);
    revalidatePath("/signals"); revalidatePath(`/signals/${id}`);
    const msg: Partial<Record<SignalAction, string>> = { approve: "Approved — follow-up task created.", create_task: "Task created.", propose_opportunity: "Opportunity proposal sent to Review.", snooze: "Snoozed.", dismiss: "Dismissed.", reject: "Rejected." };
    return { ok: true, message: msg[action] ?? "Saved." };
  } catch (e) { return { error: e instanceof SignalError ? e.message : errorMessage(e) }; }
}

export async function ingestAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const r = await ingestText(ctx.db, ctx.workspaceId, {
      text: String(form.get("text") ?? ""), companyName: str(form, "company"), orgId: str(form, "org_id"), sourceName: str(form, "source"),
      sourceUrl: str(form, "url"), publishedOn: str(form, "published_on"), actorUserId: ctx.userId,
    });
    revalidatePath("/signals");
    if (!r.detected) return { ok: true, message: "No CRE signal found in that text. Nothing was created." };
    const unresolved = r.resolution && !r.resolution.orgId
      ? ` Company not matched${r.resolution.candidates.length ? ` (maybe: ${r.resolution.candidates.map((c) => c.name).join(", ")})` : ""} — fix it on the signal.` : "";
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
    if (!r.picked) return { ok: true, message: "No new company found this time — everyone in the news is already in your records." };
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
    const { data: sigs } = await ctx.db.from("signal").select("id").eq("workspace_id", ctx.workspaceId).is("org_id", null).ilike("entity_name_raw", a.company);
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
