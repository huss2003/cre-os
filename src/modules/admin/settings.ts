/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { badRequest } from "./errors";

type Client = SupabaseClient<any, "public", any>;

/**
 * Tenant configuration. Workspace columns (name/timezone/currency/AI budget) live on `workspace` (owner-writable);
 * operating rules live in `workspace_setting` under the keys below (admin-writable). Other modules read these keys.
 */
export const SETTING_KEYS = {
  sizeRules: "size_rules",          // { min_sf, max_sf }  (spec: strict 5,000 / 200,000 boundaries)
  cohortTargets: "cohort_targets",  // { approaches_per_month_min, approaches_per_month_pace }  (120 / 170)
  briefTime: "brief_time",          // { time: "08:00", debrief_time: "20:30" }
} as const;

export const DEFAULT_SETTINGS = {
  size_rules: { min_sf: 5000, max_sf: 200000 },
  cohort_targets: { approaches_per_month_min: 120, approaches_per_month_pace: 170 },
  brief_time: { time: "08:00", debrief_time: "20:30" },
};

/**
 * Tenant-editable general settings (owners): name, timezone, currency. After core hardening (security-review M1,
 * app.workspace_guard) status, slug and the AI budget are changed only by platform admins
 * (/platform, platform.ts updateTenantSettings / setTenantStatus); ai_paused only via app.set_ai_paused.
 */
export const generalSchema = z.object({
  name: z.string().trim().min(2).max(120),
  timezone: z.string().trim().min(3).max(64).refine((tz) => {
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
  }, "unknown IANA timezone"),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "3-letter ISO currency").optional(),
});

export const rulesSchema = z.object({
  min_sf: z.coerce.number().int().positive(),
  max_sf: z.coerce.number().int().positive(),
  approaches_per_month_min: z.coerce.number().int().min(0).max(10_000),
  approaches_per_month_pace: z.coerce.number().int().min(0).max(10_000),
  brief_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM"),
  debrief_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM"),
}).refine((v) => v.min_sf < v.max_sf, { message: "min size must be below max size", path: ["min_sf"] });

export async function getSettings(db: Client, workspaceId: string) {
  const [{ data: ws }, { data: rows }] = await Promise.all([
    db.from("workspace").select("id, name, slug, timezone, currency, status, ai_paused, monthly_ai_budget_inr").eq("id", workspaceId).single(),
    db.from("workspace_setting").select("key, value, updated_at").eq("workspace_id", workspaceId),
  ]);
  const map = Object.fromEntries(((rows ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
  return {
    workspace: ws as Record<string, any>,
    sizeRules: { ...DEFAULT_SETTINGS.size_rules, ...(map[SETTING_KEYS.sizeRules] as object | undefined) },
    cohortTargets: { ...DEFAULT_SETTINGS.cohort_targets, ...(map[SETTING_KEYS.cohortTargets] as object | undefined) },
    briefTime: { ...DEFAULT_SETTINGS.brief_time, ...(map[SETTING_KEYS.briefTime] as object | undefined) },
    raw: map,
  };
}

export async function saveGeneral(db: Client, workspaceId: string, input: unknown) {
  const v = generalSchema.parse(input);
  const { data, error } = await db.from("workspace").update({ name: v.name, timezone: v.timezone, ...(v.currency ? { currency: v.currency } : {}) }).eq("id", workspaceId).select("id");
  if (error) throw badRequest(error.message);
  if (!data?.length) throw badRequest("only workspace owners can change general settings");
}

export async function saveRules(db: Client, workspaceId: string, input: unknown) {
  const v = rulesSchema.parse(input);
  const now = new Date().toISOString();
  const rows = [
    { workspace_id: workspaceId, key: SETTING_KEYS.sizeRules, value: { min_sf: v.min_sf, max_sf: v.max_sf }, updated_at: now },
    { workspace_id: workspaceId, key: SETTING_KEYS.cohortTargets, value: { approaches_per_month_min: v.approaches_per_month_min, approaches_per_month_pace: v.approaches_per_month_pace }, updated_at: now },
    { workspace_id: workspaceId, key: SETTING_KEYS.briefTime, value: { time: v.brief_time, debrief_time: v.debrief_time }, updated_at: now },
  ];
  const { error } = await db.from("workspace_setting").upsert(rows, { onConflict: "workspace_id,key" });
  if (error) throw badRequest(error.message);
}

// ------------------------------------------------------------------ retention (spec §14 proposed defaults — proposals for approval, not legal minima)
export interface RetentionDefault { category: string; label: string; retain_days: number | null; basis: string; review_cadence?: string }
export const RETENTION_DEFAULTS: RetentionDefault[] = [
  { category: "raw_audio", label: "Raw consented call/voice audio", retain_days: 30, basis: "after transcript verification" },
  { category: "working_transcripts", label: "Working transcripts", retain_days: 180, basis: "after creation, unless deal/legal policy requires otherwise" },
  { category: "research_downloads", label: "Temporary research downloads", retain_days: 30, basis: "after download" },
  { category: "public_fact_observations", label: "Public fact observations", retain_days: null, basis: "retained with provenance and staleness labels" },
  { category: "contact_relationship_records", label: "Contact & relationship records", retain_days: null, basis: "kept while relevant", review_cadence: "review at least annually" },
  { category: "audit_records", label: "Audit records", retain_days: 365, basis: "12 months or applicable corporate requirement" },
];

export async function getRetention(db: Client, workspaceId: string) {
  const { data } = await db.from("retention_policy").select("*").eq("workspace_id", workspaceId);
  const rows = (data ?? []) as Record<string, any>[];
  return RETENTION_DEFAULTS.map((d): Record<string, any> & RetentionDefault & { saved: boolean; isDefault: boolean } => {
    const saved = rows.find((r) => r.category === d.category);
    return { ...d, ...(saved ?? {}), label: d.label, saved: !!saved, isDefault: !saved };
  });
}

export function retentionDefault(category: string) {
  return RETENTION_DEFAULTS.find((d) => d.category === category) ?? null;
}

export function retentionSeedRows(workspaceId: string) {
  return RETENTION_DEFAULTS.map((d) => ({
    workspace_id: workspaceId, category: d.category, retain_days: d.retain_days, basis: d.basis, review_cadence: d.review_cadence ?? null,
    note: "Spec §14 proposed default — confirm with counsel/corporate policy",
  }));
}

export async function saveRetention(db: Client, workspaceId: string, userId: string,
  items: { category: string; retain_days: number | null; legal_hold: boolean; note?: string | null }[]) {
  const now = new Date().toISOString();
  const rows = items.map((i) => {
    const d = RETENTION_DEFAULTS.find((x) => x.category === i.category);
    if (!d) throw badRequest(`unknown retention category ${i.category}`);
    if (i.retain_days !== null && (!Number.isInteger(i.retain_days) || i.retain_days <= 0)) throw badRequest(`${i.category}: days must be a positive integer or blank`);
    return { workspace_id: workspaceId, category: i.category, retain_days: i.retain_days, basis: d.basis, review_cadence: d.review_cadence ?? null,
      legal_hold: i.legal_hold, note: i.note ?? null, approved_by: userId, approved_at: now, updated_at: now };
  });
  const { error } = await db.from("retention_policy").upsert(rows, { onConflict: "workspace_id,category" });
  if (error) throw badRequest(error.message);
}
