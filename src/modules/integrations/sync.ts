import "server-only";
import type { Db } from "@/lib/supabase/server";
import { assertIngestionAllowed, IngestionPausedError } from "@/modules/admin/killswitch";
import { reconcileDraftSent, type DraftRow } from "@/lib/services/drafts";
import { agenda, loadGeos, upsertCalendarEvent, type EventChange } from "./calendar";
import { CALENDAR_WINDOW_DAYS, STALE_AFTER_MINUTES } from "./config";
import { ingestMessage, isBackfill, processMessage, type InboundRow } from "./inbox";
import { adapterFor } from "./providers";
import { normaliseWhitespace } from "./sanitize";
import { onSequenceDraftSent } from "./sequences";
import { markConnectorFailure, type ConnectorAccountRow, type FetchLike } from "./tokens";
import { recordTouch } from "./touches";
import { CursorExpiredError, ProviderAuthError, ProviderRateLimitError, type MailMessage, type ProviderAdapter } from "./types";

/**
 * Per-connector sync runners (service-role client; every query filters workspace_id explicitly — rule S2).
 * Watermarks/errors live in connector_cursor (resource = inbox | calendar | sent). Kill switch is checked first.
 * Auth failures flip connector status (expired/revoked) and surface as stale; 429 reschedules via Retry-After;
 * an expired delta token triggers one full re-sync.
 */
export type Resource = "inbox" | "calendar" | "sent";

export interface SyncResult {
  status: "ok" | "paused" | "auth_failed" | "rate_limited";
  retryAfterSeconds?: number;
  counts: Record<string, number>;
  fullResync?: boolean;
  error?: string;
}

export async function loadAccount(admin: Db, ws: string, accountId: string): Promise<ConnectorAccountRow | null> {
  const { data } = await admin.from("connector_account").select("*").eq("workspace_id", ws).eq("id", accountId).maybeSingle();
  return (data as ConnectorAccountRow | null) ?? null;
}

async function getCursor(admin: Db, account: ConnectorAccountRow, resource: Resource) {
  const { data } = await admin.from("connector_cursor").select("cursor").eq("workspace_id", account.workspace_id).eq("connector_account_id", account.id).eq("resource", resource).maybeSingle();
  return (data?.cursor as string | null) ?? null;
}

async function saveCursor(admin: Db, account: ConnectorAccountRow, resource: Resource, patch: { cursor?: string | null; ok?: boolean; error?: string | null }) {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = { workspace_id: account.workspace_id, connector_account_id: account.id, resource, last_attempt_at: now };
  if (patch.cursor !== undefined) row.cursor = patch.cursor;
  if (patch.ok) { row.last_success_at = now; row.last_error = null; }
  if (patch.error) row.last_error = patch.error.slice(0, 1000);
  const { error } = await admin.from("connector_cursor").upsert(row, { onConflict: "connector_account_id,resource" });
  if (error) throw error;
}

