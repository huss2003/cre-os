"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/auth/context";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import * as C from "./service";
import { cronFromSimple } from "./cron";

const s = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" ? v.trim() : ""; };
const fail = (e: unknown): ActionState => ({ error: e instanceof C.CommandError ? e.message : errorMessage(e) });
const done = (message: string): ActionState => { revalidatePath("/assistant/commands"); return { ok: true, message }; };

/** inputs textarea: one per line "key | Label | required | default" */
export async function parseInputs(text: string): Promise<C.CommandInput[]> {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [key, label, req, def] = l.split("|").map((x) => x.trim());
    return { key: key.toLowerCase(), label: label || key, required: /^(y|yes|required|true)$/i.test(req ?? ""), default: def || null };
  });
}
async function fields(f: FormData): Promise<C.CommandFields> {
  return { name: s(f, "name"), description: s(f, "description") || null, prompt: s(f, "prompt"), inputs: await parseInputs(s(f, "inputs")), output_format: (s(f, "output_format") || "chat") as "chat" };
}

export async function saveCommandAction(id: string | null, _p: ActionState, f: FormData): Promise<ActionState> {
  let newId: string | null = null;
  try {
    const ctx = await requireContext("editor");
    const c = id ? await C.updateCommand(ctx, id, await fields(f)) : await C.createCommand(ctx, await fields(f));
    newId = id ? null : c.id;
    if (id) return done(`Saved as version ${c.version}.`);
  } catch (e) { return fail(e); }
  revalidatePath("/assistant/commands");
  redirect(`/assistant/commands?edit=${newId}`);
}
export async function addTemplateAction(key: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); const c = await C.addTemplate(ctx, key); return done(`Added "${c.name}".`); } catch (e) { return fail(e); }
}
export async function duplicateAction(id: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); const c = await C.duplicateCommand(ctx, id); return done(`Duplicated as "${c.name}".`); } catch (e) { return fail(e); }
}
export async function deleteAction(id: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await C.archiveCommand(ctx, id); } catch (e) { return fail(e); }
  revalidatePath("/assistant/commands");
  redirect("/assistant/commands");
}
export async function scheduleAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    if (f.get("enabled") !== "1") { await C.setSchedule(ctx, id, { cron: null, enabled: false }); return done("Schedule turned off."); }
    const cron = s(f, "cron") || cronFromSimple(s(f, "time") || "08:00", (s(f, "days") || "weekdays") as "weekdays");
    const c = await C.setSchedule(ctx, id, { cron, enabled: true, confirm: f.get("confirm") === "1", tz: ctx.timezone || "Asia/Kolkata" });
    return done(`Scheduled. Next run ${c.next_run_at ? new Date(c.next_run_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST" : "—"}. Results appear in this command's history; nothing is sent.`);
  } catch (e) { return fail(e); }
}
