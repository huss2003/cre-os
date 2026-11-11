import type { Db } from "@/lib/supabase/server";

/** Place-name key: trim + case fold + whitespace collapse (same rule as imports' exactKey). */
export const geoNameKey = (s: unknown) => String(s ?? "").replace(/[ \s]+/g, " ").trim().toLowerCase();

export interface LiveGeo { id: string; level: string; name: string; parent_id: string | null; aliases: string[] | null; created_at?: string }

/**
 * Index every live (non-archived) place in a workspace by its name, its `aliases[]` and its entity_alias rows.
 * Archived places are never matched. Pass `db` already scoped to the right client (RLS or explicit workspace filter).
 */
export async function liveGeographyIndex(db: Db, ws: string): Promise<Map<string, LiveGeo[]>> {
  const geos: LiveGeo[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("geography").select("id, level, name, parent_id, aliases, created_at")
      .eq("workspace_id", ws).is("archived_at", null).order("created_at").order("id").range(from, from + 999);
    if (error) throw error;
    geos.push(...((data ?? []) as LiveGeo[]));
    if (!data || data.length < 1000) break;
  }
  const byId = new Map(geos.map((g) => [g.id, g]));
  const idx = new Map<string, LiveGeo[]>();
  const put = (k: string, g: LiveGeo) => { if (!k) return; const l = idx.get(k) ?? []; if (!l.includes(g)) l.push(g); idx.set(k, l); };
  for (const g of geos) { put(geoNameKey(g.name), g); for (const a of g.aliases ?? []) put(geoNameKey(a), g); }
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("entity_alias").select("entity_id, raw_alias, canonical_alias")
      .eq("workspace_id", ws).eq("entity_type", "geography").is("archived_at", null).order("id").range(from, from + 999);
    if (error) throw error;
    for (const a of (data ?? []) as { entity_id: string; raw_alias: string; canonical_alias: string }[]) {
      const g = byId.get(a.entity_id);
      if (g) { put(geoNameKey(a.raw_alias), g); put(geoNameKey(a.canonical_alias), g); }
    }
    if (!data || data.length < 1000) break;
  }
  return idx;
}

/**
 * Pick the existing live place for a name. Same parent (when given) is required; otherwise same level wins,
 * then the oldest. Returns null when nothing matches — the caller may then create one.
 */
export function pickGeography(idx: Map<string, LiveGeo[]>, name: string, opts: { level?: string; parentId?: string | null } = {}): LiveGeo | null {
  let c = idx.get(geoNameKey(name)) ?? [];
  if (opts.parentId !== undefined && opts.parentId !== null) c = c.filter((g) => g.parent_id === opts.parentId);
  if (!c.length) return null;
  return c.find((g) => g.level === opts.level) ?? c[0];
}
