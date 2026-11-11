/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret, sha256, stableHash, stableStringify } from "@/lib/util/crypto";

/**
 * Logical export + monthly restore-sample check (spec §14 Backups; acceptance test "Backups").
 * This complements — does not replace — Supabase Pro managed daily backups / PITR, which must be enabled on the
 * production project. Exports go to mudar-workspace-files/<ws>/backups/<stamp>/ (encrypted with TOKEN_ENCRYPTION_KEY
 * when set); production should replicate that prefix to a separately approved store.
 * SERVICE-ROLE ONLY (jobs). Every query filters workspace_id explicitly (rule S2).
 */
type Admin = SupabaseClient<any, any, any>;
type Row = Record<string, any>;

export const BACKUP_BUCKET = "mudar-workspace-files";
/** Tables never exported (queue internals regenerate; backup log would recurse). */
const EXCLUDE = new Set(["job", "backup_run"]);

export interface ExportManifest {
  version: 1;
  workspace_id: string;
  stamp: string;
  exported_at: string;
  encrypted: boolean;
  tables: Record<string, { rows: number; sha256: string; file: string; bytes: number }>;
}

function canEncrypt() {
  const k = process.env.TOKEN_ENCRYPTION_KEY;
  return !!k && Buffer.from(k, "base64").length === 32;
}

export function stampFor(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

async function upload(admin: Admin, path: string, body: string, contentType: string) {
  const { error } = await admin.storage.from(BACKUP_BUCKET).upload(path, new Blob([body], { type: contentType }), { upsert: true, contentType });
  if (error) throw new Error(`upload ${path}: ${error.message}`);
}

async function download(admin: Admin, path: string): Promise<string> {
  const { data, error } = await admin.storage.from(BACKUP_BUCKET).download(path);
  if (error || !data) throw new Error(`download ${path}: ${error?.message ?? "missing"}`);
  return await data.text();
}

export async function exportTables(admin: Admin): Promise<string[]> {
  const { data, error } = await admin.schema("mudar_app").rpc("workspace_tables");
  if (error) throw new Error(`workspace_tables: ${error.message}`);
  return ((data ?? []) as unknown[]).map((r) => (typeof r === "string" ? r : Object.values(r as object)[0] as string)).filter((t) => !EXCLUDE.has(t));
}

/** Rows per export_table page (keyset by id): one jsonb_agg over a large table overran the statement timeout. */
export const EXPORT_PAGE_ROWS = 5000;

/** Every row of one workspace table, ordered by id, fetched in keyset pages. */
export async function fetchTableRows(admin: Admin, workspaceId: string, table: string): Promise<Row[]> {
  const out: Row[] = [];
  let after: string | null = null;
  for (;;) {
    const { data, error } = await admin.schema("mudar_app")
      .rpc("export_table", { p_workspace: workspaceId, p_table: table, p_after: after, p_limit: EXPORT_PAGE_ROWS });
    if (error) throw new Error(`export ${table}: ${error.message}`);
    const page = (data ?? []) as Row[];
    out.push(...page);
    const last = page[page.length - 1];
    // tables without an id column come back whole (no paging)
    if (page.length < EXPORT_PAGE_ROWS || !last || last.id == null) return out;
    after = String(last.id);
  }
}

/** Nightly logical export: every workspace table -> one JSON file + manifest with counts and hashes. */
export async function exportWorkspace(admin: Admin, workspaceId: string, opts: { tables?: string[]; jobId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const stamp = stampFor(now);
  const prefix = `${workspaceId}/backups/${stamp}`;
  const encrypted = canEncrypt();
  const { data: run, error: e0 } = await admin.from("backup_run")
    .insert({ workspace_id: workspaceId, kind: "logical_export", status: "running", storage_prefix: prefix, encrypted, job_id: opts.jobId ?? null })
    .select().single();
  if (e0) throw new Error(`backup_run insert: ${e0.message}`);
  try {
    const tables = opts.tables ?? (await exportTables(admin));
    const manifest: ExportManifest = { version: 1, workspace_id: workspaceId, stamp, exported_at: now.toISOString(), encrypted, tables: {} };
    let bytes = 0;
    // Bounded parallelism: ~100 tables x (RPC + upload) done serially overran the 60s serverless limit.
    const queue = [...tables];
    const worker = async () => {
      for (let table = queue.shift(); table !== undefined; table = queue.shift()) {
        const rows = await fetchTableRows(admin, workspaceId, table);
        const plain = JSON.stringify({ table, workspace_id: workspaceId, stamp, rows });
        const body = encrypted ? encryptSecret(plain) : plain;
        const file = `${table}.json${encrypted ? ".enc" : ""}`;
        await upload(admin, `${prefix}/${file}`, body, encrypted ? "application/octet-stream" : "application/json");
        manifest.tables[table] = { rows: rows.length, sha256: stableHash(rows), file, bytes: body.length };
        bytes += body.length;
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, tables.length) }, worker));
    manifest.tables = Object.fromEntries(Object.keys(manifest.tables).sort().map((t) => [t, manifest.tables[t]]));
    const manifestText = stableStringify(manifest);
    await upload(admin, `${prefix}/manifest.json`, manifestText, "application/json");
    const counts = Object.fromEntries(Object.entries(manifest.tables).map(([t, v]) => [t, v.rows]));
    const hashes = Object.fromEntries(Object.entries(manifest.tables).map(([t, v]) => [t, v.sha256]));
    const { data: done, error: e1 } = await admin.from("backup_run").update({
      status: "succeeded", finished_at: new Date().toISOString(), table_counts: counts, table_hashes: hashes,
      manifest_hash: sha256(manifestText), bytes,
    }).eq("id", run.id).eq("workspace_id", workspaceId).select().single();
    if (e1) throw new Error(e1.message);
    return done as Row;
  } catch (e) {
    await admin.from("backup_run").update({ status: "failed", finished_at: new Date().toISOString(), error: String(e).slice(0, 2000) })
      .eq("id", run.id).eq("workspace_id", workspaceId);
    throw e;
  }
}

