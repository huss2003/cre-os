/*
 * Multi-file batch runs (Input Engine spec §10). Each file of a run is registered independently (hash, preserved
 * original, version) and processed by its own background job, so one failing file never loses another file's results.
 *   - spreadsheets (.xlsx/.csv): registerImport + job imports.process (allowFrom registered|failed => temporary failures retry)
 *   - documents / images (pdf, docx, png, jpg, ...): capture module's exported createCapture (it enqueues capture.process)
 *   - anything else (incl. legacy .xls): kept as a failed item with a plain reason (permanent; not retried)
 * Nothing is processed inline: the upload returns at once and the user keeps working; progress is read from the items.
 * Idempotent: the same Idempotency-Key returns the same run; the same file bytes re-use the existing import (no duplicates).
 */
import "server-only";
import type { Db } from "@/lib/supabase/server";
import { createCapture } from "@/modules/capture/service";
import { enqueueProcess } from "./jobs";
import { BUCKET, type ImportOptions, ImportError, MAX_IMPORT_BYTES, processBatch, registerImport, sha256Hex } from "./pipeline";
import { type RunItemLike, type RunReport, itemStatus, runReport } from "./report";

export const MAX_RUN_FILES = 50;
const SHEET_RE = /\.(xlsx|csv|txt)$/i;
const DOC_RE = /\.(pdf|docx?|pptx?|rtf|odt|png|jpe?g|gif|webp|heic|tiff?|bmp)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i;

export const LEGACY_XLS_NOTE = "Old format — save as .docx/.pptx/.xlsx for full extraction. This .xls was not read; open it in Excel, save as .xlsx and add it again.";

/** Temporary failures (network, storage, timeouts, 5xx) are retried; malformed / unsupported files are not. */
export function classifyImportError(msg: string | null | undefined): "temporary" | "permanent" {
  const m = String(msg ?? "");
  if (/legacy binary|unsupported file|not parsed|central directory|corrupt|invalid zip|does not match its recorded sha|outside this workspace|too large|empty file|upload an \.xlsx|not an approved import source/i.test(m)) return "permanent";
  return "temporary";
}

export function fileKind(name: string): "spreadsheet" | "document" | "unsupported" {
  if (SHEET_RE.test(name)) return "spreadsheet";
  if (DOC_RE.test(name)) return "document";
  return "unsupported";
}

export interface RunFile { name: string; type?: string; bytes: Uint8Array; tooLarge?: boolean }

