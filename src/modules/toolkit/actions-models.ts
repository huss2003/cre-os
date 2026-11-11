"use server";
/** Server actions: §8.11 specialist models (BTS, investment). */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/auth/context";
import type { ActionState } from "@/modules/admin/ui/client";
import { btsFromForm, investmentFromForm, runBts, runInvestment } from "./models-service";

const getter = (f: FormData) => (k: string) => { const v = f.get(k); return typeof v === "string" && v.trim() ? v.trim() : null; };
const msg = (e: unknown) => (e instanceof Error ? e.message : "Could not save.");

export async function saveBtsAction(_p: ActionState, f: FormData): Promise<ActionState> {
  let id: string;
  try {
    const ctx = await requireContext("editor"); const g = getter(f);
    const r = await runBts(ctx.db, ctx.workspaceId, ctx.userId, { id: g("id"), title: g("title") ?? "Built-to-suit model", requirementId: g("requirement_id"), note: g("note") }, btsFromForm(g));
    id = r.id;
  } catch (e) { return { error: msg(e) }; }
  revalidatePath("/toolkit/bts");
  redirect(`/toolkit/bts/${id}`);
}

export async function saveInvestmentAction(_p: ActionState, f: FormData): Promise<ActionState> {
  let id: string;
  try {
    const ctx = await requireContext("editor"); const g = getter(f);
    const r = await runInvestment(ctx.db, ctx.workspaceId, ctx.userId, { id: g("id"), title: g("title") ?? "Investment analysis", requirementId: g("requirement_id"), note: g("note") }, investmentFromForm(g));
    id = r.id;
  } catch (e) { return { error: msg(e) }; }
  revalidatePath("/toolkit/investment");
  redirect(`/toolkit/investment/${id}`);
}
