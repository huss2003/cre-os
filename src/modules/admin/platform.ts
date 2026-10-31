/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { forbidden, badRequest, notFound } from "./errors";
import { addMember, isPlatformAdmin, type AddMemberResult } from "./members";
import { DEFAULT_SETTINGS, SETTING_KEYS, retentionSeedRows } from "./settings";
import { PRICING } from "@/lib/ai/pricing";

/**
 * Platform (agency) administration: tenants are onboarded manually by platform admins — no self-serve signup or
 * billing. Uses the SERVICE-ROLE client; every function first checks platform_admin for the acting user (rule S2)
 * and filters by workspace id explicitly.
 */
type Admin = SupabaseClient<any, any, any>;

export async function assertPlatformAdmin(admin: Admin, actorUserId: string | null | undefined) {
  if (!actorUserId || !(await isPlatformAdmin(admin, actorUserId))) throw forbidden("platform admin only");
}

export const createTenantSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, "lowercase letters, digits and dashes"),
  timezone: z.string().trim().default("Asia/Kolkata"),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).default("INR"),
  monthlyAiBudgetInr: z.coerce.number().min(0).default(3000),
  ownerEmail: z.string().trim().toLowerCase().email(),
  ownerName: z.string().trim().max(120).optional().nullable(),
  method: z.enum(["invite_link", "temp_password"]).default("invite_link"),
});
export type CreateTenantInput = z.input<typeof createTenantSchema>;

export async function createTenant(admin: Admin, actorUserId: string, input: CreateTenantInput): Promise<{ workspace: Record<string, any>; owner: AddMemberResult }> {
  await assertPlatformAdmin(admin, actorUserId);
  const v = createTenantSchema.parse(input);
  const { data: ws, error } = await admin.from("workspace").insert({
    name: v.name, slug: v.slug, timezone: v.timezone, currency: v.currency, monthly_ai_budget_inr: v.monthlyAiBudgetInr,
  }).select().single();
  if (error) throw badRequest(error.code === "23505" ? "slug already in use" : error.message);
  try {
    await admin.from("workspace_setting").insert([
      { workspace_id: ws.id, key: SETTING_KEYS.sizeRules, value: DEFAULT_SETTINGS.size_rules },
      { workspace_id: ws.id, key: SETTING_KEYS.cohortTargets, value: DEFAULT_SETTINGS.cohort_targets },
      { workspace_id: ws.id, key: SETTING_KEYS.briefTime, value: DEFAULT_SETTINGS.brief_time },
    ]);
    await admin.from("retention_policy").insert(retentionSeedRows(ws.id));
    const owner = await addMember(admin, actorUserId, ws.id, {
      email: v.ownerEmail, role: "owner", displayName: v.ownerName ?? null, method: v.method,
    });
    await admin.from("audit_event").insert({
      workspace_id: ws.id, actor_user_id: actorUserId, actor_kind: "user", action: "tenant_created", entity_type: "workspace", entity_id: ws.id,
      after: { name: v.name, slug: v.slug, owner_email: v.ownerEmail }, classification: "corporate_confidential",
    });
    return { workspace: ws, owner };
  } catch (e) {
    await admin.from("workspace").delete().eq("id", ws.id); // roll back a half-created tenant (cascades)
    throw e;
  }
}

export const TENANT_STATUSES = ["active", "paused", "suspended", "archived"] as const;

/** Suspend/pause/reactivate a tenant. Paused or suspended tenants also get ai_paused so the AI gateway refuses calls. */
export async function setTenantStatus(admin: Admin, actorUserId: string, workspaceId: string, status: (typeof TENANT_STATUSES)[number], reason?: string) {
  await assertPlatformAdmin(admin, actorUserId);
  if (!TENANT_STATUSES.includes(status)) throw badRequest("invalid status");
  const { data: before } = await admin.from("workspace").select("status, ai_paused").eq("id", workspaceId).maybeSingle();
  if (!before) throw notFound("workspace");
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status !== "active") patch.ai_paused = true;
  const { error } = await admin.from("workspace").update(patch).eq("id", workspaceId);
  if (error) throw badRequest(error.message);
  await admin.from("audit_event").insert({
    workspace_id: workspaceId, actor_user_id: actorUserId, actor_kind: "user", action: `tenant_${status}`, entity_type: "workspace", entity_id: workspaceId,
    before, after: { ...patch, reason: reason ?? null }, classification: "corporate_confidential",
  });
}