export async function createRun(db: Db, ws: string, userId: string, files: RunFile[], opts: { idempotencyKey?: string | null; label?: string | null; options?: ImportOptions } = {}) {
  if (!files.length) throw new ImportError(400, "add at least one file");
  if (files.length > MAX_RUN_FILES) throw new ImportError(400, `at most ${MAX_RUN_FILES} files per batch`);
  if (opts.idempotencyKey) {
    const { data: prior } = await db.from("import_run").select("id").eq("workspace_id", ws).eq("idempotency_key", opts.idempotencyKey).maybeSingle();
    if (prior) return { run_id: prior.id as string, duplicate: true };
  }
  const { data: run, error } = await db.from("import_run").insert({
    workspace_id: ws, owner_user_id: userId, created_by: userId, label: opts.label ?? null, status: "processing", file_count: files.length,
    idempotency_key: opts.idempotencyKey ?? null, classification: opts.options?.classification ?? "corporate_confidential",
  }).select("id").single();
  if (error) throw error;
  const runId = run.id as string;

  for (const [position, f] of files.entries()) {
    const kind = fileKind(f.name);
    const base = { workspace_id: ws, owner_user_id: userId, run_id: runId, position, file_name: f.name.slice(0, 250), size_bytes: f.bytes.length, sha256: f.bytes.length ? sha256Hex(f.bytes) : null, kind };
    try {
      if (kind === "unsupported") {
        let why = "This file type is not supported (spreadsheets: .xlsx/.csv; documents: PDF, Word, images).";
        if (/\.xls$/i.test(f.name)) {
          // the original is always preserved (read-only copy) even though it cannot be parsed
          const kept = f.bytes.length ? await db.storage.from(BUCKET).upload(`${ws}/imports/legacy/${base.sha256}/${f.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120)}`, f.bytes, { contentType: "application/vnd.ms-excel", upsert: false }) : null;
          why = `${LEGACY_XLS_NOTE}${kept && (!kept.error || /exists|duplicate/i.test(kept.error.message)) ? " The original file is kept." : ""}`;
        }
        await insertItem(db, { ...base, status: "failed", error: why, error_kind: "permanent" });
        continue;
      }
      if (f.tooLarge || f.bytes.length > MAX_IMPORT_BYTES) throw new ImportError(413, "file too large (25 MB max)");
      if (kind === "spreadsheet") {
        const reg = await registerImport(db, { workspaceId: ws, userId, fileName: f.name, bytes: f.bytes, options: opts.options });
        if (!reg.duplicate) {
          await db.from("import_batch").update({ run_id: runId }).eq("workspace_id", ws).eq("id", reg.batchId);
          try { await enqueueProcess(ws, reg.batchId, `run:${runId}`, ["registered", "failed"]); } catch { /* cron sweep picks registered batches up */ }
        }
        await insertItem(db, { ...base, batch_id: reg.batchId, status: reg.duplicate ? "duplicate" : "queued" });
      } else {
        const { capture, duplicate } = await createCapture(db, ws, userId, {
          kind: IMAGE_RE.test(f.name) ? "image" : "mixed", text: null, classification: opts.options?.classification ?? undefined,
          file: { name: f.name, type: f.type || "application/octet-stream", bytes: f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer },
        }, `import_run:${runId}:${position}`);
        await insertItem(db, { ...base, capture_id: capture.id, status: duplicate ? "duplicate" : "queued" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await insertItem(db, { ...base, status: "failed", error: msg.slice(0, 1000), error_kind: e instanceof ImportError && e.status < 500 ? "permanent" : classifyImportError(msg) });
    }
  }
  await refreshRun(db, ws, runId);
  return { run_id: runId, duplicate: false };
}

async function insertItem(db: Db, row: Record<string, unknown>) {
  const { error } = await db.from("import_run_item").insert(row);
  if (error) throw error;
}

interface ItemRow {
  id: string; run_id: string; position: number; file_name: string; kind: string; status: string; error: string | null; error_kind: string | null;
  attempts: number; batch_id: string | null; capture_id: string | null; size_bytes: number | null; sha256: string | null;
}

async function loadItems(db: Db, ws: string, runIds: string[]) {
  if (!runIds.length) return [];
  const { data: items, error } = await db.from("import_run_item").select("id, run_id, position, file_name, kind, status, error, error_kind, attempts, batch_id, capture_id, size_bytes, sha256")
    .eq("workspace_id", ws).in("run_id", runIds).order("position");
  if (error) throw error;
  const its = (items ?? []) as ItemRow[];
  const bIds = its.map((i) => i.batch_id).filter(Boolean) as string[];
  const cIds = its.map((i) => i.capture_id).filter(Boolean) as string[];
  const [{ data: batches }, { data: caps }] = await Promise.all([
    bIds.length ? db.from("import_batch").select("id, status, counts, error, file_name").eq("workspace_id", ws).in("id", bIds) : Promise.resolve({ data: [] }),
    cIds.length ? db.from("capture").select("id, status, error").eq("workspace_id", ws).in("id", cIds) : Promise.resolve({ data: [] }),
  ]);
  const bm = new Map((batches ?? []).map((b: { id: string }) => [b.id, b]));
  const cm = new Map((caps ?? []).map((c: { id: string }) => [c.id, c]));
  return its.map((i) => {
    const batch = i.batch_id ? (bm.get(i.batch_id) as RunItemLike["batch"] & { id: string }) ?? null : null;
    const capture = i.capture_id ? (cm.get(i.capture_id) as RunItemLike["capture"]) ?? null : null;
    const like: RunItemLike = { file_name: i.file_name, kind: i.kind, status: i.status, error: i.error, error_kind: i.error_kind, attempts: i.attempts, batch, capture };
    const st = itemStatus(like);
    const err = i.error ?? batch?.error ?? capture?.error ?? null;
    return { ...i, batch, capture, live_status: st, error: st === "failed" ? err : i.error, error_kind: st === "failed" ? (i.error_kind ?? classifyImportError(err)) : i.error_kind, like: { ...like, error: st === "failed" ? err : i.error, error_kind: st === "failed" ? (i.error_kind ?? classifyImportError(err)) : i.error_kind } };
  });
}

/** Recompute item statuses + the run report; persist them (status flips to completed / completed_with_failures when all done). */
export async function refreshRun(db: Db, ws: string, runId: string): Promise<{ report: RunReport; items: Awaited<ReturnType<typeof loadItems>> }> {
  const items = await loadItems(db, ws, [runId]);
  const report = runReport(items.map((i) => i.like));
  for (const i of items) {
    if (i.live_status !== i.status || (i.live_status === "failed" && i.error_kind !== null && i.error === null)) {
      await db.from("import_run_item").update({ status: i.live_status, error: i.error, error_kind: i.live_status === "failed" ? i.error_kind : null }).eq("workspace_id", ws).eq("id", i.id);
    }
  }
  const status = !report.done ? "processing" : report.files_failed === report.files_received ? "failed" : report.files_failed ? "completed_with_failures" : "completed";
  await db.from("import_run").update({ report, status, finished_at: report.done ? new Date().toISOString() : null }).eq("workspace_id", ws).eq("id", runId);
  return { report, items };
}

export async function getRun(db: Db, ws: string, runId: string) {
  const { data: run, error } = await db.from("import_run").select("id, label, status, file_count, report, created_at, finished_at").eq("workspace_id", ws).eq("id", runId).maybeSingle();
  if (error) throw error;
  if (!run) return null;
  const { report, items } = await refreshRun(db, ws, runId);
  return { run: { ...run, report }, items };
}

export async function listRuns(db: Db, ws: string, limit = 20) {
  const { data, error } = await db.from("import_run").select("id, label, status, file_count, report, created_at, finished_at")
    .eq("workspace_id", ws).is("archived_at", null).order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  const runs = data ?? [];
  // refresh unfinished runs so progress is current
  for (const r of runs) if (r.status === "processing" || r.status === "queued") Object.assign(r, { report: (await refreshRun(db, ws, r.id)).report });
  return runs;
}

/**
 * Retry failed items of a run (or one item). Temporary failures of spreadsheets are re-processed (inline when
 * `inline`, otherwise via a new job); permanent failures are reported back unchanged. Successful items are untouched.
 */
export async function retryRun(db: Db, ws: string, runId: string, opts: { itemId?: string | null; inline?: boolean } = {}) {
  const items = (await loadItems(db, ws, [runId])).filter((i) => i.live_status === "failed" && (!opts.itemId || i.id === opts.itemId));
  const out: { item_id: string; file_name: string; result: string }[] = [];
  for (const i of items) {
    if (i.error_kind === "permanent" || i.kind === "unsupported" || !i.batch_id) { out.push({ item_id: i.id, file_name: i.file_name, result: "not_retryable" }); continue; }
    await db.from("import_run_item").update({ attempts: (i.attempts ?? 0) + 1, status: "queued", error: null, error_kind: null }).eq("workspace_id", ws).eq("id", i.id);
    // Put the batch back in the queue too: otherwise its stale "failed" status makes the item (and the run) look
    // finished until the job starts, and the batch page stops auto-refreshing.
    await db.from("import_batch").update({ status: "registered", error: null }).eq("workspace_id", ws).eq("id", i.batch_id).eq("status", "failed");
    if (opts.inline) {
      const res = await processBatch(db, { workspaceId: ws, batchId: i.batch_id, allowFrom: ["failed", "registered"] });
      out.push({ item_id: i.id, file_name: i.file_name, result: res.status });
    } else {
      await enqueueProcess(ws, i.batch_id, `retry:${i.id}:${(i.attempts ?? 0) + 1}`, ["failed", "registered"]);
      out.push({ item_id: i.id, file_name: i.file_name, result: "queued" });
    }
  }
  const { report } = await refreshRun(db, ws, runId);
  return { retried: out, report };
}
