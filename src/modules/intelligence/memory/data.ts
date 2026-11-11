/** Shared read helpers over Module 1 tables (RLS via ctx.db; workspace_id filtered explicitly — S2). */
import type { MemCtx, Row, SourceRef } from "./types";

export async function q<T = Row[]>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return (data ?? []) as T;
}
export const today = () => new Date().toISOString().slice(0, 10);

export function interactionSource(i: Row): SourceRef {
  return { type: "interaction", id: i.id, label: `${i.channel ?? "note"} ${String(i.occurred_at ?? "").slice(0, 10)}${i.subject ? ` — ${i.subject}` : ""}`, href: i.capture_id ? `/capture/${i.capture_id}` : null };
}

const INT_COLS = "id, occurred_at, channel, direction, subject, summary, promises, objections, opportunity_id, is_meaningful, capture_id, source_object_id, created_at";

/** Interactions linked to any of the given entities (deduplicated, newest first). */
export async function interactionsFor(ctx: MemCtx, entityType: string, ids: string[], limit = 300): Promise<Row[]> {
  if (!ids.length) return [];
  const links = await q(ctx.db.from("interaction_link").select(`entity_id, interaction:interaction_id(${INT_COLS})`).eq("workspace_id", ctx.workspaceId)
    .eq("entity_type", entityType).in("entity_id", ids).is("archived_at", null).limit(limit));
  const by = new Map<string, Row>();
  for (const l of links) if (l.interaction && !by.has(l.interaction.id)) by.set(l.interaction.id, { ...l.interaction, linked_id: l.entity_id });
  return [...by.values()].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
}

export interface Commitment { text: string; due: string | null; status: string; pending: boolean; overdue: boolean; who: string | null; at: string; source: SourceRef }
export interface Objection { text: string; at: string; source: SourceRef }

const DONE = new Set(["done", "completed", "kept", "fulfilled", "closed"]);
const DROPPED = new Set(["cancelled", "dropped", "void"]);

export function commitmentsFrom(ints: Row[], now = today()): Commitment[] {
  const out: Commitment[] = [];
  for (const i of ints) for (const p of (Array.isArray(i.promises) ? i.promises : []) as unknown[]) {
    const o = (typeof p === "string" ? { what: p } : (p ?? {})) as Row;
    const text = String(o.what ?? o.text ?? "").trim(); if (!text) continue;
    const status = String(o.status ?? "open");
    const pending = !DONE.has(status) && !DROPPED.has(status);
    const due = (o.due as string | undefined) ?? null;
    out.push({ text, due, status, pending, overdue: pending && !!due && due < now, who: (o.who as string) ?? null, at: i.occurred_at, source: interactionSource(i) });
  }
  return out;
}

export function objectionsFrom(ints: Row[]): Objection[] {
  const out: Objection[] = [];
  for (const i of ints) for (const p of (Array.isArray(i.objections) ? i.objections : []) as unknown[]) {
    const text = typeof p === "string" ? p : String((p as Row)?.what ?? (p as Row)?.text ?? (p as Row)?.objection ?? "");
    if (text.trim()) out.push({ text: text.trim(), at: i.occurred_at, source: interactionSource(i) });
  }
  return out;
}

export async function labels(ctx: MemCtx, table: "organisation" | "person" | "asset", ids: string[]): Promise<Map<string, string>> {
  const u = [...new Set(ids.filter(Boolean))];
  if (!u.length) return new Map();
  const col = table === "organisation" ? "display_name" : table === "person" ? "full_name" : "name";
  const rows = await q(ctx.db.from(table).select(`id, ${col}`).eq("workspace_id", ctx.workspaceId).in("id", u));
  return new Map(rows.map((r) => [r.id, r[col] ?? ""]));
}
