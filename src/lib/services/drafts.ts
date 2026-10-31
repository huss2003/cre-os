import "server-only";
import type { Db } from "@/lib/supabase/server";
import { sha256 } from "@/lib/util/crypto";

/**
 * External message drafts. There is NO send capability anywhere in CRE OS (spec: manual send MVP).
 * Approval binds to content_hash; any change to recipient/subject/body/attachments invalidates it.
 * Lifecycle: drafted -> approved -> opened_for_send (user opened mail/WhatsApp/LinkedIn link) -> marked_sent
 * (user assertion) -> reconciled_sent (Sent Items evidence). Each step is a separate draft_event row
 * plus the generic audit trigger. A DB trigger (integrations_draft_guard) enforces the same rules.
 * Owned by the integrations module (see src/modules/integrations/README.md).
 */
export type DraftChannel = "email" | "whatsapp" | "linkedin" | "calendar_invite" | "introduction" | "market_note" | "post";
export type DraftState = "drafted" | "approved" | "opened_for_send" | "marked_sent" | "reconciled_sent" | "discarded" | "paused";

export interface NewDraft {
  channel: DraftChannel;
  recipientPersonId?: string | null;
  recipientDisplay?: string | null;
  recipientAddress?: string | null;
  subject?: string | null;
  body: string;
  attachmentDocumentIds?: string[];
  opportunityId?: string | null;
  orgId?: string | null;
  purpose?: string;
  sequenceKey?: string; sequenceStep?: number;
  createdByKind?: "user" | "job" | "model";
  classification?: string;
  /** Row owner (RLS visibility). Defaults to null (owner/admin/see-all only) — pass the acting user when known. */
  ownerUserId?: string | null;
}

export interface DraftRow {
  id: string; workspace_id: string; channel: DraftChannel; state: DraftState;
  recipient_person_id: string | null; recipient_display: string | null; recipient_address: string | null;
  subject: string | null; body: string; attachment_document_ids: string[];
  opportunity_id: string | null; org_id: string | null; sequence_key: string | null; sequence_step: number | null;
  purpose: string | null; content_hash: string; approved_hash: string | null; approved_by: string | null; approved_at: string | null;
  marked_sent_at: string | null; marked_sent_by: string | null; sent_evidence: string | null; pause_reason: string | null;
  owner_user_id: string | null; row_version: number; created_at: string; updated_at: string; created_by_kind: string;
}

/**
 * Canonical content hash. MUST stay byte-identical with app.draft_content_hash() in
 * supabase/migrations/20261031001410_integrations_draft_security.sql — the DB recomputes it on every write and
 * rejects a mismatching client hash, so approvals bind to what is really stored.
 */
export function draftHash(d: { recipient_person_id?: string | null; recipient_address?: string | null; subject?: string | null; body: string; attachment_document_ids?: string[] | null }) {
  const f = (x: string | null | undefined) => (x === null || x === undefined ? "~" : `${Buffer.byteLength(x, "utf8")}:${x}`);
  const att = [...(d.attachment_document_ids ?? [])].map((a) => a.toLowerCase()).sort().join(",");
  return sha256(["draft.v1", f(d.recipient_person_id ?? null), f(d.recipient_address ?? null), f(d.subject ?? null), f(d.body), f(att)].join("|"));
}

export class SuppressedRecipientError extends Error {}
export class DraftStateError extends Error {}
export class DraftConflictError extends Error {}
export class DraftForbiddenError extends Error {}

/** Map errors raised by the app.*_draft definer functions to the service's error classes. */
function mapRpcError(error: { code?: string; message: string }): Error {
  switch (error.code) {
    case "CRSUP": return new SuppressedRecipientError(error.message);
    case "40001": return new DraftConflictError(error.message);
    case "42501": return new DraftForbiddenError(error.message);
    case "P0002": return new DraftStateError("draft not found");
    case "22023": return new DraftStateError(error.message);
    default: return Object.assign(new Error(error.message), { code: error.code });
  }
}

/** Same normalisation as contact_method.value_hash (sha256(lower(trim(value)))). */
export function contactValueHash(value: string): string {
  return sha256(value.trim().toLowerCase());
}

/** Throws SuppressedRecipientError when the person is suppressed / consent revoked for the channel. */
export async function assertNotSuppressed(db: Db, workspaceId: string, personId: string | null | undefined, channel: string) {
  if (!personId) return;
  const { data } = await db.from("consent_permission").select("id, channel, suppressed, revoked_at")
    .eq("workspace_id", workspaceId).eq("person_id", personId);
  const blocked = (data ?? []).some((c) => c.suppressed || (c.revoked_at && (!c.channel || c.channel === channel)));
  const { data: cm } = await db.from("contact_method").select("id").eq("workspace_id", workspaceId).eq("person_id", personId).eq("suppressed", true).limit(1);
  const { data: tomb } = await db.from("suppression_tombstone").select("id").eq("workspace_id", workspaceId).eq("person_id", personId).limit(1);
  if (blocked || (cm?.length ?? 0) > 0 || (tomb?.length ?? 0) > 0) throw new SuppressedRecipientError("Recipient is suppressed or consent revoked");
}

