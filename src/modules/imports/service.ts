/*
 * User-facing service layer for /imports and /api/v1/imports/** (RLS client from requireContext()).
 * Thin wrappers over pipeline.ts that add role checks, HTTP error mapping and the inline-then-job processing policy.
 */
import "server-only";
import { HttpError, hasRole, type AppContext } from "@/lib/auth/context";
import { ForbiddenTargetError } from "@/lib/services/changes";
import { getAdapter, ADAPTERS } from "./detect";
import { enqueueProcess } from "./jobs";
import {
  type ApproveMappingInput, type ImportOptions, type ImportSourceKind, type MatchDecision, ImportError, approveMapping, decideMatch, getReconciliation, processBatch,
  registerImport, resolveException, resolveImportSource, sourceKey,
} from "./pipeline";

type Ctx = Pick<AppContext, "db" | "workspaceId" | "userId" | "role">;

export async function asHttp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ImportError) throw new HttpError(e.status, e.message);
    if (e instanceof ForbiddenTargetError) throw new HttpError(403, e.message);
    const code = (e as { code?: string })?.code;
    if (code === "42501") throw new HttpError(403, "not permitted");
    throw e;
  }
}

const REPROCESSABLE = ["registered", "completed", "completed_with_exceptions", "needs_mapping", "failed", "awaiting_source"];

/** Upload => register (hash/version/store) => enqueue a durable job => try to process inline for immediate feedback. */
export async function uploadImport(ctx: Ctx, file: { name: string; bytes: Uint8Array }, options: ImportOptions) {
  if (!hasRole(ctx, "editor")) throw new HttpError(403, "requires editor");
  if (options.classification === "licensed_restricted" && !hasRole(ctx, "owner")) {
    throw new HttpError(403, "only the workspace owner can import licensed/restricted sources (stored owner-only)");
  }
  return asHttp(async () => {
    const reg = await registerImport(ctx.db, { workspaceId: ctx.workspaceId, userId: ctx.userId, fileName: file.name, bytes: file.bytes, options });
    if (reg.duplicate) {
      return { batch_id: reg.batchId, source_object_id: reg.sourceObjectId, duplicate: true, version: reg.version, sha256: reg.sha256, status: "duplicate_noop" };
    }
    if (reg.sourceApproved === false) {
      // quarantined: stored and hashed, but nothing is read into the workbench until an admin approves the source
      const res = await processBatch(ctx.db, { workspaceId: ctx.workspaceId, batchId: reg.batchId });
      return { batch_id: reg.batchId, source_object_id: reg.sourceObjectId, duplicate: false, version: reg.version, sha256: reg.sha256,
        status: res.status, queued: false, error: res.error ?? null, counts: null };
    }
    let queued = true;
    try {
      await enqueueProcess(ctx.workspaceId, reg.batchId, 1);
    } catch {
      queued = false; // inline processing below still runs; the cron sweep re-enqueues stuck batches
    }
    const res = await processBatch(ctx.db, { workspaceId: ctx.workspaceId, batchId: reg.batchId });
    return {
      batch_id: reg.batchId, source_object_id: reg.sourceObjectId, duplicate: false, version: reg.version, sha256: reg.sha256,
      status: res.status, queued, error: res.error ?? null, counts: res.counts ?? null,
    };
  });
}

export async function reprocess(ctx: Ctx, batchId: string) {
  return asHttp(async () => {
    const res = await processBatch(ctx.db, { workspaceId: ctx.workspaceId, batchId, allowFrom: REPROCESSABLE });
    if (res.status === "skipped") throw new HttpError(409, "batch is being processed; try again shortly");
    return res;
  });
}

export async function approveMappingAndReprocess(ctx: Ctx, input: ApproveMappingInput) {
  if (!hasRole(ctx, "admin")) throw new HttpError(403, "approving a schema mapping requires the admin role");
  return asHttp(async () => {
    const mapping = await approveMapping(ctx.db, ctx.workspaceId, ctx.userId, input);
    const res = await processBatch(ctx.db, { workspaceId: ctx.workspaceId, batchId: input.batchId, allowFrom: REPROCESSABLE });
    return { mapping_id: mapping.id, mapping_version: mapping.version, status: res.status, counts: res.counts ?? null };
  });
}