/**
 * Monthly restore-sample check: re-read an export from storage, verify per-table row counts and hashes against the
 * manifest and backup_run, and flag restore hazards (suppressions/revocations newer than the export that a naive
 * restore would undo; members in the export who have since been removed).
 */
/** Real restore test limits: rows restored per table, and a deadline so the whole check fits a 60 s serverless tick. */
export const RESTORE_TEST = { rowsPerTable: 200, deadlineMs: 30_000, concurrency: 8 };

export interface RestoreTableResult {
  table: string; rows_in: number; rows_restored?: number; value_mismatch_rows?: number; value_mismatch_columns?: string[];
  duplicate_ids?: number; dropped_columns?: string[]; defaulted_columns?: string[]; restored_hash?: string; error?: string; ms?: number;
}

/** Deterministic spread sample: every k-th row so old and new rows are both exercised. */
export function sampleRows<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  return Array.from({ length: max }, (_, i) => rows[Math.floor(i * step)]);
}

/**
 * Restore exported rows into a TEMP copy of the live table (mudar_app.restore_sample_table: LIKE mudar.<t> incl.
 * defaults and CHECK/NOT NULL; dropped at the end; live data untouched) and compare value by value.
 */
export async function restoreTableSample(admin: Admin, workspaceId: string, table: string, rows: Row[], max = RESTORE_TEST.rowsPerTable): Promise<RestoreTableResult> {
  const sample = sampleRows(rows, max);
  const { data, error } = await admin.schema("mudar_app").rpc("restore_sample_table", { p_workspace: workspaceId, p_table: table, p_rows: sample });
  if (error) return { table, rows_in: sample.length, error: error.message };
  return data as RestoreTableResult;
}

