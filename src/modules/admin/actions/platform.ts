"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformApi } from "../guard";
import { errorMessage } from "../http";
import { createTenant, setTenantStatus, updateTenantSettings, TENANT_STATUSES } from "../platform";
import { addMember, ROLES } from "../members";
import type { ActionState } from "../ui/client";

/* Platform (agency) actions. Service-role client, but every service function re-checks platform_admin (S2). */

export async function createTenantAction(_p: ActionState, form: FormData): Promise<ActionState> {
  let res;
  try {
    const ctx = await requirePlatformApi();
    res = await createTenant(createAdminClient(), ctx.userId, {
      name: String(form.get("name") ?? ""), slug: String(form.get("slug") ?? ""),
      timezone: String(form.get("timezone") || "Asia/Kolkata"), currency: String(form.get("currency") || "INR"),
      monthlyAiBudgetInr: Number(form.get("budget") || 3000),
      ownerEmail: String(form.get("owner_email") ?? ""), ownerName: (form.get("owner_name") as string) || null,
      method: form.get("method") === "temp_password" ? "temp_password" : "invite_link",
    });
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidatePath("/platform");
  const secret = res.owner.tempPassword ? { label: "Owner temporary password", value: res.owner.tempPassword }
    : res.owner.inviteLink ? { label: "Owner invite link", value: res.owner.inviteLink } : undefined;
  if (!secret) redirect(`/platform/${res.workspace.id}`);
  return { ok: true, message: `Tenant “${res.workspace.name}” created with default rules and retention proposals.`, secret };
}

export async function setTenantStatusAction(workspaceId: string, _p: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requirePlatformApi();
    const status = String(form.get("status")) as (typeof TENANT_STATUSES)[number];
    await setTenantStatus(createAdminClient(), ctx.userId, workspaceId, status, (form.get("reason") as string) || undefined);
    revalidatePath(`/platform/${workspaceId}`);
    return { ok: true, message: status === "active" ? "Tenant reactivated. AI stays paused until a tenant admin resumes it from Health." : `Tenant ${status}; AI and ingestion paused.` };
  } catch (e) { return { error: errorMessage(e) }; }
}

export async function updateTenantSettingsAction(workspaceId: string, _p: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requirePlatformApi();
    await updateTenantSettings(createAdminClient(), ctx.userId, workspaceId, { monthlyAiBudgetInr: Number(form.get("budget")), currency: String(form.get("currency") ?? "") });
    revalidatePath(`/platform/${workspaceId}`);
    return { ok: true, message: "Budget and currency saved." };
  } catch (e) { return { error: errorMessage(e) }; }
}

export async function platformAddMemberAction(workspaceId: string, _p: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requirePlatformApi();
    const role = String(form.get("role") ?? "owner");
    if (!(ROLES as readonly string[]).includes(role)) return { error: "invalid role" };
    const res = await addMember(createAdminClient(), ctx.userId, workspaceId, {
      email: String(form.get("email") ?? ""), role: role as never, displayName: (form.get("display_name") as string) || null,
      method: form.get("method") === "temp_password" ? "temp_password" : "invite_link",
    });
    revalidatePath(`/platform/${workspaceId}`);
    if (res.tempPassword) return { ok: true, message: "Member added.", secret: { label: "Temporary password", value: res.tempPassword } };
    if (res.inviteLink) return { ok: true, message: "Member added.", secret: { label: "Invite link", value: res.inviteLink } };
    return { ok: true, message: "Existing user added." };
  } catch (e) { return { error: errorMessage(e) }; }
}
