import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "@/lib/supabase/server";
import { enqueue } from "@/lib/jobs/queue";
import { sha256 } from "@/lib/util/crypto";
import { appUrl, isProviderConfigured } from "./config";
import { getValidAccessToken, type ConnectorAccountRow, type FetchLike } from "./tokens";
import { escapeLike } from "@/lib/util/like";

/**
 * Push sync (workflow 04): Microsoft Graph change notifications and Gmail Pub/Sub push. A notification never carries
 * mail content we trust — it only ENQUEUES a deduplicated delta-sync job for the connector; the normal (idempotent)
 * sync then fetches and processes messages. Polling stays as the fallback, so a missed or rejected notification only
 * delays a message until the next poll. Works only when provider credentials (and, for Gmail, a Pub/Sub topic and a
 * push verification token) are configured; otherwise nothing is registered.
 *
 * Duplicate notifications: each notification has a receipt key (webhook_receipt, unique) and the sync job dedupe key
 * coalesces bursts into one job per connector per minute. Even if a duplicate slipped through, the sync is
 * cursor-based and every downstream effect has its own dedupe key.
 */
export type EnqueueFn = typeof enqueue;
const GRAPH = "https://graph.microsoft.com/v1.0";
export const GRAPH_RESOURCES = { inbox: "me/mailFolders('inbox')/messages", calendar: "me/events" } as const;
const GRAPH_TTL_HOURS = 72;            // Outlook resources allow < 7 days; renew when < 24 h remain
const RENEW_BEFORE_HOURS = 24;
const COALESCE_SECONDS = 60;

export function pushConfigured(provider: "microsoft" | "google"): boolean {
  if (!appUrl().startsWith("https://")) return false;           // providers only call public HTTPS endpoints
  if (provider === "microsoft") return isProviderConfigured("microsoft");
  return isProviderConfigured("google") && !!process.env.GMAIL_PUBSUB_TOPIC && !!process.env.GMAIL_PUSH_VERIFICATION_TOKEN;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Pure: receipt dedupe key for a Graph notification. "updated" notifications are bucketed (10 min) so a later real change still counts. */
export function graphReceiptKey(n: GraphNotification, now: Date) {
  const resource = n.resourceData?.id ?? n.resource ?? "";
  const bucket = n.changeType === "updated" || n.lifecycleEvent ? `:${Math.floor(now.getTime() / 600_000)}` : "";
  return `graph:${sha256(`${n.subscriptionId}|${resource}|${n.changeType ?? ""}|${n.lifecycleEvent ?? ""}`).slice(0, 40)}${bucket}`;
}

/** Pure: sync job dedupe key + due time that coalesces a burst of notifications into one job per connector per minute. */
export function coalescedSyncJob(type: string, accountId: string, now: Date) {
  const bucket = Math.floor(now.getTime() / (COALESCE_SECONDS * 1000));
  return { dedupeKey: `${type}:${accountId}:push:${bucket}`, dueAt: new Date((bucket + 1) * COALESCE_SECONDS * 1000 + 2000) };
}

async function recordReceipt(admin: Db, r: { ws: string; accountId: string; provider: string; key: string; kind: string }) {
  const { data, error } = await admin.from("webhook_receipt").insert({ workspace_id: r.ws, connector_account_id: r.accountId, provider: r.provider, dedupe_key: r.key, kind: r.kind })
    .select("id").single();
  if (error) {
    if (error.code === "23505") return null;
    throw error;
  }
  return data.id as string;
}

// ------------------------------------------------------------------ Microsoft Graph

export interface GraphNotification {
  subscriptionId: string; clientState?: string | null; changeType?: string; resource?: string; resourceData?: { id?: string } | null;
  subscriptionExpirationDateTime?: string; tenantId?: string; lifecycleEvent?: "reauthorizationRequired" | "subscriptionRemoved" | "missed" | string;
}

export interface PushResult { accepted: number; duplicates: number; rejected: number; jobs: string[] }

export async function handleGraphNotifications(admin: Db, body: { value?: GraphNotification[] } | null, opts: { now?: Date; enqueueFn?: EnqueueFn } = {}): Promise<PushResult> {
  const now = opts.now ?? new Date();
  const enq = opts.enqueueFn ?? enqueue;
  const out: PushResult = { accepted: 0, duplicates: 0, rejected: 0, jobs: [] };
  for (const n of (body?.value ?? []).slice(0, 200)) {
    if (!n?.subscriptionId) { out.rejected++; continue; }
    const { data: sub } = await admin.from("push_subscription").select("id, workspace_id, connector_account_id, resource, client_state_hash, status")
      .eq("provider", "microsoft").eq("external_id", n.subscriptionId).maybeSingle();
    // unknown subscription or wrong clientState secret => ignore (never trust the payload)
    if (!sub || !sub.client_state_hash || !n.clientState || !safeEqual(sha256(n.clientState), sub.client_state_hash)) { out.rejected++; continue; }
    const ws = sub.workspace_id as string;
    const receipt = await recordReceipt(admin, { ws, accountId: sub.connector_account_id, provider: "microsoft", key: graphReceiptKey(n, now), kind: n.lifecycleEvent ?? n.changeType ?? "change" });
    if (!receipt) { out.duplicates++; continue; }
    out.accepted++;
    let jobId: string;
    if (n.lifecycleEvent === "reauthorizationRequired" || n.lifecycleEvent === "subscriptionRemoved") {
      if (n.lifecycleEvent === "subscriptionRemoved") await admin.from("push_subscription").update({ status: "removed" }).eq("workspace_id", ws).eq("id", sub.id);
      jobId = await enq({ workspaceId: ws, type: "integrations.push_subscribe", payload: { account_id: sub.connector_account_id }, dedupeKey: `integrations.push_subscribe:${sub.connector_account_id}:lifecycle:${Math.floor(now.getTime() / 600_000)}` });
    } else {
      const type = sub.resource === "calendar" ? "integrations.calendar_sync" : "integrations.inbox_sync";
      const j = coalescedSyncJob(type, sub.connector_account_id, now);
      jobId = await enq({ workspaceId: ws, type, payload: { account_id: sub.connector_account_id, via: "push" }, dedupeKey: j.dedupeKey, dueAt: j.dueAt, maxAttempts: 3 });
    }
    out.jobs.push(jobId);
    await admin.from("webhook_receipt").update({ job_id: jobId }).eq("workspace_id", ws).eq("id", receipt);
    await admin.from("push_subscription").update({ last_notification_at: now.toISOString() }).eq("workspace_id", ws).eq("id", sub.id);
  }
  return out;
}

async function graphCall(url: string, token: string, init: { method: string; body?: unknown }, fetchImpl: FetchLike) {
  const res = await fetchImpl(url, { method: init.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined });
  const text = await res.text();
  return { status: res.status, ok: res.ok, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} , text };
}

