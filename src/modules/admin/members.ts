/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { badRequest, forbidden } from "./errors";

/**
 * Member onboarding. CRE OS never sends email (rule S3): we either create the account with a one-time temporary
 * password, or generate a Supabase invite link — both are shown once to the owner / platform admin to hand over.
 * Account creation needs the service-role client; the authorisation check is explicit (owner of that workspace,
 * or platform admin).
 */
type Client = SupabaseClient<any, any, any>;

export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export const CLASSES = ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"] as const;

export const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(ROLES).default("viewer"),
  displayName: z.string().trim().max(120).optional().nullable(),
  method: z.enum(["invite_link", "temp_password"]).default("temp_password"),
  allowedClassifications: z.array(z.enum(CLASSES)).default(["public", "permitted_personal"]),
  seeAllAccounts: z.boolean().default(false),
});
export type AddMemberInput = z.input<typeof addMemberSchema>;

export interface AddMemberResult {
  userId: string;
  created: boolean;
  method: "invite_link" | "temp_password" | "existing_user";
  tempPassword?: string;
  inviteLink?: string;
}

export function tempPassword() {
  return `${randomBytes(9).toString("base64url")}-${randomBytes(3).toString("hex")}`;
}

export async function isPlatformAdmin(admin: Client, userId: string) {
  const { data } = await admin.from("platform_admin").select("user_id").eq("user_id", userId).maybeSingle();
  return !!data;
}

export async function assertCanManageMembers(admin: Client, actorUserId: string, workspaceId: string) {
  if (await isPlatformAdmin(admin, actorUserId)) return;
  const { data } = await admin.from("membership").select("role").eq("workspace_id", workspaceId).eq("user_id", actorUserId).maybeSingle();
  if (data?.role !== "owner") throw forbidden("only workspace owners or platform admins can add members");
}

export async function addMember(admin: Client, actorUserId: string, workspaceId: string, input: AddMemberInput): Promise<AddMemberResult> {
  await assertCanManageMembers(admin, actorUserId, workspaceId);
  const v = addMemberSchema.parse(input);
  const allowed = v.role === "owner" || v.role === "admin" ? [...CLASSES] : v.allowedClassifications;

  const { data: existingId, error: e0 } = await admin.schema("mudar_app").rpc("user_id_by_email", { p_email: v.email });
  if (e0) throw badRequest(e0.message);
  let userId = existingId as string | null;
  let result: AddMemberResult;
  if (userId) {
    result = { userId, created: false, method: "existing_user" };
  } else if (v.method === "temp_password") {
    const pw = tempPassword();
    const { data, error } = await admin.auth.admin.createUser({
      email: v.email, password: pw, email_confirm: true,
      user_metadata: { display_name: v.displayName ?? null, must_change_password: true },
    });
    if (error || !data.user) throw badRequest(`could not create user: ${error?.message}`);
    userId = data.user.id;
    result = { userId, created: true, method: "temp_password", tempPassword: pw };
  } else {
    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    const { data, error } = await admin.auth.admin.generateLink({
      type: "invite", email: v.email, options: { redirectTo: `${appUrl}/auth/callback?next=/settings/security`, data: { display_name: v.displayName ?? null } },
    });
    if (error || !data.user) throw badRequest(`could not create invite: ${error?.message}`);
    userId = data.user.id;
    result = { userId, created: true, method: "invite_link", inviteLink: data.properties?.action_link };
  }

  const { error: e1 } = await admin.from("membership").upsert({
    workspace_id: workspaceId, user_id: userId, role: v.role, allowed_classifications: allowed,
    see_all_accounts: v.seeAllAccounts || v.role === "owner" || v.role === "admin", display_name: v.displayName ?? null,
  }, { onConflict: "workspace_id,user_id" });
  if (e1) throw badRequest(e1.message);
  await admin.from("tenant_invite").insert({
    workspace_id: workspaceId, email: v.email, role: v.role, method: result.method, invited_by: actorUserId, invited_user_id: userId,
    status: result.method === "existing_user" ? "accepted" : "pending", accepted_at: result.method === "existing_user" ? new Date().toISOString() : null,
  });
  await admin.from("audit_event").insert({
    workspace_id: workspaceId, actor_user_id: actorUserId, actor_kind: "user", action: "member_added", entity_type: "membership", entity_id: userId,
    after: { email: v.email, role: v.role, method: result.method, allowed_classifications: allowed }, classification: "corporate_confidential",
  });
  return result;
}

export const updateMemberSchema = z.object({
  role: z.enum(ROLES),
  allowedClassifications: z.array(z.enum(CLASSES)).min(1),
  seeAllAccounts: z.boolean(),
  displayName: z.string().trim().max(120).nullable().optional(),
});

/** Role/classification changes go through the user's RLS client (owners only by policy). Never leave zero owners. */
export async function updateMember(db: Client, workspaceId: string, actorUserId: string, userId: string, input: z.input<typeof updateMemberSchema>) {
  const v = updateMemberSchema.parse(input);
  const { data: owners } = await db.from("membership").select("user_id").eq("workspace_id", workspaceId).eq("role", "owner");
  const ownerIds = (owners ?? []).map((o) => o.user_id);
  if (v.role !== "owner" && ownerIds.length === 1 && ownerIds[0] === userId) throw badRequest("a workspace must keep at least one owner");
  const { data, error } = await db.from("membership").update({
    role: v.role, allowed_classifications: v.role === "owner" || v.role === "admin" ? [...CLASSES] : v.allowedClassifications,
    see_all_accounts: v.seeAllAccounts || v.role === "owner" || v.role === "admin", display_name: v.displayName ?? null,
  }).eq("workspace_id", workspaceId).eq("user_id", userId).select("user_id");
  if (error) throw badRequest(error.message);
  if (!data?.length) throw forbidden("only owners can change roles");
  return { ok: true, actorUserId, role: v.role };
}

export async function removeMember(db: Client, workspaceId: string, actorUserId: string, userId: string) {
  if (userId === actorUserId) throw badRequest("you cannot remove yourself");
  const { data: target } = await db.from("membership").select("role").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  if (!target) throw badRequest("not a member");
  if (target.role === "owner") {
    const { count } = await db.from("membership").select("user_id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("role", "owner");
    if ((count ?? 0) <= 1) throw badRequest("a workspace must keep at least one owner");
  }
  const { data, error } = await db.from("membership").delete().eq("workspace_id", workspaceId).eq("user_id", userId).select("user_id");
  if (error) throw badRequest(error.message);
  if (!data?.length) throw forbidden("only owners can remove members");
  // Remove explicit shares too, so a later re-invite starts with no account access.
  await db.from("record_share").delete().eq("workspace_id", workspaceId).eq("user_id", userId);
}
