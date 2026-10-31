"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/auth/context";
import { createTask } from "@/lib/services/tasks";
import { loadCtxFor, todayFor } from "@/modules/brief/context";
import { loadSettings } from "@/modules/brief/db";
import { buildDailyPlan } from "@/modules/brief/plan";

function back(msg: { ok?: string; error?: string }): never {
  redirect(`/today?${new URLSearchParams(msg as Record<string, string>).toString()}`);
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : "Something went wrong");

/** Re-plan the day now (same deterministic engine as the 07:20 job and the event-driven re-plan). */
export async function replanAction() {
  let msg: { ok?: string; error?: string };
  try {
    const ctx = await requireContext("editor");
    const settings = await loadSettings(ctx.db, ctx.workspaceId, ctx.userId);
    const p = await buildDailyPlan(loadCtxFor(ctx), settings, todayFor(ctx), { reason: "manual re-plan" });
    msg = { ok: `Day re-planned: ${p.agenda?.timeline.filter((t) => !t.fixed).length ?? 0} actions scheduled, ${p.agenda?.conflicts.length ?? 0} conflict(s)` };
  } catch (e) {
    msg = { error: errMsg(e) };
  }
  revalidatePath("/today");
  back(msg);
}

const LINK_TYPES = new Set(["interaction", "meeting_visit", "lease", "opportunity", "organisation"]);

/** Turn a renewal/referral suggestion into a task (idempotent per suggestion key). Nothing is sent. */
export async function addSuggestionTaskAction(form: FormData) {
  let msg: { ok?: string; error?: string };
  try {
    const ctx = await requireContext("editor");
    const key = String(form.get("key") ?? "");
    const linkType = String(form.get("link_type") ?? "");
    const linkId = String(form.get("link_id") ?? "");
    const due = String(form.get("due") ?? "");
    if (!/^caretaker:[\w:.-]{3,200}$/.test(key) || !LINK_TYPES.has(linkType) || !/^[0-9a-f-]{36}$/i.test(linkId)) throw new Error("bad suggestion");
    const title = String(form.get("title") ?? "").slice(0, 300);
    await createTask(ctx.db, ctx.workspaceId, {
      title, description: `${String(form.get("why") ?? "").slice(0, 1000)}. Suggested follow-up — you decide and you send.`,
      dueAt: /^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T05:30:00.000Z` : null, priority: 55, source: "brief",
      linkedEntityType: linkType, linkedEntityId: linkId, idempotencyKey: `brief.${key}:${ctx.userId}`,
      ownerUserId: ctx.userId, assignedUserId: ctx.userId,
    });
    msg = { ok: `Task added: ${title}` };
  } catch (e) {
    msg = { error: errMsg(e) };
  }
  revalidatePath("/today");
  back(msg);
}
