"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import * as M from "./service";

const s = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" ? v.trim() : ""; };
const fail = (e: unknown): ActionState => ({ error: e instanceof M.MemoryError ? e.message : errorMessage(e) });
const done = (message: string): ActionState => { revalidatePath("/assistant/memory"); return { ok: true, message }; };

export async function correctAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const content = s(f, "content"); if (!content) return { error: "Write the corrected memory." };
    const ctx = await requireContext("editor");
    await M.correctMemory(ctx, id, content, { source: "user", sourceRef: { via: "memory_page", note: s(f, "note") || undefined }, providedBy: s(f, "provided_by") || "user", stated: f.get("inferred") !== "1" });
    return done("Corrected. The previous version is kept in the history.");
  } catch (e) { return fail(e); }
}
export async function verifyAction(id: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await M.verifyMemory(ctx, id); return done("Marked as verified today. Next review in 180 days."); } catch (e) { return fail(e); }
}
export async function restrictAction(id: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await M.restrictMemory(ctx, id); return done("Restricted — the assistant won't use it unless you explicitly ask."); } catch (e) { return fail(e); }
}
export async function forgetAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    if (f.get("confirm") !== "1") return { error: "Tick the box to confirm. Forgetting can't be undone." };
    const ctx = await requireContext("editor"); await M.forgetMemory(ctx, id); return done("Forgotten.");
  } catch (e) { return fail(e); }
}