export async function decideCandidate(ctx: Ctx, candidateId: string, decision: MatchDecision) {
  if (!hasRole(ctx, "editor")) throw new HttpError(403, "requires editor");
  return asHttp(() => decideMatch(ctx.db, ctx.workspaceId, ctx.userId, candidateId, decision));
}

export async function closeException(ctx: Ctx, id: string, status: "resolved" | "dismissed", note: string | null) {
  if (!hasRole(ctx, "editor")) throw new HttpError(403, "requires editor");
  return asHttp(() => resolveException(ctx.db, ctx.workspaceId, ctx.userId, id, status, note));
}

export async function reconciliation(ctx: Ctx, batchId: string) {
  return asHttp(async () => {
    const { batch, source } = await getReconciliation(ctx.db, ctx.workspaceId, batchId);
    return {
      batch_id: batch.id, file_name: batch.file_name, status: batch.status, adapter: batch.adapter, adapter_version: batch.adapter_version,
      mapping_version: batch.mapping_version, source: source ?? null, reconciliation: batch.counts, diff: batch.diff, error: batch.error,
      sheets: (batch.sheets ?? []).map((s: Record<string, unknown>) => ({
        sheet: s.sheet, status: s.status, adapter: s.adapter, role: s.role, signature: s.signature, mapping_source: s.mapping_source,
        rows_considered: s.rows_considered, layout_rows: s.layout_rows,
      })),
      created_at: batch.created_at, finished_at: batch.finished_at,
    };
  });
}

