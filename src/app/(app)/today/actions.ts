"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/auth/context";
import { generateDailyBrief } from "@/modules/brief/brief-service";
import { loadCtxFor, todayFor } from "@/modules/brief/context";
import { addDays } from "@/modules/brief/dates";
import { loadSettings, loadUserPrefs } from "@/modules/brief/db";
import { completeTask, createTargetTask, snoozeTask } from "@/modules/brief/tasks-service";

function back(msg: { ok?: string; error?: string }, path = "/today"): never {
  const q = new URLSearchParams(msg as Record<string, string>).toString();
  redirect(`${path}?${q}`);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 200) : "Something went wrong";
}

export async function generateBriefAction() {
  let msg: { ok?: string; error?: string };
  try {
    const ctx = await requireContext("editor");
    const settings = await loadSettings(ctx.db, ctx.workspaceId, ctx.userId);
    const r = await generateDailyBrief(loadCtxFor(ctx), settings, { date: todayFor(ctx), generatedBy: "user" });
    msg = { ok: r.created ? `Brief version ${r.brief.version} generated` : "Nothing changed since the last version" };
  } catch (e) {
    msg = { error: errMsg(e) };
  }
  revalidatePath("/today");
  back(msg);
}

export async function addTargetTaskAction(form: FormData) {
  let msg: { ok?: string; error?: string };
  try {
    const ctx = await requireContext("editor");
    const orgId = String(form.get("org_id") ?? "");
    const name = String(form.get("name") ?? "").slice(0, 200);
    const why = String(form.get("why") ?? "").slice(0, 500);
    if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error("bad target");
    await createTargetTask(ctx.db, ctx.workspaceId, ctx.userId, { orgId, name, why, date: todayFor(ctx) });
    msg = { ok: `Task added: approach ${name}` };
  } catch (e) {
    msg = { error: errMsg(e) };
  }
  revalidatePath("/today");
  back(msg);
}

/** Snooze a target for N days (stored in the user's own preferences; RLS: own row only). */
export async function snoozeTargetAction(form: FormData) {
  let msg: { ok?: string; error?: string };
  try {
    const ctx = await requireContext();
    const orgId = String(form.get("org_id") ?? "");
    const days = Math.min(90, Math.max(1, Number(form.get("days") ?? 7)));
    if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error("bad target");
    const prefs = await loadUserPrefs(ctx.db, ctx.workspaceId, ctx.userId);
    const today = todayFor(ctx);
    const current = (prefs.snoozedTargets && typeof prefs.snoozedTargets === "object" ? prefs.snoozedTargets : {}) as Record<string, string>;
    const pruned = Object.fromEntries(Object.entries(current).filter(([, until]) => until >= today));
    pruned[orgId] = addDays(today, days);
    const { error } = await ctx.db.from("user_preference").upsert({ workspace_id: ctx.workspaceId, user_id: ctx.userId, prefs: { ...prefs, snoozedTargets: pruned } }, { onConflict: "workspace_id,user_id" });
    if (error) throw error;
    msg = { ok: `Target snoozed until ${pruned[orgId]} (takes effect in the next plan)` };
  } catch (e) {
    msg = { error: errMsg(e) };
  }
  revalidatePath("/today");
  back(msg);
}

export async function completeTaskFromToday(form: FormData) {
  let msg: { ok?: string; error?: string };
  try {
    const ctx = await requireContext("editor");
    await completeTask(ctx.db, ctx.workspaceId, String(form.get("id")), { expectedVersion: Number(form.get("version")), evidence: String(form.get("evidence") ?? "") });
    msg = { ok: "Task completed" };
  } catch (e) {
    msg = { error: e && typeof e === "object" && "issues" in e ? "Add a short note of what was done (evidence)" : errMsg(e) };
  }
  revalidatePath("/today");
  back(msg);
}

export async function snoozeTaskFromToday(form: FormData) {
  let msg: { ok?: string; error?: string };
  try {
    const ctx = await requireContext("editor");
    const days = Math.min(30, Math.max(1, Number(form.get("days") ?? 1)));
    const until = new Date(Date.now() + days * 86_400_000).toISOString();
    await snoozeTask(ctx.db, ctx.workspaceId, String(form.get("id")), { expectedVersion: Number(form.get("version")), until });
    msg = { ok: `Snoozed for ${days} day(s)` };
  } catch (e) {
    msg = { error: errMsg(e) };
  }
  revalidatePath("/today");
  back(msg);
}