/** Fold per-table restore results into findings + integrity problems (problems fail the check; dropped columns warn). */
export function summariseRestore(results: RestoreTableResult[], skipped: string[], ms: number) {
  const problems: { table: string; problem: string }[] = [];
  const dropped: Record<string, string[]> = {};
  for (const r of results) {
    if (r.error) { problems.push({ table: r.table, problem: `restore failed: ${r.error}` }); continue; }
    if (r.rows_restored !== r.rows_in) problems.push({ table: r.table, problem: `restored ${r.rows_restored} of ${r.rows_in} rows` });
    if (r.value_mismatch_rows) problems.push({ table: r.table, problem: `${r.value_mismatch_rows} restored row(s) differ from the export (${(r.value_mismatch_columns ?? []).join(", ")})` });
    if (r.duplicate_ids) problems.push({ table: r.table, problem: `${r.duplicate_ids} duplicate id(s) after restore` });
    if (r.dropped_columns?.length) dropped[r.table] = r.dropped_columns;
  }
  return {
    problems,
    findings: {
      method: "temp table LIKE live table (defaults + CHECK/NOT NULL), rows inserted from the export, compared value by value, then dropped",
      tables_restored: results.filter((r) => !r.error).length,
      rows_restored: results.reduce((n, r) => n + (r.rows_restored ?? 0), 0),
      failed: results.filter((r) => r.error).map((r) => ({ table: r.table, error: r.error })),
      dropped_columns: dropped,
      skipped_for_time: skipped,
      hashes: Object.fromEntries(results.filter((r) => r.restored_hash).map((r) => [r.table, r.restored_hash])),
      ms,
    },
  };
}

