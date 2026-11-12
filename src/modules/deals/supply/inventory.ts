/**
 * Inventory display: one row per live space — the latest availability snapshot (as_of, then created_at).
 * Rows whose space or building is archived are dropped (a demo reseed archives the old building but its
 * spaces/availability can stay live, which showed the same "Floor 5 · East wing" twice).
 */
type Av = { space_id?: unknown; as_of?: unknown; created_at?: unknown; space?: { archived_at?: string | null; asset?: { archived_at?: string | null } | null } | null };
export function latestLiveAvailability<T extends Av>(rows: T[]): T[] {
  const best = new Map<string, T>();
  const key = (r: T) => `${String(r.as_of ?? "")}|${String(r.created_at ?? "")}`;
  for (const r of rows) {
    if (!r.space || r.space.archived_at || !r.space.asset || r.space.asset.archived_at) continue;
    const id = String(r.space_id);
    const cur = best.get(id);
    if (!cur || key(r) > key(cur)) best.set(id, r);
  }
  const keep = new Set(best.values());
  return rows.filter((r) => keep.has(r));
}
