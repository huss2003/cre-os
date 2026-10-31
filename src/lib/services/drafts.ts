import "server-only";
import type { Db } from "@/lib/supabase/server";
import { stableHash } from "@/lib/util/crypto";

/**
 * External message drafts. There is NO send capability anywhere in CRE OS (spec: manual send MVP).
 * Approval binds to content_hash; any change to recipient/subject/body/attachments invalidates it.
 */
export interface NewDraft {
  channel: "email" | "whatsapp" | "linkedin" | "calendar_invite" | "introduction" | "market_note" | "post";
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
}

export function draftHash(d: { recipient_person_id?: string | null; recipient_address?: string | null; subject?: string | null; body: string; attachment_document_ids?: string[] }) {
  return stableHash({ r: d.recipient_person_id ?? null, a: d.recipient_address ?? null, s: d.subject ?? null, b: d.body, att: [...(d.attachment_document_ids ?? [])].sort() });
}

export class SuppressedRecipientError extends Error {}

/** Throws SuppressedRecipientError when the person is suppressed / consent revoked for the channel. */
export async function assertNotSuppressed(db: Db, workspaceId: string, personId: string | null | undefined, channel: string) {
  if (!personId) return;
  const { data } = await db.from("consent_permission").select("id, channel, suppressed, revoked_at")
    .eq("workspace_id", workspaceId).eq("person_id", personId);
  const blocked = (data ?? []).some((c) => c.suppressed || (c.revoked_at && (!c.channel || c.channel === channel)));
  const { data: cm } = await db.from("contact_method").select("id").eq("workspace_id", workspaceId).eq("person_id", personId).eq("suppressed", true).limit(1);
  if (blocked || (cm?.length ?? 0) > 0) throw new SuppressedRecipientError("Recipient is suppressed or consent revoked");
}

export async function createDraft(db: Db, workspaceId: string, d: NewDraft) {
  await assertNotSuppressed(db, workspaceId, d.recipientPersonId, d.channel);
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
  };
  const { data, error } = await db.from("draft").insert({ ...row, content_hash: draftHash(row) }).select().single();
  if (error) throw error;
  return data;
}