/** Create or renew the Graph subscription for one resource. Idempotent: does nothing while > 24 h remain. */
export async function ensureGraphSubscription(admin: Db, account: ConnectorAccountRow, resource: "inbox" | "calendar", opts: { fetchImpl?: FetchLike; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ws = account.workspace_id;
  const { data: cur } = await admin.from("push_subscription").select("*").eq("workspace_id", ws).eq("connector_account_id", account.id).eq("resource", resource).maybeSingle();
  if (cur?.status === "active" && cur.expires_at && Date.parse(cur.expires_at) - now.getTime() > RENEW_BEFORE_HOURS * 3_600_000) return { action: "none" as const, id: cur.external_id as string };
  const expires = new Date(now.getTime() + GRAPH_TTL_HOURS * 3_600_000).toISOString();
  const save = async (patch: Record<string, unknown>) => {
    const { error } = await admin.from("push_subscription").upsert({ workspace_id: ws, connector_account_id: account.id, provider: "microsoft", resource, owner_user_id: account.user_id, ...patch },
      { onConflict: "connector_account_id,resource" });
    if (error) throw error;
  };
  try {
    const token = await getValidAccessToken(admin, account, fetchImpl);
    if (cur?.external_id && cur.status === "active") {
      const r = await graphCall(`${GRAPH}/subscriptions/${encodeURIComponent(cur.external_id)}`, token, { method: "PATCH", body: { expirationDateTime: expires } }, fetchImpl);
      if (r.ok) {
        await save({ expires_at: String(r.json.expirationDateTime ?? expires), status: "active", last_renewed_at: now.toISOString(), last_error: null });
        return { action: "renewed" as const, id: cur.external_id as string };
      }
      if (r.status !== 404) throw new Error(`Graph renew failed: ${r.status} ${r.text.slice(0, 200)}`);
    }
    const clientState = randomBytes(24).toString("base64url");
    const r = await graphCall(`${GRAPH}/subscriptions`, token, { method: "POST", body: {
      changeType: resource === "inbox" ? "created" : "created,updated,deleted", resource: GRAPH_RESOURCES[resource],
      notificationUrl: `${appUrl()}/api/webhooks/microsoft`, lifecycleNotificationUrl: `${appUrl()}/api/webhooks/microsoft`, expirationDateTime: expires, clientState,
    } }, fetchImpl);
    if (!r.ok) throw new Error(`Graph subscribe failed: ${r.status} ${r.text.slice(0, 200)}`);
    await save({ external_id: String(r.json.id), client_state_hash: sha256(clientState), expires_at: String(r.json.expirationDateTime ?? expires), status: "active",
      last_renewed_at: now.toISOString(), last_error: null });
    return { action: "created" as const, id: String(r.json.id) };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await save({ status: "failed", last_error: `${msg} — polling continues` });
    return { action: "failed" as const, error: msg };
  }
}

// ------------------------------------------------------------------ Gmail (Cloud Pub/Sub push)

export interface PubSubPush { message?: { data?: string; messageId?: string; message_id?: string; publishTime?: string } | null; subscription?: string }

/** Verify the push verification token, then enqueue a deduped inbox sync for every Google connector of that mailbox. */
export async function handleGmailPush(admin: Db, token: string | null, body: PubSubPush | null, opts: { now?: Date; enqueueFn?: EnqueueFn } = {}) {
  const expected = process.env.GMAIL_PUSH_VERIFICATION_TOKEN;
  if (!expected) return { status: 503 as const, accepted: 0, duplicates: 0, unknown: 0 };
  if (!token || !safeEqual(token, expected)) return { status: 403 as const, accepted: 0, duplicates: 0, unknown: 0 };
  const now = opts.now ?? new Date();
  const enq = opts.enqueueFn ?? enqueue;
  const msgId = body?.message?.messageId ?? body?.message?.message_id ?? null;
  let payload: { emailAddress?: string; historyId?: string | number } = {};
  try { payload = JSON.parse(Buffer.from(body?.message?.data ?? "", "base64").toString("utf8")); } catch { /* malformed => ack and ignore */ }
  const email = String(payload.emailAddress ?? "").trim().toLowerCase();
  if (!msgId || !email) return { status: 204 as const, accepted: 0, duplicates: 0, unknown: 1 };
  const { data: accounts } = await admin.from("connector_account").select("id, workspace_id, status").eq("provider", "google").ilike("account_email", escapeLike(email)).in("status", ["connected", "error"]);
  const out = { status: 204 as const, accepted: 0, duplicates: 0, unknown: accounts?.length ? 0 : 1 };
  for (const a of accounts ?? []) {
    const receipt = await recordReceipt(admin, { ws: a.workspace_id, accountId: a.id, provider: "google", key: `pubsub:${msgId}`, kind: "history" });
    if (!receipt) { out.duplicates++; continue; }
    out.accepted++;
    const j = coalescedSyncJob("integrations.inbox_sync", a.id, now);
    const jobId = await enq({ workspaceId: a.workspace_id, type: "integrations.inbox_sync", payload: { account_id: a.id, via: "push" }, dedupeKey: j.dedupeKey, dueAt: j.dueAt, maxAttempts: 3 });
    await admin.from("webhook_receipt").update({ job_id: jobId }).eq("workspace_id", a.workspace_id).eq("id", receipt);
    await admin.from("push_subscription").update({ last_notification_at: now.toISOString() }).eq("workspace_id", a.workspace_id).eq("connector_account_id", a.id).eq("resource", "inbox");
  }
  return out;
}

/** users.watch (gmail.readonly is sufficient). Google asks for renewal at least every 7 days; we renew when < 24 h remain. */
export async function ensureGmailWatch(admin: Db, account: ConnectorAccountRow, opts: { fetchImpl?: FetchLike; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ws = account.workspace_id;
  const { data: cur } = await admin.from("push_subscription").select("*").eq("workspace_id", ws).eq("connector_account_id", account.id).eq("resource", "inbox").maybeSingle();
  if (cur?.status === "active" && cur.expires_at && Date.parse(cur.expires_at) - now.getTime() > RENEW_BEFORE_HOURS * 3_600_000) return { action: "none" as const };
  const save = async (patch: Record<string, unknown>) => {
    const { error } = await admin.from("push_subscription").upsert({ workspace_id: ws, connector_account_id: account.id, provider: "google", resource: "inbox", owner_user_id: account.user_id, ...patch },
      { onConflict: "connector_account_id,resource" });
    if (error) throw error;
  };
  try {
    const token = await getValidAccessToken(admin, account, fetchImpl);
    const res = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/watch", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ topicName: process.env.GMAIL_PUBSUB_TOPIC, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Gmail watch failed: ${res.status} ${text.slice(0, 200)}`);
    const j = JSON.parse(text) as { historyId?: string; expiration?: string };
    await save({ history_id: j.historyId ?? null, expires_at: j.expiration ? new Date(Number(j.expiration)).toISOString() : null, status: "active", last_renewed_at: now.toISOString(), last_error: null });
    return { action: cur ? ("renewed" as const) : ("created" as const) };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await save({ status: "failed", last_error: `${msg} — polling continues` });
    return { action: "failed" as const, error: msg };
  }
}

/** Job body for integrations.push_subscribe. */
export async function ensurePush(admin: Db, account: ConnectorAccountRow, opts: { fetchImpl?: FetchLike; now?: Date } = {}) {
  if (account.status !== "connected" && account.status !== "error") return { skipped: `connector ${account.status}` };
  if (!pushConfigured(account.provider as "microsoft" | "google")) return { skipped: "push not configured (polling only)" };
  if (account.provider === "microsoft") {
    return { inbox: await ensureGraphSubscription(admin, account, "inbox", opts), calendar: await ensureGraphSubscription(admin, account, "calendar", opts) };
  }
  return { inbox: await ensureGmailWatch(admin, account, opts) };
}
