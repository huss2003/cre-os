/*
 * Source traceability for imported records (Input Engine spec §11, §15 rule 6): for any record, every spreadsheet row
 * that produced or confirmed it — file, version, worksheet, cell references, raw cell values — plus the value history
 * (field conflicts and their proposals). The original file is opened via a short-lived signed URL (RLS client: the
 * storage policy decides whether this user may read it).
 */
import "server-only";
import type { Db } from "@/lib/supabase/server";
import { BUCKET } from "./pipeline";

export interface SourceRef {
  staged_row_id: string;
  batch_id: string;
  file_name: string | null;
  version: number | null;
  sha256: string | null;
  imported_at: string | null;
  sheet: string;
  row_number: number;
  locator: string;
  status: string;
  cell_refs: Record<string, string>;
  values: { field: string; cell: string; raw: unknown }[];
  source_object_id: string;
  role: string;
}

const letterIndex = (l: string) => [...l].reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

export async function recordSources(db: Db, ws: string, entityId: string, limit = 50): Promise<SourceRef[]> {
  const { data, error } = await db.from("staged_row").select("id, batch_id, sheet, row_number, locator, status, raw_json, mapped_json, targets, source_object_id, created_at")
    .eq("workspace_id", ws).contains("targets", JSON.stringify([{ id: entityId }])).order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  const rows = data ?? [];
  const soIds = [...new Set(rows.map((r) => r.source_object_id as string))];
  const { data: sos } = soIds.length ? await db.from("source_object").select("id, file_name, version, sha256, created_at").eq("workspace_id", ws).in("id", soIds) : { data: [] };
  const som = new Map((sos ?? []).map((s: { id: string }) => [s.id, s as { id: string; file_name: string | null; version: number; sha256: string; created_at: string }]));
  return rows.map((r) => {
    const so = som.get(r.source_object_id);
    const refs = ((r.mapped_json as { cell_refs?: Record<string, string> } | null)?.cell_refs ?? {}) as Record<string, string>;
    const raw = (r.raw_json ?? {}) as Record<string, { v: unknown }>;
    const values = Object.entries(refs).map(([field, cell]) => {
      const col = cell.split("!").pop()!.replace(/\d+$/, "");
      return { field, cell, raw: raw[col]?.v ?? null, _i: letterIndex(col) };
    }).sort((a, b) => a._i - b._i).map(({ _i, ...v }) => { void _i; return v; });
    const t = ((r.targets ?? []) as { id: string; role: string }[]).find((x) => x.id === entityId);
    return {
      staged_row_id: r.id, batch_id: r.batch_id, file_name: so?.file_name ?? null, version: so?.version ?? null, sha256: so?.sha256 ?? null,
      imported_at: so?.created_at ?? r.created_at, sheet: r.sheet, row_number: r.row_number, locator: r.locator, status: r.status, cell_refs: refs, values,
      source_object_id: r.source_object_id, role: t?.role ?? "master",
    };
  });
}

/** Value history for a record: every source value that disagreed with it, with file/cell and what happened. Nothing is overwritten. */
export async function valueHistory(db: Db, ws: string, entityId: string) {
  const { data, error } = await db.from("field_conflict").select("id, field, master_value, source_value, material, source_locator, source_label, observed_at, status, change_proposal_id")
    .eq("workspace_id", ws).eq("entity_id", entityId).order("observed_at", { ascending: false }).limit(100);
  if (error) throw error;
  return data ?? [];
}

/** Short-lived link to the preserved original (storage RLS applies: restricted originals stay owner-only). */
export async function originalUrl(db: Db, ws: string, sourceObjectId: string): Promise<string | null> {
  const { data: so } = await db.from("source_object").select("uri, meta").eq("workspace_id", ws).eq("id", sourceObjectId).maybeSingle();
  if (!so) return null;
  const path = ((so.meta as { storage_path?: string } | null)?.storage_path) ?? String(so.uri ?? "").replace(`storage://${BUCKET}/`, "");
  if (!path.startsWith(`${ws}/`)) return null;
  const { data } = await db.storage.from(BUCKET).createSignedUrl(path, 300, { download: true });
  return data?.signedUrl ?? null;
}

/**
 * Provenance shortcuts for entity pages: is there an import trace (staged rows) and/or capture evidence
 * (capture_observation with this record as subject or link)? Runs on the user client (RLS).
 */
export async function provenanceLinks(db: Db, ws: string, entityId: string): Promise<{ importRows: number; capture: { count: number; href: string | null } }> {
  const [imp, subj, linked] = await Promise.all([
    db.from("staged_row").select("id", { count: "exact", head: true }).eq("workspace_id", ws).contains("targets", JSON.stringify([{ id: entityId }])),
    db.from("capture_observation").select("id, capture_id, capture_document_id, created_at").eq("workspace_id", ws).eq("subject_id", entityId).is("archived_at", null).order("created_at", { ascending: false }).limit(50),
    db.from("capture_observation").select("id, capture_id, capture_document_id, created_at").eq("workspace_id", ws).contains("links", JSON.stringify([{ id: entityId }])).is("archived_at", null).order("created_at", { ascending: false }).limit(50),
  ]);
  const obs = new Map([...(subj.data ?? []), ...(linked.data ?? [])].map((o) => [o.id as string, o as { id: string; capture_id: string | null; capture_document_id: string | null; created_at: string }]));
  const latest = [...obs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const href = !latest ? null : latest.capture_id ? `/capture/${latest.capture_id}` : latest.capture_document_id ? `/capture/documents/${latest.capture_document_id}` : null;
  return { importRows: imp.count ?? 0, capture: { count: obs.size, href } };
}
