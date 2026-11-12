/**
 * Source registry + adapter framework (spec §4). Reuses `research_source_registry` (one row per adapter, `adapter` column),
 * `source_object` (original material), `source_sync_run` (retrieval history). Built-in adapters:
 *   manual_paste  — user pastes an article / note (always available)
 *   user_upload   — text of a document captured through /capture (capture.raw_text / capture_document)
 *   database      — Module 1 records: lease events, occupancy, availability (lease + commercial-value scans)
 *   rss           — REGISTERED AS UNAVAILABLE: CRE OS has no approved feed-fetch path; shown as "needs access", never faked.
 * Every adapter call passes the entitlement gate (allowed, not paused, permitted purpose, licence valid, rate limit).
 */
import type { Db } from "@/lib/supabase/server";
import { licenceProblem, type LicensedSourceLite } from "@/modules/intelligence/research/sources";

type Row = Record<string, any>;
export type AdapterId = "manual_paste" | "user_upload" | "database" | "rss";

export interface SourceAdapter {
  id: AdapterId;
  name: string;
  type: string;                 // spec §4 source category
  kind: string;                 // research_source_registry.kind
  acquisitionMethod: string;    // research_source_registry.acquisition_method
  accessMethod: string;         // human description
  authentication: "workspace_session" | "credentials_required" | "none";
  available: boolean;
  unavailableReason?: string;
  permittedPurposes: string[];
  retentionDays: number | null;
  refreshDays: number | null;
  rateLimitPerDay: number | null;
  /** Shape of what the adapter hands to the pipeline. */
  produces: "text" | "records";
}

export const ADAPTERS: SourceAdapter[] = [
  { id: "manual_paste", name: "Manual paste / user observation", type: "User-submitted observations", kind: "manual", acquisitionMethod: "manual_paste",
    accessMethod: "User pastes text with a source name, link and date", authentication: "workspace_session", available: true,
    permittedPurposes: ["signal_detection", "research"], retentionDays: null, refreshDays: null, rateLimitPerDay: 500, produces: "text" },
  { id: "user_upload", name: "User-uploaded research documents", type: "User-uploaded research documents", kind: "export", acquisitionMethod: "user_export",
    accessMethod: "Documents captured in /capture (text already extracted)", authentication: "workspace_session", available: true,
    permittedPurposes: ["signal_detection", "research"], retentionDays: null, refreshDays: null, rateLimitPerDay: 200, produces: "text" },
  { id: "database", name: "CRE OS records (leases, occupancy, availability)", type: "Existing database records", kind: "manual", acquisitionMethod: "user_export",
    accessMethod: "Reads Module 1 tables through workspace permissions", authentication: "workspace_session", available: true,
    permittedPurposes: ["signal_detection"], retentionDays: null, refreshDays: 1, rateLimitPerDay: null, produces: "records" },
  { id: "rss", name: "Approved news / RSS feeds", type: "Permitted news sources", kind: "feed", acquisitionMethod: "rss",
    accessMethod: "Feed fetch (not available)", authentication: "credentials_required", available: false,
    unavailableReason: "Unavailable — needs access: CRE OS has no approved feed-fetch path or licensed news feed configured. Paste articles manually instead.",
    permittedPurposes: ["signal_detection"], retentionDays: 365, refreshDays: 1, rateLimitPerDay: 0, produces: "text" },
];
export const adapter = (id: string) => ADAPTERS.find((a) => a.id === id) ?? null;

export class SourceAccessError extends Error {}

/** Idempotently registers the built-in adapters for a workspace (one registry row each). Returns rows keyed by adapter. */
export async function ensureRegistry(db: Db, ws: string): Promise<Record<AdapterId, Row>> {
  const { data: rows } = await db.from("research_source_registry").select("*").eq("workspace_id", ws).not("adapter", "is", null).is("archived_at", null);
  const by = new Map((rows ?? []).map((r: Row) => [r.adapter, r]));
  for (const a of ADAPTERS) {
    if (by.has(a.id)) continue;
    const row = {
      workspace_id: ws, name: a.name, kind: a.kind, acquisition_method: a.acquisitionMethod, adapter: a.id, allowed: a.available,
      permission_status: a.available ? "permitted" : "unavailable", connection_status: a.available ? "connected" : "needs_access",
      permitted_purposes: a.permittedPurposes, retention_days: a.retentionDays, refresh_cadence_days: a.refreshDays, rate_limit_per_day: a.rateLimitPerDay,
      last_error: a.available ? null : a.unavailableReason, failure_policy: "retry_then_flag", source_owner: "CRE OS",
    };
    const ins = await db.from("research_source_registry").insert(row).select("*").single();
    if (ins.data) { by.set(a.id, ins.data); continue; }
    // A same-named row may already exist (created by hand) — adopt it, or a concurrent insert won: re-read.
    const again = await db.from("research_source_registry").select("*").eq("workspace_id", ws).or(`adapter.eq.${a.id},name.ilike."${a.name}"`).is("archived_at", null).limit(1).maybeSingle();
    if (again.data) {
      if (!again.data.adapter) await db.from("research_source_registry").update({ adapter: a.id }).eq("workspace_id", ws).eq("id", again.data.id);
      by.set(a.id, { ...again.data, adapter: a.id });
    } else if (ins.error) throw new SourceAccessError(`Could not register source ${a.name}: ${ins.error.message}`);
  }
  return Object.fromEntries(by) as Record<AdapterId, Row>;
}