/** Address-level suppression: tombstones (survive erasure) and suppressed contact methods with the same value hash. */
export async function assertAddressNotSuppressed(db: Db, workspaceId: string, address: string | null | undefined) {
  if (!address || !address.trim()) return;
  const h = contactValueHash(address);
  const { data: tomb } = await db.from("suppression_tombstone").select("id").eq("workspace_id", workspaceId).eq("value_hash", h).limit(1);
  const { data: cm } = await db.from("contact_method").select("id").eq("workspace_id", workspaceId).eq("value_hash", h).eq("suppressed", true).limit(1);
  if ((tomb?.length ?? 0) > 0 || (cm?.length ?? 0) > 0) throw new SuppressedRecipientError("Recipient address is suppressed");
}

export async function assertRecipientAllowed(db: Db, workspaceId: string, d: { recipient_person_id?: string | null; recipient_address?: string | null; channel: string }) {
  await assertNotSuppressed(db, workspaceId, d.recipient_person_id, d.channel);
  await assertAddressNotSuppressed(db, workspaceId, d.recipient_address);
}

/** Append a lifecycle event. Best-effort: the generic audit trigger on `draft` remains the system of record. */
export async function recordDraftEvent(db: Db, workspaceId: string, e: {
  draftId: string; event: string; actorUserId?: string | null; actorKind?: "user" | "job" | "system"; contentHash?: string | null; evidence?: string | null; ownerUserId?: string | null;
}) {
  const { error } = await db.from("draft_event").insert({
    workspace_id: workspaceId, draft_id: e.draftId, event: e.event, actor_user_id: e.actorUserId ?? null, actor_kind: e.actorKind ?? "user",
    content_hash: e.contentHash ?? null, evidence: e.evidence ?? null, owner_user_id: e.ownerUserId ?? e.actorUserId ?? null,
  });
  if (error) console.warn("draft_event insert failed", error.message);
}

export async function createDraft(db: Db, workspaceId: string, d: NewDraft) {
  await assertNotSuppressed(db, workspaceId, d.recipientPersonId, d.channel);
  await assertAddressNotSuppressed(db, workspaceId, d.recipientAddress);
  const row = {
    workspace_id: workspaceId,
    channel: d.channel,
    recipient_person_id: d.recipientPersonId ?? null,
    recipient_display: d.recipientDisplay ?? null,
    recipient_address: d.recipientAddress ?? null,
    subject: d.subject ?? null,
    body: d.body,
    attachment_document_ids: d.attachmentDocumentIds ?? [],
    opportunity_id: d.opportunityId ?? null,
    org_id: d.orgId ?? null,
    purpose: d.purpose ?? null,
    sequence_key: d.sequenceKey ?? null,
    sequence_step: d.sequenceStep ?? null,
    created_by_kind: d.createdByKind ?? "user",
    classification: d.classification ?? "corporate_confidential",
    ...(d.ownerUserId ? { owner_user_id: d.ownerUserId } : {}),
  };
  const { data, error } = await db.from("draft").insert({ ...row, content_hash: draftHash(row) }).select().single();
  if (error) throw error;
  await recordDraftEvent(db, workspaceId, {
    draftId: data.id, event: "drafted", actorUserId: d.createdByKind === "user" ? d.ownerUserId ?? null : null,
    actorKind: d.createdByKind === "user" || !d.createdByKind ? "user" : "job", contentHash: data.content_hash, ownerUserId: d.ownerUserId ?? null,
  });
  return data as DraftRow;
}

export async function getDraft(db: Db, workspaceId: string, id: string): Promise<DraftRow> {
  const { data, error } = await db.from("draft").select("*").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new DraftStateError("draft not found");
  return data as DraftRow;
}

export interface DraftEdit {
  recipientPersonId?: string | null;
  recipientDisplay?: string | null;
  recipientAddress?: string | null;
  subject?: string | null;
  body?: string;
  attachmentDocumentIds?: string[];
}

/**
 * Edit content. Any change to recipient/subject/body/attachments recomputes content_hash and invalidates approval
 * (state back to 'drafted'). Optimistic concurrency via expectedVersion.
 */
