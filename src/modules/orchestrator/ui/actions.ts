"use server";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/auth/context";
import type { ActionState } from "@/modules/changes/ui/client";
import { AutomationError, markControl, runControl, workflowControl, type Actor, type RunAction } from "./service";

/** Server actions for the Automation pages. Role checks live in the service (admin-only controls). */
const UUID = /^[0-9a-f-]{36}$/i;
const KEY = /^[a-z0-9_.-]{1,120}$/i;
async function actor(): Promise<Actor> {
  const ctx = await requireContext("viewer");
  return { db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId, role: ctx.role, timezone: ctx.timezone };
}
const msg = (e: unknown) => (e instanceof AutomationError || e instanceof Error ? e.message : "Something went wrong.");
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

const DONE: Record<string, string> = {
  pause: "Paused.", resume: "Switched on again.", schedule: "Schedule saved.", priority: "Priority saved.", cancel: "Cancelled — finished steps are kept.",
  retry: "Retry started — finished steps are kept.", continue: "Checked for work that can run now.",
};

export async function workflowAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let runId: string | null = null;
  try {
    const key = str(form, "key"); const op = str(form, "op");
    if (!KEY.test(key)) throw new Error("Unknown workflow.");
    const a = await actor();
    if (op === "schedule") {
      const raw = str(form, "everyMinutes"); const unit = Number(str(form, "unit") || "1");
      await workflowControl(a, key, { action: "schedule", everyMinutes: raw ? Math.round(Number(raw) * unit) : null });
    } else if (op === "priority") await workflowControl(a, key, { action: "priority", priority: Number(str(form, "priority")) });
    else if (op === "pause" || op === "resume") await workflowControl(a, key, { action: op });
    else if (op === "start") {
      const date = str(form, "date");
      const r = await workflowControl(a, key, { action: "start", input: date ? { date, tz: a.timezone ?? "Asia/Kolkata", generateBriefs: true } : {} });
      runId = (r as { runId: string }).runId;
    } else throw new Error("Unknown action.");
    refresh();
    if (!runId) return { ok: true, message: DONE[op] };
  } catch (e) { return { error: msg(e) }; }
  redirect(`/automation/runs/${runId}`);
}

export async function runAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const id = str(form, "id"); const op = str(form, "op");
    if (!UUID.test(id)) throw new Error("Unknown run.");
    const body: RunAction = op === "priority" ? { action: "priority", priority: Number(str(form, "priority")) } : { action: op as Exclude<RunAction["action"], "priority"> };
    if (!["pause", "resume", "cancel", "retry", "continue", "priority"].includes(op)) throw new Error("Unknown action.");
    await runControl(await actor(), id, body);
    refresh();
    return { ok: true, message: DONE[op] };
  } catch (e) { return { error: msg(e) }; }
}

/** Banner on analysis / deliverable / requirement pages. Refresh → opens the run that did the work. */
export async function markAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let runId: string | null = null;
  try {
    const id = str(form, "id"); const op = str(form, "op");
    if (!UUID.test(id)) throw new Error("Unknown warning.");
    if (op !== "refresh" && op !== "dismiss") throw new Error("Unknown action.");
    const r = await markControl(await actor(), id, { action: op });
    refresh();
    if (op === "dismiss") return { ok: true, message: "Warning dismissed (kept in history)." };
    if (r.state === "resolved") return { ok: true, message: "Refreshed — the record is up to date." };
    runId = r.runId;
  } catch (e) { return { error: msg(e) }; }
  if (runId) redirect(`/automation/runs/${runId}`);
  return { ok: true, message: "Nothing to refresh." };
}
