"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/auth/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { URGENT_CATEGORIES } from "@/modules/integrations/alerts";
import { connectMock, disconnect } from "@/modules/integrations/oauth";
import { syncResource, type Resource } from "@/modules/integrations/sync";
import type { ConnectorAccountRow } from "@/modules/integrations/tokens";

/*
 * Connector tokens are deliberately not writable by app users, so these actions use the service-role client —
 * always for the signed-in user's OWN connector in the CURRENT workspace (explicit user_id + workspace_id filters).
 */
const provider = (v: FormDataEntryValue | null) => (v === "microsoft" || v === "google" ? v : null);

export async function connectMockAction(form: FormData) {
  const ctx = await requireContext("editor");
  const p = provider(form.get("provider"));
  if (!p) redirect("/settings/connections?error=unknown_provider");
  const { accountId } = await connectMock(createAdminClient(), { provider: p, userId: ctx.userId, workspaceId: ctx.workspaceId });
  await runSync(ctx.userId, ctx.workspaceId, accountId);
  revalidatePath("/settings/connections");
  redirect(`/settings/connections?connected=${p}&mock=1`);
}

export async function disconnectAction(form: FormData) {
  const ctx = await requireContext("viewer");
  const p = provider(form.get("provider"));
  if (!p) redirect("/settings/connections?error=unknown_provider");
  await disconnect(createAdminClient(), { provider: p, userId: ctx.userId, workspaceId: ctx.workspaceId });
  revalidatePath("/settings/connections");
  redirect(`/settings/connections?disconnected=${p}`);
}

async function runSync(userId: string, workspaceId: string, accountId: string) {
  const admin = createAdminClient();
  const { data } = await admin.from("connector_account").select("*").eq("workspace_id", workspaceId).eq("user_id", userId).eq("id", accountId).maybeSingle();
  if (!data) return [];
  const out: string[] = [];
  for (const r of ["inbox", "calendar", "sent"] as Resource[]) {
    try {
      const res = await syncResource(admin, data as ConnectorAccountRow, r);
      out.push(`${r}:${res.status}`);
    } catch (e) {
      console.error(`sync ${r} failed`, e);
      out.push(`${r}:error`);
    }
  }
  return out;
}

/** "Sync now" for your own connector (runs the same code as the scheduled jobs). */
export async function syncNowAction(form: FormData) {
  const ctx = await requireContext("editor");
  const accountId = String(form.get("account_id") ?? "");
  const res = await runSync(ctx.userId, ctx.workspaceId, accountId);
  revalidatePath("/settings/connections");
  redirect(`/settings/connections?synced=${encodeURIComponent(res.join(","))}`);
}

/** Urgent alert opt-in + do-not-disturb window (private notifications to you only; never an automatic reply). */
export async function saveAlertPrefsAction(form: FormData) {
  const ctx = await requireContext("viewer");
  const cats = URGENT_CATEGORIES.filter((c) => form.get(`cat_${c}`) === "on");
  const hhmm = (v: FormDataEntryValue | null, d: string) => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : d);
  const { data: cur } = await ctx.db.from("user_preference").select("prefs").eq("workspace_id", ctx.workspaceId).eq("user_id", ctx.userId).maybeSingle();
  const prefs = { ...((cur?.prefs as Record<string, unknown>) ?? {}), urgent_categories: cats,
    dnd: form.get("dnd_off") === "on" ? null : { start: hhmm(form.get("dnd_start"), "22:00"), end: hhmm(form.get("dnd_end"), "07:00") } };
  const { error } = await ctx.db.from("user_preference").upsert({ workspace_id: ctx.workspaceId, user_id: ctx.userId, prefs }, { onConflict: "workspace_id,user_id" });
  if (error) throw error;
  revalidatePath("/settings/connections");
  redirect("/settings/connections?saved=alerts");
}
