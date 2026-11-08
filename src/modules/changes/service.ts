import "server-only";
import type { Db } from "@/lib/supabase/server";
import { ChangeError, proposeChange, toChangeError, type PatchOp, type RiskLevel } from "@/lib/services/changes";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;

/**
 * Changes / approvals service (spec Part I §10, Part III "Transactional update and reversal algorithm").
 * Every state transition runs in a SECURITY DEFINER SQL function (app.approve_change / apply_change /
 * edit_change / reverse_change / preview_reverse) that re-checks role, row visibility, risk and the
 * hash-bound approval. This module is a thin typed wrapper plus queue/read models for the UI.
 * Works with a user client (actor = auth.uid()) or a service-role client with an explicit `actorUserId`.
 */

export type ProposalState = "proposed" | "approved" | "rejected" | "applied" | "reversed" | "conflict" | "expired" | "clarify";

export interface ProposalRow {
  id: string; workspace_id: string; target_type: string; target_id: string | null; operation: string;
  expected_version: number | null; patch: PatchOp[]; before: AnyRow | null; reason: string | null;
  evidence_ids: string[]; risk: RiskLevel; approval_required: boolean; state: ProposalState; proposed_by_kind: string;
  model: string | null; idempotency_key: string | null; capture_id: string | null; applied_audit_id: number | null;
  reversal_of: string | null; decided_by: string | null; decided_at: string | null; owner_user_id: string | null;
  classification: string; created_at: string; updated_at: string; row_version: number;
}

async function rpc<T = AnyRow>(db: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.schema("mudar_app").rpc(fn, args);
  if (error) throw toChangeError(error);
  return data as T;
}

export interface Actor { actorUserId?: string | null }

export function approveChange(db: Db, proposalId: string, opts: Actor & { note?: string; ttlHours?: number } = {}) {
  return rpc(db, "approve_change", { p_proposal: proposalId, p_decision: "approved", p_note: opts.note ?? null, p_ttl_hours: opts.ttlHours ?? 168, p_actor: opts.actorUserId ?? null });
}
export function rejectChange(db: Db, proposalId: string, opts: Actor & { note?: string } = {}) {
  return rpc(db, "approve_change", { p_proposal: proposalId, p_decision: "rejected", p_note: opts.note ?? null, p_ttl_hours: null, p_actor: opts.actorUserId ?? null });
}
/** Ask for clarification (keeps the proposal open; it can be edited, which invalidates any approval). */
export function clarifyChange(db: Db, proposalId: string, opts: Actor & { note: string }) {
  return rpc(db, "approve_change", { p_proposal: proposalId, p_decision: "clarify", p_note: opts.note, p_ttl_hours: null, p_actor: opts.actorUserId ?? null });
}
export async function applyChange(db: Db, proposalId: string, opts: Actor = {}) {
  const r = await rpc<{ status: string; proposal_id: string; target_id: string; applied_audit_id: number; row_version?: number; follow_up?: AnyRow }>(
    db, "apply_change", { p_proposal: proposalId, p_actor: opts.actorUserId ?? null });
  if (r.status === "applied") r.follow_up = await afterApply(db, proposalId, opts);
  return r;
}

/**
 * Follow-ups after an apply (each is itself a proposal, never a direct write):
 *  - a person created from an import's representative-name column => propose the employment link to that company
 *    (material: needs approval), carrying the same evidence (staged row + file).
 */