export async function listBatches(ctx: Ctx, limit = 50) {
  const { data, error } = await ctx.db.from("import_batch")
    .select("id, file_name, status, adapter, counts, diff, error, created_at, finished_at, source_object:source_object_id(version, sha256)")
    .eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function batchDetail(ctx: Ctx, batchId: string) {
  const db = ctx.db;
  const { batch, source } = await getReconciliation(db, ctx.workspaceId, batchId).catch((e) => {
    if (e instanceof ImportError && e.status === 404) return { batch: null, source: null };
    throw e;
  });
  if (!batch) return null;
  const [exc, quarantined, candidates] = await Promise.all([
    db.from("import_exception").select("id, sheet, locator, kind, severity, message, details, status, resolution_note")
      .eq("workspace_id", ctx.workspaceId).eq("batch_id", batchId).order("status").order("severity").order("locator").limit(300),
    db.from("staged_row").select("id, sheet, row_number, locator, reason, raw_json, flags")
      .eq("workspace_id", ctx.workspaceId).eq("batch_id", batchId).eq("status", "quarantined").order("sheet").order("row_number").limit(100),
    db.from("identity_match_candidate").select("id, entity_type, left_id, right_id, right_raw, score, evidence, suggested, decision, change_proposal_id")
      .eq("workspace_id", ctx.workspaceId).eq("batch_id", batchId).order("decision").order("score", { ascending: false }).limit(200),
  ]);
  return { batch, source, exceptions: exc.data ?? [], quarantined: quarantined.data ?? [], candidates: candidates.data ?? [] };
}

/** Serializable list of column-mappable adapter roles for the mapping-review form. */
export function mappableRoles() {
  return ADAPTERS.flatMap((a) => a.roles.filter((r) => r.fields).map((r) => ({
    adapter: a.id, role: r.role, label: `${a.label} — ${r.label}`, headerless: !!r.headerless, positionalDefault: r.positionalDefault ?? null,
    fields: r.fields!.map((f) => ({ key: f.key, label: f.label, required: !!f.required })),
  })));
}

export const adapterLabel = (id: string | null | undefined) => (id ? id.split(",").map((x) => getAdapter(x)?.label ?? x).join(", ") : "—");

/* ------------------------------------------------------------------ approved import sources */

export async function listSources(ctx: Ctx) {
  await asHttp(() => resolveImportSource(ctx.db, ctx.workspaceId, ctx.userId, null)); // make sure the default exists
  const { data, error } = await ctx.db.from("import_source").select("id, name, kind, location, approved, approved_at, is_default, note, created_at, archived_at")
    .eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("approved", { ascending: false }).order("name");
  if (error) throw error;
  const { data: waiting } = await ctx.db.from("import_batch").select("id, import_source_id").eq("workspace_id", ctx.workspaceId).eq("status", "awaiting_source");
  const counts = new Map<string, number>();
  for (const b of waiting ?? []) counts.set(b.import_source_id, (counts.get(b.import_source_id) ?? 0) + 1);
  return (data ?? []).map((r) => ({ ...r, waiting: counts.get(r.id) ?? 0 }));
}

const KINDS: ImportSourceKind[] = ["folder", "export", "connector", "email", "other"];

/** Register a source. Editors register it unapproved; admins may approve at once (DB guard enforces this). */
export async function createSource(ctx: Ctx, input: { name: string; kind?: string; location?: string | null; approve?: boolean; note?: string | null }) {
  if (!hasRole(ctx, "editor")) throw new HttpError(403, "requires editor");
  const name = input.name.trim().slice(0, 120);
  if (name.length < 2) throw new HttpError(400, "source name is required");
  const kind = (KINDS as string[]).includes(input.kind ?? "") ? (input.kind as ImportSourceKind) : "other";
  const approve = !!input.approve && hasRole(ctx, "admin");
  const { data, error } = await ctx.db.from("import_source").insert({
    workspace_id: ctx.workspaceId, name, name_key: sourceKey(name), kind, location: input.location?.slice(0, 300) || null,
    note: input.note?.slice(0, 500) || null, approved: approve, created_by: ctx.userId,
  }).select("id, name, approved").single();
  if (error) {
    if (error.code === "23505") throw new HttpError(409, "a source with this name already exists");
    if (error.code === "42501") throw new HttpError(403, error.message);
    throw error;
  }
  return data;
}

/** Admin approves a source, then every batch quarantined for it is processed. */
export async function approveSource(ctx: Ctx, sourceId: string) {
  if (!hasRole(ctx, "admin")) throw new HttpError(403, "approving an import source requires the admin role");
  const { data, error } = await ctx.db.from("import_source").update({ approved: true }).eq("workspace_id", ctx.workspaceId).eq("id", sourceId).select("id").maybeSingle();
  if (error) throw error.code === "42501" ? new HttpError(403, error.message) : error;
  if (!data) throw new HttpError(404, "source not found");
  const { data: waiting } = await ctx.db.from("import_batch").select("id").eq("workspace_id", ctx.workspaceId).eq("import_source_id", sourceId).eq("status", "awaiting_source");
  const processed: { batch_id: string; status: string }[] = [];
  for (const b of waiting ?? []) {
    const r = await asHttp(() => processBatch(ctx.db, { workspaceId: ctx.workspaceId, batchId: b.id, allowFrom: ["awaiting_source"] }));
    processed.push({ batch_id: b.id, status: r.status });
  }
  return { source_id: sourceId, approved: true, processed };
}

export async function revokeSource(ctx: Ctx, sourceId: string) {
  if (!hasRole(ctx, "admin")) throw new HttpError(403, "revoking an import source requires the admin role");
  const { data, error } = await ctx.db.from("import_source").update({ approved: false, approved_at: null }).eq("workspace_id", ctx.workspaceId).eq("id", sourceId).select("id").maybeSingle();
  if (error) throw error.code === "42501" ? new HttpError(403, error.message) : error;
  if (!data) throw new HttpError(404, "source not found");
  return { source_id: sourceId, approved: false };
}

/** Field conflicts and steward proposals (conflict fixes, person candidates) raised by one batch, for the batch page. */
export async function batchSteward(ctx: Ctx, batchId: string, sourceObjectId: string | null) {
  const [conf, props] = await Promise.all([
    ctx.db.from("field_conflict").select("id, entity_type, entity_id, field, master_value, source_value, material, source_locator, status, change_proposal_id")
      .eq("workspace_id", ctx.workspaceId).eq("batch_id", batchId).order("status").order("entity_type").limit(200),
    sourceObjectId
      ? ctx.db.from("change_proposal").select("id, target_type, operation, patch, state, risk, reason, idempotency_key")
        .eq("workspace_id", ctx.workspaceId).like("idempotency_key", "imports.person:%").contains("evidence_ids", [sourceObjectId]).order("created_at").limit(200)
      : Promise.resolve({ data: [] }),
  ]);
  return { conflicts: conf.data ?? [], personProposals: props.data ?? [] };
}