export async function updateDraft(db: Db, workspaceId: string, id: string, edit: DraftEdit, opts: { expectedVersion?: number; actorUserId?: string | null } = {}) {
  const cur = await getDraft(db, workspaceId, id);
  if (["marked_sent", "reconciled_sent", "discarded"].includes(cur.state)) throw new DraftStateError(`cannot edit a ${cur.state} draft`);
  const next = {
    recipient_person_id: edit.recipientPersonId !== undefined ? edit.recipientPersonId : cur.recipient_person_id,
    recipient_address: edit.recipientAddress !== undefined ? edit.recipientAddress : cur.recipient_address,
    recipient_display: edit.recipientDisplay !== undefined ? edit.recipientDisplay : cur.recipient_display,
    subject: edit.subject !== undefined ? edit.subject : cur.subject,
    body: edit.body !== undefined ? edit.body : cur.body,
    attachment_document_ids: edit.attachmentDocumentIds !== undefined ? edit.attachmentDocumentIds : cur.attachment_document_ids,
  };
  const hash = draftHash(next);
  const changed = hash !== cur.content_hash;
  if (changed && (next.recipient_person_id !== cur.recipient_person_id || next.recipient_address !== cur.recipient_address)) {
    await assertRecipientAllowed(db, workspaceId, { ...next, channel: cur.channel });
  }
  // The DB guard verifies content_hash and drops any approval when it changes (state approved/opened -> drafted).
  const patch: Record<string, unknown> = { ...next, content_hash: hash };
  const invalidated = changed && !!cur.approved_hash;
  const { data, error } = await db.from("draft").update(patch).eq("workspace_id", workspaceId).eq("id", id)
    .eq("row_version", opts.expectedVersion ?? cur.row_version).select().maybeSingle();
  if (error) throw error;
  if (!data) throw new DraftConflictError("draft changed since it was loaded; reload and retry");
  if (changed) await recordDraftEvent(db, workspaceId, { draftId: id, event: "edited", actorUserId: opts.actorUserId, contentHash: hash, ownerUserId: cur.owner_user_id });
  if (invalidated) await recordDraftEvent(db, workspaceId, { draftId: id, event: "approval_invalidated", actorUserId: opts.actorUserId, contentHash: hash, evidence: `previous approved hash ${cur.approved_hash}`, ownerUserId: cur.owner_user_id });
  return { draft: data as DraftRow, approvalInvalidated: invalidated };
}

/**
 * Hash-bound approval through the SECURITY DEFINER app.approve_draft (role + suppression + hash checks, approval row,
 * draft_event). `reviewedHash` (what the user saw) must equal the current content hash, else DraftConflictError.
 */
export async function approveDraft(db: Db, workspaceId: string, id: string, _actorUserId: string, opts: { reviewedHash?: string; note?: string; expectedVersion?: number } = {}) {
  await getDraft(db, workspaceId, id); // workspace scoping + not-found
  const { data, error } = await db.schema("app").rpc("approve_draft", {
    p_draft: id, p_reviewed_hash: opts.reviewedHash ?? null, p_note: opts.note ?? null, p_expected_version: opts.expectedVersion ?? null,
  });
  if (error) throw mapRpcError(error);
  return data as DraftRow;
}

/** UI hint only (the DB is authoritative): approval bound to the current content. */
export function approvalIsLive(d: DraftRow) {
  return !!d.approved_hash && d.approved_hash === d.content_hash && draftHash(d) === d.content_hash;
}

/** Build the manual-send link. Never sends anything. Returns null href for copy-only channels. */
export function buildSendLink(d: Pick<DraftRow, "channel" | "recipient_address" | "recipient_display" | "subject" | "body">): { href: string | null; copyText: string } {
  const copyText = d.subject && ["email", "introduction", "calendar_invite"].includes(d.channel) ? `Subject: ${d.subject}\n\n${d.body}` : d.body;
  const addr = (d.recipient_address ?? "").trim();
  switch (d.channel) {
    case "email":
    case "introduction":
    case "calendar_invite": {
      const to = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(addr) ? encodeURIComponent(addr).replace(/%40/g, "@") : "";
      const q = new URLSearchParams();
      if (d.subject) q.set("subject", d.subject);
      q.set("body", d.body);
      return { href: `mailto:${to}?${q.toString().replace(/\+/g, "%20")}`, copyText };
    }
    case "whatsapp": {
      let digits = addr.replace(/[^\d]/g, "");
      if (digits.length === 10) digits = `91${digits}`; // India default; stored numbers should carry country code
      const base = digits.length >= 8 ? `https://wa.me/${digits}` : "https://wa.me/";
      return { href: `${base}?text=${encodeURIComponent(d.body)}`, copyText };
    }
    case "linkedin": {
      const ok = /^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?$/.test(addr);
      return { href: ok ? addr : `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(d.recipient_display ?? "")}`, copyText };
    }
    case "post":
      return { href: "https://www.linkedin.com/feed/", copyText };
    default:
      return { href: null, copyText };
  }
}

