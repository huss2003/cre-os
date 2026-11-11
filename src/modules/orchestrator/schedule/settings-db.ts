import "server-only";
import type { Db } from "@/lib/supabase/server";
import { resolveOrchSettings, type OrchSettings } from "./settings";

/** Settings for one user (or workspace defaults when userId is null). Works with ctx.db or the admin client. */
export async function loadOrchSettings(db: Db, ws: string, userId: string | null): Promise<OrchSettings> {
  const [{ data: w }, { data: rows }, prefs] = await Promise.all([
    db.from("workspace").select("timezone").eq("id", ws).maybeSingle(),
    db.from("workspace_setting").select("key, value").eq("workspace_id", ws).in("key", ["brief", "orchestrator", "brief_time", "cohort_targets", "size_rules"]),
    userId ? db.from("user_preference").select("prefs").eq("workspace_id", ws).eq("user_id", userId).maybeSingle().then((r: any) => r.data?.prefs ?? null) : Promise.resolve(null),
  ]);
  const map = Object.fromEntries(((rows ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
  return resolveOrchSettings({ workspaceTz: w?.timezone ?? null, briefSetting: map.brief, adminKeys: map, orchSetting: map.orchestrator, userPrefs: prefs });
}

/** Bulk variant for the scheduler: one query per table for many workspaces. */
export async function loadAllMemberSettings(admin: Db, wsIds: string[]): Promise<{ workspaceId: string; userId: string; role: string; settings: OrchSettings }[]> {
  if (!wsIds.length) return [];
  const [{ data: wss }, { data: members }, { data: rows }, { data: prefs }] = await Promise.all([
    admin.from("workspace").select("id, timezone").in("id", wsIds),
    admin.from("membership").select("workspace_id, user_id, role").in("workspace_id", wsIds),
    admin.from("workspace_setting").select("workspace_id, key, value").in("workspace_id", wsIds).in("key", ["brief", "orchestrator", "brief_time", "cohort_targets", "size_rules"]),
    admin.from("user_preference").select("workspace_id, user_id, prefs").in("workspace_id", wsIds),
  ]);
  return ((members ?? []) as any[]).map((m) => {
    const map = Object.fromEntries(((rows ?? []) as any[]).filter((r) => r.workspace_id === m.workspace_id).map((r) => [r.key, r.value]));
    const tz = ((wss ?? []) as any[]).find((w) => w.id === m.workspace_id)?.timezone ?? null;
    const p = ((prefs ?? []) as any[]).find((x) => x.workspace_id === m.workspace_id && x.user_id === m.user_id)?.prefs ?? null;
    return { workspaceId: m.workspace_id, userId: m.user_id, role: m.role, settings: resolveOrchSettings({ workspaceTz: tz, briefSetting: map.brief, adminKeys: map, orchSetting: map.orchestrator, userPrefs: p }) };
  });
}