/** Entitlement gate: returns a user-safe reason when this source may not be used now, else null. */
export function entitlementProblem(r: Row, today: string, licence: LicensedSourceLite | null, purpose = "signal_detection"): string | null {
  const a = adapter(r.adapter ?? "");
  if (a && !a.available) return a.unavailableReason ?? "Source unavailable.";
  if (!r.allowed) return `${r.name} is not allowed in this workspace.`;
  if (r.paused) return `${r.name} is paused.`;
  if (r.permission_status !== "permitted") return `${r.name}: permission ${r.permission_status}.`;
  if (r.connection_status === "needs_access" || r.connection_status === "unavailable") return `${r.name} is ${String(r.connection_status).replace("_", " ")}.`;
  if ((r.permitted_purposes ?? []).length && !(r.permitted_purposes as string[]).includes(purpose)) return `${r.name} is not permitted for ${purpose.replace("_", " ")}.`;
  if (r.licensed_source_id) { const p = licenceProblem(licence, today); if (p) return p; }
  if (r.rate_limit_per_day != null && r.calls_day === today && r.calls_today >= r.rate_limit_per_day) return `${r.name} reached its daily limit (${r.rate_limit_per_day}).`;
  return null;
}

/** Loads the registry row for an adapter, checks entitlement, and counts one use. Throws SourceAccessError when blocked. */
export async function useSource(db: Db, ws: string, id: AdapterId, today: string, registryId?: string | null): Promise<Row> {
  const reg = await ensureRegistry(db, ws);
  let r = reg[id];
  if (registryId && registryId !== r?.id) r = (await db.from("research_source_registry").select("*").eq("workspace_id", ws).eq("id", registryId).maybeSingle()).data as Row;
  if (!r) throw new SourceAccessError("Source not registered.");
  const lic = r.licensed_source_id ? ((await db.from("licensed_source").select("*").eq("workspace_id", ws).eq("id", r.licensed_source_id).maybeSingle()).data as LicensedSourceLite | null) : null;
  const p = entitlementProblem(r, today, lic);
  if (p) throw new SourceAccessError(p);
  const calls = r.calls_day === today ? r.calls_today + 1 : 1;
  await db.from("research_source_registry").update({ calls_today: calls, calls_day: today, usage_count: (r.usage_count ?? 0) + 1 }).eq("workspace_id", ws).eq("id", r.id);
  return r;
}

export async function markSourceResult(db: Db, ws: string, registryId: string, ok: boolean, error?: string | null) {
  const now = new Date().toISOString();
  await db.from("research_source_registry").update(ok
    ? { last_success_at: now, last_sync_at: now, last_sync_status: "ok", last_error: null, connection_status: "connected" }
    : { last_sync_at: now, last_sync_status: "failed", last_error: (error ?? "failed").slice(0, 300), connection_status: "error" }).eq("workspace_id", ws).eq("id", registryId);
}

export interface RegistryView {
  id: string; name: string; type: string; adapter: string | null; accessMethod: string; permissionStatus: string; permittedPurposes: string[];
  retentionDays: number | null; refreshDays: number | null; lastRetrieval: string | null; connectionStatus: string; lastError: string | null;
  usageCount: number; paused: boolean; available: boolean;
}
export async function listSourceRegistry(db: Db, ws: string): Promise<RegistryView[]> {
  await ensureRegistry(db, ws).catch(() => null);   // viewers cannot insert; list what exists
  const { data } = await db.from("research_source_registry").select("*").eq("workspace_id", ws).is("archived_at", null).order("name");
  return (data ?? []).map((r: Row) => {
    const a = adapter(r.adapter ?? "");
    return {
      id: r.id, name: r.name, type: a?.type ?? r.kind, adapter: r.adapter ?? null, accessMethod: a?.accessMethod ?? r.acquisition_method,
      permissionStatus: r.permission_status, permittedPurposes: r.permitted_purposes ?? [], retentionDays: r.retention_days, refreshDays: r.refresh_cadence_days,
      lastRetrieval: r.last_success_at, connectionStatus: r.paused ? "paused" : r.connection_status, lastError: r.last_error, usageCount: r.usage_count ?? 0,
      paused: !!r.paused, available: a ? a.available : !!r.allowed,
    };
  });
}

export async function setSourcePaused(db: Db, ws: string, id: string, paused: boolean) {
  const { error } = await db.from("research_source_registry").update({ paused, connection_status: paused ? "paused" : "connected" }).eq("workspace_id", ws).eq("id", id);
  if (error) throw new SourceAccessError(error.message);
}

/** Reconnect: clears error/paused for adapters that have an access path; unavailable adapters stay "needs access". */
export async function reconnectSource(db: Db, ws: string, id: string) {
  const { data: r } = await db.from("research_source_registry").select("*").eq("workspace_id", ws).eq("id", id).maybeSingle();
  if (!r) throw new SourceAccessError("Source not found.");
  const a = adapter(r.adapter ?? "");
  if (a && !a.available) {
    await db.from("research_source_registry").update({ connection_status: "needs_access", last_error: a.unavailableReason }).eq("workspace_id", ws).eq("id", id);
    return { connectionStatus: "needs_access" as const, message: a.unavailableReason! };
  }
  await db.from("research_source_registry").update({ paused: false, connection_status: "connected", last_error: null }).eq("workspace_id", ws).eq("id", id);
  return { connectionStatus: "connected" as const, message: "Reconnected." };
}