/**
 * "Open to send" via app.open_draft_for_send: requires a live hash-bound approval and re-checks suppression/consent
 * (a suppressed recipient parks the draft as paused and this throws SuppressedRecipientError). Sets opened_for_send.
 * This is NOT a send: the user sends from their own mail/WhatsApp/LinkedIn and then marks it sent.
 */
export async function openDraftForSend(db: Db, workspaceId: string, id: string, _actorUserId: string) {
  const cur = await getDraft(db, workspaceId, id);
  if (!["approved", "opened_for_send"].includes(cur.state)) throw new DraftStateError("approve the draft before opening it to send");
  const { data, error } = await db.schema("app").rpc("open_draft_for_send", { p_draft: id });
  if (error) throw mapRpcError(error);
  const row = data as DraftRow;
  if (row.state === "paused" && row.pause_reason === "suppressed") throw new SuppressedRecipientError("Recipient is suppressed or consent revoked; the draft was paused");
  return { draft: row, ...buildSendLink(row) };
}

/** User asserts they sent it manually (app.mark_draft_sent; sent_evidence='user_assertion'). Idempotent. */
export async function markDraftSent(db: Db, workspaceId: string, id: string, _actorUserId: string) {
  const cur = await getDraft(db, workspaceId, id);
  if (cur.state === "marked_sent" || cur.state === "reconciled_sent") return { draft: cur, already: true };
  if (!["approved", "opened_for_send"].includes(cur.state)) throw new DraftStateError("only approved drafts can be marked sent");
  const { data, error } = await db.schema("app").rpc("mark_draft_sent", { p_draft: id });
  if (error) throw mapRpcError(error);
  return { draft: data as DraftRow, already: false };
}

/** Sent Items evidence upgrades marked/opened/approved drafts to reconciled_sent. Idempotent. Service-role (job) client only. */
export async function reconcileDraftSent(db: Db, workspaceId: string, id: string, providerMessageId: string) {
  const cur = await getDraft(db, workspaceId, id);
  if (cur.state === "reconciled_sent") return cur;
  if (!["approved", "opened_for_send", "marked_sent"].includes(cur.state)) throw new DraftStateError(`cannot reconcile a ${cur.state} draft`);
  const { data, error } = await db.from("draft").update({
    state: "reconciled_sent", sent_evidence: `sent_items:${providerMessageId}`, marked_sent_at: cur.marked_sent_at ?? new Date().toISOString(),
  }).eq("workspace_id", workspaceId).eq("id", id).select().single();
  if (error) throw error;
  await recordDraftEvent(db, workspaceId, { draftId: id, event: "reconciled_sent", actorKind: "job", contentHash: cur.content_hash, evidence: `sent_items:${providerMessageId}`, ownerUserId: cur.owner_user_id });
  return data as DraftRow;
}

export async function setDraftPaused(db: Db, workspaceId: string, id: string, paused: boolean, reason: string | null, actorUserId?: string | null) {
  const cur = await getDraft(db, workspaceId, id);
  if (["marked_sent", "reconciled_sent", "discarded"].includes(cur.state)) return cur;
  const patch = paused
    ? { state: "paused", pause_reason: reason } // the DB guard drops any approval
    : { state: "drafted", pause_reason: null };
  const { data, error } = await db.from("draft").update(patch).eq("workspace_id", workspaceId).eq("id", id).select().single();
  if (error) throw error;
  await recordDraftEvent(db, workspaceId, { draftId: id, event: paused ? "paused" : "resumed", actorUserId: actorUserId ?? null, actorKind: actorUserId ? "user" : "system", evidence: reason, ownerUserId: cur.owner_user_id });
  return data as DraftRow;
}

export async function discardDraft(db: Db, workspaceId: string, id: string, actorUserId: string | null, reason?: string) {
  const cur = await getDraft(db, workspaceId, id);
  if (["marked_sent", "reconciled_sent"].includes(cur.state)) throw new DraftStateError("sent drafts cannot be discarded");
  const { data, error } = await db.from("draft").update({ state: "discarded", pause_reason: reason ?? null }).eq("workspace_id", workspaceId).eq("id", id).select().single();
  if (error) throw error;
  await recordDraftEvent(db, workspaceId, { draftId: id, event: "discarded", actorUserId, actorKind: actorUserId ? "user" : "system", evidence: reason ?? null, ownerUserId: cur.owner_user_id });
  return data as DraftRow;
}
