"use server";
import { revalidatePath } from "next/cache";
import { requireAdminApi } from "../guard";
import { errorMessage } from "../http";
import { modesFromForm, saveAiPolicy } from "../ai-policy";
import type { ActionState } from "../ui/client";

/** Admin only (role + owner MFA re-checked). Stale/replayed submits are rejected by version; same values = no-op. */
export async function saveAiPolicyAction(_p: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireAdminApi("admin");
    const reset = form.get("intent") === "reset";
    const r = await saveAiPolicy(ctx.db, ctx.workspaceId, ctx.userId, modesFromForm(form, reset), String(form.get("version") ?? ""));
    revalidatePath("/settings/ai");
    return { ok: true, message: reset ? (r.changed ? `Reset ${r.changed} feature${r.changed === 1 ? "" : "s"} to defaults.` : "All features are already on their defaults.") : r.changed ? `Saved ${r.changed} change${r.changed === 1 ? "" : "s"}.` : "No changes." };
  } catch (e) { return { error: errorMessage(e) }; }
}
