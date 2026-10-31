import "server-only";
import type { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { isoDate } from "../common";
import { SourceInput, validateSource, PASTE_METHODS, type LicensedSourceLite } from "./sources";

type Row = Record<string, unknown>;

/** Research source registry (approved sources). Writes are admin-only at the action/route layer; RLS still applies. */
export async function listSources(db: Db, workspaceId: string, opts: { includeArchived?: boolean } = {}) {
  let q = db.from("research_source_registry").select("*").eq("workspace_id", workspaceId).order("name").limit(500);
  if (!opts.includeArchived) q = q.is("archived_at", null);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Row[];
}

export async function licensedSourceOptions(db: Db, workspaceId: string) {
  const { data, error } = await db.from("licensed_source").select("id, name, expires_on, allowed_purposes, permits_ai_processing, permits_colleague_sharing, archived_at").eq("workspace_id", workspaceId).is("archived_at", null).order("name").limit(200);
  if (error) throw error;
  return (data ?? []) as LicensedSourceLite[];
}

/** Allowed sources a user may cite when pasting evidence. */
export async function pasteSourceOptions(db: Db, workspaceId: string) {
  const rows = await listSources(db, workspaceId);
  return rows.filter((r) => r.allowed && PASTE_METHODS.has(String(r.acquisition_method))).map((r) => ({ id: String(r.id), name: String(r.name), licensed: !!r.licensed_source_id, base_url: (r.base_url as string | null) ?? null }));
}

export async function saveSource(db: Db, workspaceId: string, raw: z.input<typeof SourceInput>, opts: { id?: string | null; expectedVersion?: number | null; userId: string }) {
  const input = SourceInput.parse(raw);
  let licensed: LicensedSourceLite | null = null;
  if (input.licensedSourceId) {
    const { data } = await db.from("licensed_source").select("id, name, expires_on, allowed_purposes, permits_ai_processing, permits_colleague_sharing, archived_at").eq("workspace_id", workspaceId).eq("id", input.licensedSourceId).maybeSingle();
    licensed = (data as LicensedSourceLite | null) ?? null;
  }
  const fields = validateSource(input, licensed, isoDate(new Date())!);
  if (opts.id) {
    let q = db.from("research_source_registry").update(fields).eq("workspace_id", workspaceId).eq("id", opts.id);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== null) q = q.eq("row_version", opts.expectedVersion);
    const { data, error } = await q.select().maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("This source changed meanwhile or is not visible — reload and try again.");
    return data as Row;
  }
  // Natural dedupe: one live source per name (unique index); a replay returns the existing row.
  const { data: existing } = await db.from("research_source_registry").select("*").eq("workspace_id", workspaceId).ilike("name", input.name.replace(/[%_]/g, "")).is("archived_at", null).limit(1);
  if (existing?.length) return existing[0] as Row;
  const { data, error } = await db.from("research_source_registry").insert({ workspace_id: workspaceId, ...fields, owner_user_id: opts.userId }).select().single();
  if (error) throw error;
  return data as Row;
}

/** Disable (or re-enable) a source. Re-enabling re-checks the licence. */
export async function setSourceAllowed(db: Db, workspaceId: string, id: string, allowed: boolean, userId: string) {
  const { data: row, error } = await db.from("research_source_registry").select("*").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!row) throw new Error("Source not found.");
  if (!allowed) {
    const { data, error: e } = await db.from("research_source_registry").update({ allowed: false }).eq("workspace_id", workspaceId).eq("id", id).select().single();
    if (e) throw e;
    return data as Row;
  }
  return saveSource(db, workspaceId, {
    name: String(row.name), kind: row.kind as never, baseUrl: (row.base_url as string | null) ?? null, acquisitionMethod: row.acquisition_method as never,
    licence: row.licence as string | null, licensedSourceId: row.licensed_source_id as string | null, rateLimitPerDay: row.rate_limit_per_day as number | null,
    refreshCadenceDays: row.refresh_cadence_days as number | null, storageRights: row.storage_rights as string | null, reuseRights: row.reuse_rights as string | null,
    credentialsOwner: row.credentials_owner as string | null, failurePolicy: row.failure_policy as string | null, sourceOwner: row.source_owner as string | null,
    allowed: true, prohibitedMethods: (row.prohibited_methods as string[]) ?? [],
  }, { id, expectedVersion: Number(row.row_version), userId });
}
