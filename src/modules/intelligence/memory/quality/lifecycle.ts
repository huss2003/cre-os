/**
 * Module 13 §13 — memory lifecycle. Status of a memory item is derived deterministically; a user can correct it
 * (append-only memory_lifecycle row, audited by the table's audit trigger). Historical information is never
 * overwritten — a correction only changes how the item is labelled.
 */
import type { MemCtx, MemoryStatus, Row } from "../types";

export const LIFECYCLE_STATUSES: MemoryStatus[] = ["current", "historical", "superseded", "unverified", "conflicting"];

/** Deterministic status: conflicts first, then superseded / historical, then unverified, else current. */
export function lifecycleStatus(x: { conflicting?: boolean; superseded?: boolean; ended?: boolean; isLatest?: boolean; verification?: string | null }): MemoryStatus {
  if (x.conflicting) return "conflicting";
  if (x.superseded) return "superseded";
  if (x.ended || x.isLatest === false) return "historical";
  if (!x.verification || ["unverified", "unknown", "inferred", "estimated"].includes(x.verification)) return "unverified";
  return "current";
}

/** Apply the latest manual correction per item key (corrections are newest-first). */
export function applyCorrections<T extends { key: string; status: MemoryStatus }>(items: T[], corrections: { item_key: string; status: MemoryStatus; note: string; created_at: string }[]): (T & { corrected?: { note: string; at: string; from: MemoryStatus } })[] {
  const latest = new Map<string, { status: MemoryStatus; note: string; created_at: string }>();
  for (const c of [...corrections].sort((a, b) => b.created_at.localeCompare(a.created_at))) if (!latest.has(c.item_key)) latest.set(c.item_key, c);
  return items.map((i) => { const c = latest.get(i.key); return c ? { ...i, status: c.status, corrected: { note: c.note, at: c.created_at, from: i.status } } : i; });
}

export class LifecycleError extends Error {}

/** Manual correction (§13): records who/when/why; the previous status stays in history (row + audit_event). */
export async function correctMemoryStatus(ctx: MemCtx, i: { entityType: string; entityId: string; category: string; itemKey: string; status: MemoryStatus; note: string }) {
  if (!LIFECYCLE_STATUSES.includes(i.status)) throw new LifecycleError("Unknown status");
  if (!i.note?.trim()) throw new LifecycleError("Say why you are correcting this (kept in the history).");
  const prev = (await ctx.db.from("memory_lifecycle").select("status").eq("workspace_id", ctx.workspaceId).eq("entity_type", i.entityType).eq("entity_id", i.entityId).eq("item_key", i.itemKey)
    .order("created_at", { ascending: false }).limit(1).maybeSingle()).data as Row | null;
  const { data, error } = await ctx.db.from("memory_lifecycle").insert({
    workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, entity_type: i.entityType, entity_id: i.entityId, category: i.category, item_key: i.itemKey,
    status: i.status, previous_status: prev?.status ?? null, note: i.note.trim().slice(0, 1000), corrected_by: ctx.userId,
  }).select("id, created_at").single();
  if (error) throw new LifecycleError(error.message);
  return data as { id: string; created_at: string };
}

export async function listCorrections(ctx: MemCtx, entityType: string, entityId: string) {
  const { data, error } = await ctx.db.from("memory_lifecycle").select("id, category, item_key, status, previous_status, note, corrected_by, created_at").eq("workspace_id", ctx.workspaceId)
    .eq("entity_type", entityType).eq("entity_id", entityId).is("archived_at", null).order("created_at", { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as { id: string; category: string; item_key: string; status: MemoryStatus; previous_status: string | null; note: string; corrected_by: string | null; created_at: string }[];
}