export const tenantSettingsSchema = z.object({
  monthlyAiBudgetInr: z.coerce.number().min(0).max(10_000_000),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "3-letter ISO currency"),
});

/** Platform-only tenant settings (AI budget, currency). Owners cannot change these (security-review M1). */
export async function updateTenantSettings(admin: Admin, actorUserId: string, workspaceId: string, input: z.input<typeof tenantSettingsSchema>) {
  await assertPlatformAdmin(admin, actorUserId);
  const v = tenantSettingsSchema.parse(input);
  const { data: before } = await admin.from("workspace").select("monthly_ai_budget_inr, currency").eq("id", workspaceId).maybeSingle();
  if (!before) throw notFound("workspace");
  const after = { monthly_ai_budget_inr: v.monthlyAiBudgetInr, currency: v.currency, updated_at: new Date().toISOString() };
  const { error } = await admin.from("workspace").update(after).eq("id", workspaceId);
  if (error) throw badRequest(error.message);
  await admin.from("audit_event").insert({
    workspace_id: workspaceId, actor_user_id: actorUserId, actor_kind: "user", action: "tenant_settings", entity_type: "workspace", entity_id: workspaceId,
    before, after, classification: "corporate_confidential",
  });
}

const COUNTED = ["organisation", "person", "asset", "requirement", "opportunity", "interaction", "task", "source_object"] as const;

export async function tenantUsage(admin: Admin, actorUserId: string, workspaceId: string, now = new Date()) {
  await assertPlatformAdmin(admin, actorUserId);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const count = async (table: string) => {
    const { count } = await admin.from(table).select("*", { count: "exact", head: true }).eq("workspace_id", workspaceId);
    return [table, count ?? 0] as const;
  };
  const [{ data: ws }, { data: members }, records, usage, { data: lastExport }] = await Promise.all([
    admin.from("workspace").select("*").eq("id", workspaceId).maybeSingle(),
    admin.from("membership").select("user_id, role, display_name, created_at").eq("workspace_id", workspaceId),
    Promise.all(COUNTED.map(count)),
    (async () => {
      let usd = 0, calls = 0;
      for (let from = 0; from < 50_000; from += 1000) {
        const { data } = await admin.from("model_usage").select("estimated_usd").eq("workspace_id", workspaceId).gte("occurred_at", monthStart).order("id").range(from, from + 999);
        (data ?? []).forEach((r) => { usd += Number(r.estimated_usd) || 0; calls += 1; });
        if (!data || data.length < 1000) break;
      }
      return { usd, calls };
    })(),
    admin.from("backup_run").select("started_at, status").eq("workspace_id", workspaceId).eq("kind", "logical_export").order("started_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!ws) throw notFound("workspace");
  return {
    workspace: ws,
    members: (members ?? []) as Record<string, any>[],
    records: Object.fromEntries(records) as Record<string, number>,
    aiSpend: { usd: usage.usd, inr: usage.usd * PRICING.fxInrPerUsd, calls: usage.calls, budgetInr: Number(ws.monthly_ai_budget_inr ?? 0) },
    lastExport: lastExport ?? null,
  };
}

export async function listTenants(admin: Admin, actorUserId: string) {
  await assertPlatformAdmin(admin, actorUserId);
  const { data: list, error } = await admin.from("workspace").select("*").order("created_at", { ascending: true });
  if (error) throw badRequest(error.message);
  return Promise.all(((list ?? []) as Record<string, any>[]).map(async (w): Promise<Record<string, any> & { memberCount: number; records: Record<string, number>; aiSpend: { usd: number; inr: number; calls: number; budgetInr: number }; lastExport: Record<string, any> | null }> => {
    const u = await tenantUsage(admin, actorUserId, w.id);
    return { ...w, memberCount: u.members.length, records: u.records, aiSpend: u.aiSpend, lastExport: u.lastExport };
  }));
}
