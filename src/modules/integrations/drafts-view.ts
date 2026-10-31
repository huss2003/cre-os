import "server-only";
import type { Db } from "@/lib/supabase/server";
import type { DraftRow } from "@/lib/services/drafts";
import { onSequenceDraftSent } from "./sequences";
import { recordTouch, touchChannelForDraft } from "./touches";

/** Read helpers for the draft queue (RLS via the user client). */
export async function listDrafts(db: Db, ws: string, q: { channel?: string | null; states?: string[] | null; limit?: number } = {}) {
  let query = db.from("draft").select("*").eq("workspace_id", ws).is("archived_at", null).order("updated_at", { ascending: false }).limit(q.limit ?? 200);
  if (q.channel) query = query.eq("channel", q.channel);
  if (q.states?.length) query = query.in("state", q.states);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as DraftRow[];
}

export async function draftEvents(db: Db, ws: string, draftId: string) {
  const { data } = await db.from("draft_event").select("event, actor_kind, actor_user_id, content_hash, evidence, occurred_at")
    .eq("workspace_id", ws).eq("draft_id", draftId).order("occurred_at");
  return data ?? [];
}

/** Bookkeeping after the user marks a draft sent: advance its outreach sequence and log the sent touch (idempotent). */
export async function afterMarkedSent(db: Db, ws: string, d: DraftRow, userId: string) {
  await onSequenceDraftSent(db, ws, d, new Date(d.marked_sent_at ?? Date.now()));
  if (d.recipient_person_id || d.org_id) {
    await recordTouch(db, ws, { personId: d.recipient_person_id, orgId: d.org_id, userId, channel: touchChannelForDraft(d.channel), kind: "sent",
      at: d.marked_sent_at ?? new Date().toISOString(), draftId: d.id, dedupeKey: `draft:${d.id}:sent` });
  }
}

/** Counts per channel for the tab bar (states still needing action). */
export async function draftCounts(db: Db, ws: string) {
  const { data } = await db.from("draft").select("channel, state").eq("workspace_id", ws).is("archived_at", null).in("state", ["drafted", "approved", "opened_for_send", "paused"]);
  const out: Record<string, number> = {};
  for (const d of data ?? []) out[d.channel] = (out[d.channel] ?? 0) + 1;
  return out;
}
