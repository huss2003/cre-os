import "server-only";
import type { Db } from "@/lib/supabase/server";
import { resolveSettings, type BriefSettings } from "./settings";
import type { MemberAccess } from "./visibility";

/** Page through PostgREST's max_rows (1000). `build(from,to)` must apply .range(from,to). */
export async function fetchAll<T = any>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  opts: { page?: number; cap?: number } = {},
): Promise<T[]> {
  const page = opts.page ?? 1000;
  const cap = opts.cap ?? 50_000;
  const out: T[] = [];
  for (let from = 0; from < cap; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

export async function loadSettings(db: Db, workspaceId: string, userId?: string | null): Promise<BriefSettings> {
  const [{ data: rows }, prefs] = await Promise.all([
    db.from("workspace_setting").select("key, value").eq("workspace_id", workspaceId).in("key", ["brief", "brief_time", "cohort_targets", "size_rules"]),
    userId
      ? db.from("user_preference").select("prefs").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const map = Object.fromEntries(((rows ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
  return resolveSettings(map.brief, (prefs as { data: { prefs?: unknown } | null }).data?.prefs, map);
}

/** Raw user prefs (for target snoozes etc.). */
export async function loadUserPrefs(db: Db, workspaceId: string, userId: string): Promise<Record<string, unknown>> {
  const { data } = await db.from("user_preference").select("prefs").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  return (data?.prefs as Record<string, unknown>) ?? {};
}

/** Active target snoozes {orgId: untilDate} from user_preference.prefs.snoozedTargets. */
export function activeSnoozes(prefs: Record<string, unknown>, today: string): Set<string> {
  const raw = prefs.snoozedTargets;
  const out = new Set<string>();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [org, until] of Object.entries(raw as Record<string, unknown>)) if (typeof until === "string" && until >= today) out.add(org);
  }
  return out;
}

export async function loadWorkspace(db: Db, workspaceId: string): Promise<{ id: string; timezone: string; name: string; ai_paused: boolean; status: string }> {
  const { data, error } = await db.from("workspace").select("id, timezone, name, ai_paused, status").eq("id", workspaceId).single();
  if (error) throw error;
  return data;
}

/** Membership + shares for job-side visibility filtering (admin client). */
export async function loadMemberAccess(db: Db, workspaceId: string, userId: string): Promise<MemberAccess | null> {
  const { data: m } = await db.from("membership").select("role, allowed_classifications, see_all_accounts")
    .eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  if (!m) return null;
  const { data: shares } = await db.from("record_share").select("entity_type, entity_id").eq("workspace_id", workspaceId).eq("user_id", userId);
  return {
    userId,
    role: m.role,
    allowedClassifications: m.allowed_classifications ?? [],
    seeAllAccounts: !!m.see_all_accounts,
    shares: new Set((shares ?? []).map((s: { entity_type: string; entity_id: string }) => `${s.entity_type}:${s.entity_id}`)),
  };
}

/** Insert a private outbox notification once per dedupe key (at-least-once, no duplicates). Admin client only. */
export async function notify(db: Db, workspaceId: string, userId: string | null, kind: string, dedupeKey: string, payload: Record<string, unknown>) {
  const { error } = await db.from("outbox").upsert(
    { workspace_id: workspaceId, user_id: userId, kind, dedupe_key: dedupeKey, payload },
    { onConflict: "workspace_id,dedupe_key", ignoreDuplicates: true },
  );
  if (error) throw error;
}