export async function restoreSampleCheck(admin: Admin, workspaceId: string, opts: { exportId?: string; jobId?: string; sample?: number; restoreRows?: number; restoreDeadlineMs?: number } = {}) {
  let q = admin.from("backup_run").select("*").eq("workspace_id", workspaceId).eq("kind", "logical_export").eq("status", "succeeded");
  if (opts.exportId) q = q.eq("id", opts.exportId);
  const { data: exp } = await q.order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (!exp) throw new Error("no successful logical export to verify");
  const started = Date.now();
  const { data: run, error: e0 } = await admin.from("backup_run")
    .insert({ workspace_id: workspaceId, kind: "restore_sample", status: "running", verified_export_id: exp.id, storage_prefix: exp.storage_prefix, job_id: opts.jobId ?? null })
    .select().single();
  if (e0) throw new Error(`backup_run insert: ${e0.message}`);

  const mismatches: { table: string; problem: string }[] = [];
  const hazards: Record<string, unknown> = {};
  const verifiedCounts: Record<string, number> = {};
  try {
    const manifestText = await download(admin, `${exp.storage_prefix}/manifest.json`);
    if (exp.manifest_hash && sha256(manifestText) !== exp.manifest_hash) mismatches.push({ table: "*", problem: "manifest hash differs from backup_run" });
    const manifest = JSON.parse(manifestText) as ExportManifest;
    if (manifest.workspace_id !== workspaceId) throw new Error("manifest belongs to another workspace");

    // Always include safety-relevant tables; sample the rest (all when sample is undefined).
    const all = Object.keys(manifest.tables);
    const must = ["contact_method", "consent_permission", "membership"].filter((t) => all.includes(t));
    const rest = all.filter((t) => !must.includes(t));
    const picked = opts.sample === undefined ? all : [...must, ...rest.sort(() => Math.random() - 0.5).slice(0, opts.sample)];
    const exported: Record<string, Row[]> = {};
    // Bounded parallel downloads (serial reads of ~100 files overran the 60s serverless limit).
    const queue = [...picked];
    const reader = async () => {
      for (let table = queue.shift(); table !== undefined; table = queue.shift()) await verifyTable(table);
    };
    const verifyTable = async (table: string) => {
      const meta = manifest.tables[table];
      const raw = await download(admin, `${exp.storage_prefix}/${meta.file}`);
      const text = manifest.encrypted ? decryptSecret(raw) : raw;
      const parsed = JSON.parse(text) as { table: string; workspace_id: string; rows: Row[] };
      if (parsed.workspace_id !== workspaceId || parsed.table !== table) mismatches.push({ table, problem: "file header mismatch" });
      if (parsed.rows.some((r) => r.workspace_id !== workspaceId)) mismatches.push({ table, problem: "row from another workspace" });
      if (parsed.rows.length !== meta.rows) mismatches.push({ table, problem: `count ${parsed.rows.length} != manifest ${meta.rows}` });
      if (exp.table_counts?.[table] !== undefined && parsed.rows.length !== exp.table_counts[table]) mismatches.push({ table, problem: "count differs from backup_run" });
      if (stableHash(parsed.rows) !== meta.sha256) mismatches.push({ table, problem: "hash mismatch" });
      verifiedCounts[table] = parsed.rows.length;
      exported[table] = parsed.rows;
      // Real restore of a sample into a scratch copy of the live table (skips empty tables; respects the deadline).
      if (parsed.rows.length > 0) {
        if (Date.now() - started > (opts.restoreDeadlineMs ?? RESTORE_TEST.deadlineMs)) restoreSkipped.push(table);
        else restoreResults.push(await restoreTableSample(admin, workspaceId, table, parsed.rows, opts.restoreRows));
      }
    };
    const restoreResults: RestoreTableResult[] = [];
    const restoreSkipped: string[] = [];
    await Promise.all(Array.from({ length: Math.min(RESTORE_TEST.concurrency, picked.length) }, reader));
    const restore = summariseRestore(restoreResults.sort((a, b) => a.table.localeCompare(b.table)), restoreSkipped.sort(), Date.now() - started);
    mismatches.push(...restore.problems);
    if (Object.keys(restore.findings.dropped_columns).length) hazards.columns_in_export_missing_from_live_schema = restore.findings.dropped_columns;
    if (restoreSkipped.length) hazards.restore_skipped_for_time = restoreSkipped;
    mismatches.sort((a, b) => a.table.localeCompare(b.table));

    if (exported.contact_method) {
      const exportedSupp = new Map(exported.contact_method.map((r) => [r.id, !!r.suppressed]));
      const { data: live } = await admin.from("contact_method").select("id, suppressed").eq("workspace_id", workspaceId).eq("suppressed", true);
      const reactivated = ((live ?? []) as Row[]).filter((r) => exportedSupp.has(r.id) && exportedSupp.get(r.id) === false).map((r) => r.id);
      if (reactivated.length) hazards.contact_suppressions_newer_than_export = reactivated;
    }
    if (exported.consent_permission) {
      const exp_ = new Map(exported.consent_permission.map((r) => [r.id, r]));
      const { data: live } = await admin.from("consent_permission").select("id, revoked_at, suppressed").eq("workspace_id", workspaceId);
      const undone = ((live ?? []) as Row[]).filter((r) => {
        const e = exp_.get(r.id);
        return e && ((r.revoked_at && !e.revoked_at) || (r.suppressed && !e.suppressed));
      }).map((r) => r.id);
      if (undone.length) hazards.consent_revocations_newer_than_export = undone;
    }
    if (exported.membership) {
      const { data: live } = await admin.from("membership").select("user_id").eq("workspace_id", workspaceId);
      const liveIds = new Set(((live ?? []) as Row[]).map((r) => r.user_id));
      const removed = exported.membership.filter((m) => !liveIds.has(m.user_id)).map((m) => m.user_id);
      if (removed.length) hazards.members_removed_since_export = removed;
    }

    const status = mismatches.length ? "failed" : Object.keys(hazards).length ? "warning" : "succeeded";
    const { data: done } = await admin.from("backup_run").update({
      status, finished_at: new Date().toISOString(), table_counts: verifiedCounts,
      findings: { mismatches, hazards, tables_checked: picked.length, duration_ms: Date.now() - started, restore: restore.findings,
        note: "Re-apply hazards after any restore so suppressed contacts and removed members are not reactivated." },
      error: mismatches.length ? `${mismatches.length} integrity mismatch(es)` : null,
    }).eq("id", run.id).eq("workspace_id", workspaceId).select().single();
    return done as Row;
  } catch (e) {
    await admin.from("backup_run").update({ status: "failed", finished_at: new Date().toISOString(), error: String(e).slice(0, 2000), findings: { mismatches, hazards } })
      .eq("id", run.id).eq("workspace_id", workspaceId);
    throw e;
  }
}

/** Remove an export's files (used by tests and retention pruning). */
export async function deleteExportFiles(admin: Admin, prefix: string) {
  const { data } = await admin.storage.from(BACKUP_BUCKET).list(prefix, { limit: 1000 });
  const paths = (data ?? []).map((f) => `${prefix}/${f.name}`);
  if (paths.length) await admin.storage.from(BACKUP_BUCKET).remove(paths);
}
