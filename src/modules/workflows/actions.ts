"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { enqueue } from "@/lib/jobs/queue";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import { setSettings } from "./service";
import { isSettingKey } from "./rules";

export async function toggleWorkflowAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("admin");
    const key = String(f.get("key"));
    if (!isSettingKey(key)) return { error: "Unknown automation." };
    await setSettings(ctx.db, ctx.workspaceId, { [key]: f.get("on") === "1" });
    revalidatePath("/workflows");
    return { ok: true, message: "Saved." };
  } catch (e) { return { error: errorMessage(e) }; }
}

/** Queue a sweep now (same job the scheduler runs; deduped per minute). */
export async function runNowAction(_p: ActionState, _f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    await enqueue({ workspaceId: ctx.workspaceId, type: "workflows.sweep", dedupeKey: `workflows.sweep:${ctx.workspaceId}:manual:${Math.floor(Date.now() / 60_000)}`, maxAttempts: 2 });
    revalidatePath("/workflows");
    return { ok: true, message: "Queued — results appear here within a few minutes." };
  } catch (e) { return { error: errorMessage(e) }; }
}