export async function syncResource(admin: Db, account: ConnectorAccountRow, resource: Resource, opts: { adapter?: ProviderAdapter; now?: Date; fetchImpl?: FetchLike } = {}): Promise<SyncResult> {
  const ws = account.workspace_id;
  try {
    await assertIngestionAllowed(admin, ws);
  } catch (e) {
    if (e instanceof IngestionPausedError) {
      await saveCursor(admin, account, resource, { error: `skipped: ${e.message}` });
      return { status: "paused", counts: {}, error: e.message };
    }
    throw e;
  }
  const adapter = opts.adapter ?? adapterFor(admin, account, opts.fetchImpl);
  const now = opts.now ?? new Date();
  const cursor = await getCursor(admin, account, resource);
  try {
    let res: { counts: Record<string, number>; cursor: string | null; fullResync: boolean };
    try {
      res = await runResource(admin, account, adapter, resource, cursor, now);
    } catch (e) {
      if (!(e instanceof CursorExpiredError)) throw e;
      res = await runResource(admin, account, adapter, resource, null, now);
      res.fullResync = true;
    }
    await saveCursor(admin, account, resource, { cursor: res.cursor, ok: true });
    if (account.status === "error" || account.status === "expired") {
      await admin.from("connector_account").update({ status: adapter.mode === "mock" ? "mock" : "connected", last_error: null }).eq("workspace_id", ws).eq("id", account.id);
    }
    return { status: "ok", counts: res.counts, fullResync: res.fullResync };
  } catch (e) {
    if (e instanceof ProviderAuthError) {
      await markConnectorFailure(admin, account, e.status, e.message);
      await saveCursor(admin, account, resource, { error: e.message });
      return { status: "auth_failed", counts: {}, error: e.message };
    }
    if (e instanceof ProviderRateLimitError) {
      await saveCursor(admin, account, resource, { error: `rate limited; retry after ${e.retryAfterSeconds}s` });
      return { status: "rate_limited", retryAfterSeconds: e.retryAfterSeconds, counts: {}, error: e.message };
    }
    await saveCursor(admin, account, resource, { error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function runResource(admin: Db, account: ConnectorAccountRow, adapter: ProviderAdapter, resource: Resource, cursor: string | null, now: Date) {
  const ws = account.workspace_id;
  const provider = adapter.mode === "mock" ? "mock" : account.provider;
  if (resource === "inbox") {
    const page = await adapter.listMessagesDelta(cursor);
    const counts = { seen: page.items.length, inserted: 0, triaged: 0, drafts: 0, tasks: 0, alerts: 0 };
    for (const m of page.items) {
      if (m.removed) continue;
      const { row, inserted } = await ingestMessage(admin, ws, { message: m, provider, connectorAccountId: account.id, importMethod: cursor ? "sync" : "backfill",
        backfill: isBackfill(m.receivedAt, now, false), ownerUserId: account.user_id });
      if (inserted) counts.inserted++;
      if (inserted || row.triage_status === "pending") {
        const fx = await processMessage(admin, ws, row, { now, allowAlerts: true });
        counts.triaged++;
        if (fx.draftId) counts.drafts++;
        if (fx.taskId) counts.tasks++;
        if (fx.alert) counts.alerts++;
      }
    }
    return { counts, cursor: page.nextCursor, fullResync: page.fullResync };
  }
  if (resource === "calendar") {
    const window = { start: new Date(now.getTime() - CALENDAR_WINDOW_DAYS.back * 86_400_000), end: new Date(now.getTime() + CALENDAR_WINDOW_DAYS.ahead * 86_400_000) };
    const page = await adapter.listEvents(window, cursor);
    const geos = await loadGeos(admin, ws);
    const counts: Record<EventChange | "seen", number> = { seen: page.items.length, created: 0, rescheduled: 0, cancelled: 0, updated: 0, unchanged: 0 };
    for (const ev of page.items) {
      const r = await upsertCalendarEvent(admin, ws, { item: ev, provider, connectorAccountId: account.id, ownerUserId: account.user_id, geos });
      counts[r.change]++;
    }
    return { counts, cursor: page.nextCursor, fullResync: page.fullResync };
  }
  // sent items: watermark is the newest sent time seen
  const since = cursor && !Number.isNaN(Date.parse(cursor)) ? new Date(cursor) : new Date(now.getTime() - 3 * 86_400_000);
  const sent = await adapter.listSentItems(since);
  const counts = { seen: sent.length, inserted: 0, reconciled: 0 };
  let newest = since.getTime();
  for (const m of sent) {
    newest = Math.max(newest, Date.parse(m.receivedAt));
    const { row, inserted } = await ingestMessage(admin, ws, { message: { ...m, folder: "sent" }, provider, connectorAccountId: account.id, importMethod: "sync", backfill: true, ownerUserId: account.user_id });
    if (inserted) counts.inserted++;
    if (await reconcileSentMessage(admin, ws, row, m)) counts.reconciled++;
  }
  return { counts, cursor: new Date(newest).toISOString(), fullResync: !cursor };
}

const normSubject = (s: string | null | undefined) => normaliseWhitespace((s ?? "").replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "")).toLowerCase();
const normBody = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Pure: pick the draft a Sent Items message corresponds to (same recipient + same subject or same opening text). */
export function matchSentToDraft(sent: { to: string[]; subject: string | null; body: string | null; sentAt: string },
  drafts: Pick<DraftRow, "id" | "recipient_address" | "subject" | "body" | "state" | "approved_at" | "created_at">[]): string | null {
  const to = new Set(sent.to.map((a) => a.toLowerCase()));
  const sb = normBody(sent.body);
  const candidates = drafts.filter((d) => ["approved", "opened_for_send", "marked_sent"].includes(d.state) && d.recipient_address && to.has(d.recipient_address.trim().toLowerCase())
    && Date.parse(d.created_at) <= Date.parse(sent.sentAt) + 60_000);
  const scored = candidates.map((d) => {
    const subj = !!d.subject && normSubject(d.subject) === normSubject(sent.subject);
    const opening = normBody(d.body).slice(0, 80);
    const body = opening.length >= 20 && sb.includes(opening);
    return { id: d.id, score: (subj ? 2 : 0) + (body ? 3 : 0) };
  }).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score);
  return scored[0]?.id ?? null;
}

/** Sent Items evidence => reconciled_sent, sequence advance, sent touch, outbound interaction. Idempotent. */
export async function reconcileSentMessage(admin: Db, ws: string, row: InboundRow, m: MailMessage) {
  const to = [...m.to, ...m.cc].map((a) => a.address.toLowerCase());
  if (!to.length) return false;
  const { data: drafts } = await admin.from("draft").select("id, recipient_address, recipient_person_id, subject, body, state, approved_at, created_at, sequence_key, sequence_step, org_id, owner_user_id, channel")
    .eq("workspace_id", ws).in("state", ["approved", "opened_for_send", "marked_sent"]).in("recipient_address", to).limit(50);
  const id = matchSentToDraft({ to, subject: m.subject, body: row.body_excerpt, sentAt: m.receivedAt }, (drafts ?? []) as DraftRow[]);
  if (!id) return false;
  const d = (drafts ?? []).find((x) => x.id === id)!;
  await reconcileDraftSent(admin, ws, id, m.internetMessageId ?? m.id);
  await onSequenceDraftSent(admin, ws, d, new Date(m.receivedAt));
  if (d.recipient_person_id || d.org_id) {
    await recordTouch(admin, ws, { personId: d.recipient_person_id, orgId: d.org_id, userId: d.owner_user_id, channel: "email", kind: "sent", at: m.receivedAt, draftId: id, dedupeKey: `draft:${id}:sent` });
  }
  return true;
}

/** Freshness of each resource for the settings page / stale banners (rule S10). */
export function staleness(cursors: { resource: string; last_success_at: string | null; last_error: string | null }[], now = new Date()) {
  return (["inbox", "calendar", "sent"] as Resource[]).map((r) => {
    const c = cursors.find((x) => x.resource === r);
    const age = c?.last_success_at ? (now.getTime() - Date.parse(c.last_success_at)) / 60_000 : null;
    return { resource: r, lastSuccessAt: c?.last_success_at ?? null, error: c?.last_error ?? null,
      stale: age === null || age > STALE_AFTER_MINUTES[r] || !!c?.last_error };
  });
}

export { agenda };
