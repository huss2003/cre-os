"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import { rebuildStyleProfile, setStyleEnabled } from "./style";

const done = (message: string): ActionState => { revalidatePath("/assistant/memory"); return { ok: true, message }; };

/** Rebuild the caller's own writing-style profile now (user client, RLS owner-only). */
export async function rebuildStyleAction(): Promise<ActionState> {
  try {
    const ctx = await requireContext();
    await setStyleEnabled(ctx.db, ctx.workspaceId, ctx.userId, true);
    const r = await rebuildStyleProfile(ctx.db, ctx.workspaceId, ctx.userId);
    return done("profile" in r && r.profile?.sample_count ? `Rebuilt from ${r.profile.sample_count} of your messages.` : "Rebuilt — no messages of yours found yet.");
  } catch (e) { return { error: errorMessage(e) }; }
}
export async function turnOffStyleAction(): Promise<ActionState> {
  try { const ctx = await requireContext(); await setStyleEnabled(ctx.db, ctx.workspaceId, ctx.userId, false); return done("Writing-style matching is off and the profile was cleared."); }
  catch (e) { return { error: errorMessage(e) }; }
}
