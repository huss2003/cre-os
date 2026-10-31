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
  type ApproveMappingInput, type ImportOptions, type MatchDecision, ImportError, approveMapping, decideMatch, getReconciliation, processBatch,
  registerImport, resolveException,
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

const REPROCESSABLE = ["registered", "completed", "completed_with_exceptions", "needs_mapping", "failed"];

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
