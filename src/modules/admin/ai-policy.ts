import "server-only";
import type { Db } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { HttpError } from "@/lib/auth/context";
import { AI_MODES_SETTING_KEY, FEATURE_KEYS, FEATURES, defaultModes, isAiMode, resolveModes, type AiMode, type FeatureKey } from "@/lib/ai/policy";

/** /settings/ai — per-feature AI switch. Stored as workspace_setting 'ai.modes' = { featureKey: mode } (only overrides). */

export async function loadAiPolicy(db: Db, workspaceId: string) {
  const { data } = await db.from("workspace_setting").select("value, updated_at").eq("workspace_id", workspaceId).eq("key", AI_MODES_SETTING_KEY).maybeSingle();
  const modes = resolveModes(data?.value);
  const aiCount = FEATURE_KEYS.filter((k) => modes[k] !== "off").length;
  return { modes, version: (data?.updated_at as string | undefined) ?? "", aiCount, codeOnlyCount: FEATURE_KEYS.length - aiCount };
}

/** Parse the form: one field `mode_<featureKey>` per feature. Missing/invalid → default. */
export function modesFromForm(form: FormData, reset = false): Record<FeatureKey, AiMode> {
  const out = defaultModes();
  if (reset) return out;
  for (const k of FEATURE_KEYS) { const v = form.get(`mode_${k}`); if (isAiMode(v)) out[k] = v; }
  return out;
}

/** Only non-default values are stored so later default changes reach untouched features. */
export function overridesOnly(modes: Record<FeatureKey, AiMode>): Partial<Record<FeatureKey, AiMode>> {
  return Object.fromEntries(FEATURE_KEYS.filter((k) => modes[k] !== FEATURES[k].default).map((k) => [k, modes[k]]));
}

/**
 * Save (admin, via RLS on ctx.db). Optimistic: `expectedVersion` is the updated_at the form was rendered with; a stale
 * or replayed submit that would change something is rejected (idempotent: re-saving the same values is a no-op).
 */
export async function saveAiPolicy(db: Db, workspaceId: string, userId: string, modes: Record<FeatureKey, AiMode>, expectedVersion: string) {
  const cur = await loadAiPolicy(db, workspaceId);
  const changed = FEATURE_KEYS.filter((k) => cur.modes[k] !== modes[k]);
  if (!changed.length) return { changed: 0 };
  if (expectedVersion !== cur.version) throw new HttpError(409, "conflict: AI settings changed since you opened this page — reload and try again");
  const value = overridesOnly(modes);
  const { error } = await db.from("workspace_setting").upsert({ workspace_id: workspaceId, key: AI_MODES_SETTING_KEY, value, updated_at: new Date().toISOString() }, { onConflict: "workspace_id,key" });
  if (error) throw new HttpError(400, error.message);
  // audit_event is not user-writable; service role with explicit workspace_id (S2).
  await createAdminClient().from("audit_event").insert({
    workspace_id: workspaceId, actor_user_id: userId, actor_kind: "user", action: "update", entity_type: "ai_policy",
    before: Object.fromEntries(changed.map((k) => [k, cur.modes[k]])), after: Object.fromEntries(changed.map((k) => [k, modes[k]])),
    classification: "corporate_confidential",
  });
  return { changed: changed.length };
}

/** Calls avoided this month (gateway counter in resource_usage). Admin-only table; returns null if unreadable. */
export async function callsAvoidedThisMonth(db: Db, workspaceId: string): Promise<number | null> {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const { data, error } = await db.from("resource_usage").select("units").eq("workspace_id", workspaceId).eq("module", "ai").eq("unit", "calls_saved").gte("occurred_at", start.toISOString());
  if (error) return null;
  return ((data ?? []) as { units: number | string }[]).reduce((s, r) => s + Number(r.units), 0);
}