async function afterApply(db: Db, proposalId: string, opts: Actor): Promise<AnyRow | undefined> {
  const { data: p } = await db.from("change_proposal").select("id, workspace_id, idempotency_key, target_id, evidence_ids, classification, owner_user_id, reason")
    .eq("id", proposalId).maybeSingle();
  const key = p?.idempotency_key as string | null;
  if (!p || !key?.startsWith("imports.person:") || !p.target_id) return undefined;
  const orgId = key.split("|").pop()!;
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return undefined;
  const evidence = (p.evidence_ids ?? []) as string[];
  const { data: so } = evidence.length
    ? await db.from("source_object").select("id").eq("workspace_id", p.workspace_id).in("id", evidence).limit(1).maybeSingle()
    : { data: null };
  try {
    const e = await proposeChange(db, p.workspace_id, {
      targetType: "employment", operation: "create",
      patch: [
        { op: "add", path: "/person_id", value: p.target_id }, { op: "add", path: "/org_id", value: orgId },
        { op: "add", path: "/title", value: "Representative (named in import)" }, { op: "add", path: "/is_current", value: true },
        { op: "add", path: "/fact_status", value: "reported" }, ...(so ? [{ op: "add" as const, path: "/source_object_id", value: so.id }] : []),
      ],
      reason: `Link the person created from an import to the company they were named for (${(p.reason ?? "").slice(0, 160)})`,
      evidenceIds: evidence, proposedByKind: "job", idempotencyKey: `imports.employment:${p.id}`,
      classification: p.classification, ownerUserId: p.owner_user_id, actorUserId: opts.actorUserId ?? null,
    });
    return { employment_proposal_id: e.id };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
/** Approve then apply in one step (approval is still recorded and hash-bound). */
export async function approveAndApply(db: Db, proposalId: string, opts: Actor & { note?: string } = {}) {
  const approval = await approveChange(db, proposalId, opts);
  const applied = await applyChange(db, proposalId, opts);
  return { approval, applied };
}
/** Edit an undecided proposal's patch. Any existing approval stops matching (hash) and the proposal returns to the queue. */
export function editChange(db: Db, proposalId: string, patch: PatchOp[], opts: Actor & { reason?: string } = {}) {
  return rpc<ProposalRow>(db, "edit_change", { p_proposal: proposalId, p_patch: patch, p_reason: opts.reason ?? null, p_actor: opts.actorUserId ?? null });
}

export interface ReversePreview {
  proposal_id: string; reversible: boolean; reason?: string; kind?: string; risk?: RiskLevel; target_type?: string; target_id?: string;
  fields?: { path?: string; before?: unknown; applied?: unknown; current?: unknown; restorable?: boolean; table?: string; column?: string; count?: number }[];
  later_changes?: { audit_id: number; at: string; actor_user_id: string | null; change_proposal_id: string | null; fields: string[] }[];
  dependents?: { table: string; column: string; count: number }[];
  external_effects?: string;
}
export function previewReverse(db: Db, proposalId: string, opts: Actor = {}) {
  return rpc<ReversePreview>(db, "preview_reverse", { p_proposal: proposalId, p_actor: opts.actorUserId ?? null });
}

export interface ReverseResult { status: "reversed" | "partial" | "conflict"; proposal_id: string; reversal_proposal_id: string | null; restored: string[]; conflicts: AnyRow[] }
/** Compensating reversal. Fields edited later are kept and reported as conflicts; `paths` limits to selected fields. */
export function reverseChange(db: Db, proposalId: string, opts: Actor & { paths?: string[] } = {}) {
  return rpc<ReverseResult>(db, "reverse_change", { p_proposal: proposalId, p_actor: opts.actorUserId ?? null, p_paths: opts.paths ?? null });
}

/**
 * Batch undo. Proposals are reversed newest-applied first so dependent changes unwind before the changes they
 * depend on. Each item is independent (one failure does not roll back the others) and reported.
 */
export async function previewBatchReverse(db: Db, workspaceId: string, proposalIds: string[], opts: Actor = {}) {
  const ordered = await orderForReversal(db, workspaceId, proposalIds);
  const items: { id: string; preview?: ReversePreview; error?: { code: string; message: string } }[] = [];
  for (const id of ordered) {
    try { items.push({ id, preview: await previewReverse(db, id, opts) }); }
    catch (e) { const ce = e instanceof ChangeError ? e : toChangeError(e as Error); items.push({ id, error: { code: ce.code, message: ce.message } }); }
  }
  // dependency hint: a later proposal in the same batch touching the same record must be undone first
  const touched = new Map<string, string[]>();
  for (const it of items) {
    const k = it.preview?.target_id ? `${it.preview.target_type}:${it.preview.target_id}` : null;
    if (k) touched.set(k, [...(touched.get(k) ?? []), it.id]);
  }
  return { order: ordered, items, sharedRecords: [...touched.entries()].filter(([, v]) => v.length > 1).map(([k, ids]) => ({ record: k, proposals: ids })) };
}

export async function batchReverse(db: Db, workspaceId: string, proposalIds: string[], opts: Actor = {}) {
  const ordered = await orderForReversal(db, workspaceId, proposalIds);
  const results: { id: string; result?: ReverseResult; error?: { code: string; message: string } }[] = [];
  for (const id of ordered) {
    try { results.push({ id, result: await reverseChange(db, id, opts) }); }
    catch (e) { const ce = e instanceof ChangeError ? e : toChangeError(e as Error); results.push({ id, error: { code: ce.code, message: ce.message } }); }
  }
  return {
    results,
    reversed: results.filter((r) => r.result?.status === "reversed").length,
    partial: results.filter((r) => r.result && r.result.status !== "reversed").length,
    failed: results.filter((r) => r.error).length,
  };
}

async function orderForReversal(db: Db, workspaceId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db.from("change_proposal").select("id, applied_audit_id").eq("workspace_id", workspaceId).in("id", ids);
  if (error) throw error;
  const known = new Map((data ?? []).map((r) => [r.id as string, Number(r.applied_audit_id ?? 0)]));
  return [...new Set(ids)].sort((a, b) => (known.get(b) ?? 0) - (known.get(a) ?? 0));
}

/**
 * Routine internal change (spec §10 "Commit task or summary; notify with undo"): proposed and applied
 * immediately when the SQL risk floor is routine_internal; otherwise left in the approval queue.
 */
export async function commitRoutine(db: Db, workspaceId: string, input: Parameters<typeof proposeChange>[2]) {
  const p = await proposeChange(db, workspaceId, input);
  if (p.state === "applied") return { proposal: p, applied: true, undoProposalId: p.id };
  if (p.risk !== "routine_internal" || p.approval_required) return { proposal: p, applied: false, undoProposalId: null };
  const r = await applyChange(db, p.id, { actorUserId: input.actorUserId });
  return { proposal: { ...p, state: "applied" }, applied: r.status === "applied" || r.status === "already_applied", undoProposalId: p.id };
}

// ------------------------------------------------------------------ merges and person moves

/** Identity merge (always identity_merge risk -> admin approval). Loser is archived, references re-pointed, alias kept. */
export function proposeMerge(db: Db, workspaceId: string, m: Actor & { entityType: "organisation" | "person" | "asset"; winnerId: string; loserId: string; reason: string; evidenceIds?: string[]; idempotencyKey?: string }) {
  return proposeChange(db, workspaceId, {
    targetType: m.entityType, targetId: m.winnerId, operation: "merge",
    patch: [{ op: "replace", path: "/loser_id", value: m.loserId }],
    reason: m.reason, evidenceIds: m.evidenceIds, idempotencyKey: m.idempotencyKey, actorUserId: m.actorUserId,
  });
}

/**
 * Person job move (spec acceptance "Person move"): two proposals — close the prior employment (kept, with end date)
 * and create a new employment at the new company. Nothing else is copied: notes, interactions, requirements and
 * stakeholder roles stay with the old company, so no old-company confidential material reaches the new dossier.
 */
export async function proposePersonMove(db: Db, workspaceId: string, m: Actor & {
  personId: string; newOrgId: string; title?: string | null; startDate?: string | null; endDate?: string | null;
  reason: string; evidenceIds?: string[]; idempotencyKey?: string; classification?: string;
}) {
  const { data: current, error } = await db.from("employment").select("id, org_id, row_version, is_current")
    .eq("workspace_id", workspaceId).eq("person_id", m.personId).eq("is_current", true).is("archived_at", null);
  if (error) throw error;
  const key = m.idempotencyKey ?? `person-move:${m.personId}:${m.newOrgId}`;
  const out: AnyRow[] = [];
  for (const e of current ?? []) {
    if (e.org_id === m.newOrgId) continue;
    const patch: PatchOp[] = [{ op: "replace", path: "/is_current", value: false }];
    if (m.endDate) patch.push({ op: "replace", path: "/end_date", value: m.endDate }, { op: "replace", path: "/end_precision", value: "day" });
    out.push(await proposeChange(db, workspaceId, {
      targetType: "employment", targetId: e.id, expectedVersion: e.row_version, operation: "update", patch,
      reason: `${m.reason} (prior employment retained as history)`, evidenceIds: m.evidenceIds, idempotencyKey: `${key}:close:${e.id}`,
      actorUserId: m.actorUserId, classification: m.classification,
    }));
  }
  const create: PatchOp[] = [
    { op: "add", path: "/person_id", value: m.personId },
    { op: "add", path: "/org_id", value: m.newOrgId },
    { op: "add", path: "/is_current", value: true },
    { op: "add", path: "/fact_status", value: "reported" },
  ];
  if (m.title) create.push({ op: "add", path: "/title", value: m.title });
  if (m.startDate) create.push({ op: "add", path: "/start_date", value: m.startDate }, { op: "add", path: "/start_precision", value: "day" });
  out.push(await proposeChange(db, workspaceId, {
    targetType: "employment", operation: "create", patch: create, reason: m.reason, evidenceIds: m.evidenceIds,
    idempotencyKey: `${key}:new`, actorUserId: m.actorUserId, classification: m.classification,
  }));
  return out;
}

// ------------------------------------------------------------------ queue / read models

export type QueueTab = "records" | "merges" | "drafts" | "documents" | "history";

export async function listQueue(db: Db, workspaceId: string, tab: QueueTab, limit = 50) {
  if (tab === "drafts") {
    const { data, error } = await db.from("draft").select("id, channel, recipient_display, subject, body, state, purpose, created_at, content_hash, approved_hash, row_version")
      .eq("workspace_id", workspaceId).in("state", ["drafted", "approved"]).is("archived_at", null).order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return { drafts: data ?? [] };
  }
  if (tab === "documents") {
    const { data, error } = await db.from("document_version").select("*").eq("workspace_id", workspaceId).is("archived_at", null)
      .order("created_at", { ascending: false }).limit(limit);
    // documents may expose a status column owned by the deals module; surface whatever is pending if present
    if (error) return { documents: [], error: error.message };
    const pending = (data ?? []).filter((d: AnyRow) => !d.status || ["draft", "pending_approval", "proposed", "review"].includes(d.status));
    return { documents: pending };
  }
  let q = db.from("change_proposal").select("*").eq("workspace_id", workspaceId).is("archived_at", null).is("reversal_of", null);
  // Bulk import proposals are reviewed on the import's summary page, not one card at a time.
  if (tab === "records") q = q.neq("operation", "merge").in("state", ["proposed", "approved", "clarify"])
    .or("idempotency_key.is.null,and(idempotency_key.not.like.imports.conflict:*,idempotency_key.not.like.imports.person:*)");
  else if (tab === "merges") q = q.eq("operation", "merge").in("state", ["proposed", "approved", "clarify"]);
  else q = q.in("state", ["applied", "reversed", "conflict", "rejected"]);
  const { data, error } = await q.order(tab === "history" ? "updated_at" : "created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  const proposals = (data ?? []) as ProposalRow[];
  return { proposals: await withTargets(db, workspaceId, proposals) };
}

export interface ProposalView extends ProposalRow {
  target_label: string | null;
  current: Record<string, unknown> | null;
  current_version: number | null;
  stale: boolean;
}

const LABEL_COLS = ["display_name", "full_name", "title", "name", "summary"];

async function withTargets(db: Db, workspaceId: string, rows: ProposalRow[]): Promise<ProposalView[]> {
  const byType = new Map<string, string[]>();
  for (const r of rows) if (r.target_id) byType.set(r.target_type, [...(byType.get(r.target_type) ?? []), r.target_id]);
  const cache = new Map<string, AnyRow>();
  for (const [t, ids] of byType) {
    const { data } = await db.from(t).select("*").eq("workspace_id", workspaceId).in("id", [...new Set(ids)]);
    for (const row of data ?? []) cache.set(`${t}:${row.id}`, row);
  }
  return rows.map((r) => {
    const cur = r.target_id ? cache.get(`${r.target_type}:${r.target_id}`) ?? null : null;
    const label = cur ? (LABEL_COLS.map((c) => cur[c]).find((v) => typeof v === "string" && v) as string | undefined) ?? null : null;
    const fields = r.patch.map((p) => p.path.replace(/^\//, ""));
    const current = cur ? Object.fromEntries(fields.filter((f) => f in cur).map((f) => [f, cur[f]])) : null;
    const curVersion = cur ? Number(cur.row_version) : null;
    const stale = ["proposed", "approved", "clarify"].includes(r.state) && r.expected_version != null && curVersion != null && curVersion !== Number(r.expected_version);
    return { ...r, target_label: label, current, current_version: curVersion, stale };
  });
}

export async function getProposal(db: Db, workspaceId: string, id: string) {
  const { data, error } = await db.from("change_proposal").select("*").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new ChangeError("not_found", "change proposal");
  const [view] = await withTargets(db, workspaceId, [data as ProposalRow]);
  const { data: approvals } = await db.from("approval").select("id, approver_user_id, decision, note, expires_at, created_at, approved_hash")
    .eq("workspace_id", workspaceId).eq("subject_type", "change_proposal").eq("subject_id", id).order("created_at", { ascending: false });
  const { data: conflicts } = await db.from("change_conflict").select("*").eq("workspace_id", workspaceId).eq("proposal_id", id).order("created_at");
  let evidence: AnyRow[] = [];
  if (view.capture_id) {
    const { data: spans } = await db.from("capture_span").select("claim_kind, claim_index, source_locator, excerpt, result_id")
      .eq("workspace_id", workspaceId).eq("capture_id", view.capture_id).eq("result_id", id);
    evidence = spans ?? [];
  }
  return { proposal: view, approvals: approvals ?? [], conflicts: conflicts ?? [], evidence };
}

/** Same-day change digest (applied changes, newest first) for per-item and batch undo. */
export async function changeDigest(db: Db, workspaceId: string, sinceIso: string) {
  const { data, error } = await db.from("change_proposal").select("*").eq("workspace_id", workspaceId).is("reversal_of", null)
    .in("state", ["applied", "conflict"]).gte("updated_at", sinceIso).order("applied_audit_id", { ascending: false }).limit(200);
  if (error) throw error;
  return withTargets(db, workspaceId, (data ?? []) as ProposalRow[]);
}
