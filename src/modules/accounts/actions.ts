"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import { AccountError, setLevel } from "./service";

/** Manual relationship-level setter (spec 2.3). Appends history; never overwrites. */
export async function setLevelAction(personId: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const level = String(f.get("level") ?? "");
    const reason = String(f.get("reason") ?? "");
    const r = await setLevel(ctx.db, ctx.workspaceId, ctx.userId, personId, level, reason, f.get("accepted") === "1");
    revalidatePath(`/people/${personId}`);
    return { ok: true, message: r.unchanged ? "Already at that level." : "Relationship level saved." };
  } catch (e) { return { error: e instanceof AccountError ? e.message : errorMessage(e) }; }
}
