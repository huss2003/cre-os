/**
 * Batched lookups by long string keys (task idempotency keys, outbox dedupe keys).
 *
 * PostgREST sends `.in(col, values)` in the URL. 200 radar keys such as
 * `brief.radar:<lease uuid>:plan:options_start` exceed the gateway's URI limit (HTTP 414 "URI too long"); the error was
 * ignored, so every run treated all tasks as new — the same top-N tasks were re-selected forever, deferred milestones
 * were never raised and moved milestones never updated (found with the real Pune lease files: 752 radar candidates).
 * Chunks are therefore bounded by encoded length, and a failed lookup throws instead of silently returning nothing.
 */
import type { Db } from "@/lib/supabase/server";

/** Default URL budget per request for the IN list (encoded characters). Well under the ~8–16 KB gateway limit. */
export const KEY_URL_BUDGET = 4_000;

/** Split keys so each chunk's encoded IN-list stays within `budget` characters (always at least one key per chunk). */
export function chunkKeys(keys: string[], budget = KEY_URL_BUDGET): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const k of keys) {
    const l = encodeURIComponent(`"${k}"`).length + 3; // quoted value + encoded comma
    if (cur.length && len + l > budget) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(k);
    len += l;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Rows of `table` whose `column` is one of `keys` (workspace-filtered). Throws on any request error (S10: never "none found" on failure). */
export async function rowsByKeys<T extends Record<string, unknown>>(db: Db, table: string, workspaceId: string, column: string, keys: string[], cols: string): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunkKeys([...new Set(keys)])) {
    const { data, error } = await db.from(table).select(cols).eq("workspace_id", workspaceId).in(column, part);
    if (error) throw new Error(`${table} lookup by ${column} failed: ${error.message}`);
    out.push(...((data ?? []) as unknown as T[]));
  }
  return out;
}
