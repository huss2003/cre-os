import "server-only";
/**
 * Central in-app notification service (spec §9). Reuses mudar.outbox as the transport (unique workspace+dedupe_key =
 * "no repeated notifications for the same event") and adds mudar.notification_state for severity, grouping, quiet-hour
 * deferral, record links and dismiss / snooze / complete / auto-cancel. Notifications written directly to outbox by
 * other modules (brief_ready, promise_overdue, supervisor alerts, …) are shown too (as informational).
 * Never sends anything outside the app (S3).
 */
import type { Db } from "@/lib/supabase/server";
import { loadOrchSettings } from "../schedule/settings-db";
import type { OrchSettings } from "../schedule/settings";
import { classify, deliverAfter, groupKeyFor, suppressed, type Severity } from "./rules";

export interface NotifyInput {
  userId: string;
  category: string;
  /** Stable key of the triggering event — the same key never notifies twice. */
  eventKey: string;
  title: string;
  body?: string | null;
  severity?: Severity;
  record?: { type: string; id: string } | null;
  href?: string | null;
  groupKey?: string | null;
  /** Condition key; `cancelObsolete(triggerKey)` cancels the notification when the condition no longer applies. */
  triggerKey?: string | null;
  payload?: Record<string, unknown>;
  /** Share another module's outbox key/kind for the same event so it is never notified twice (e.g. brief caretaker). */
  sharedOutbox?: { dedupeKey: string; kind: string };
  now?: Date;
  settings?: OrchSettings;
}

export interface NotifyResult { outboxId: string | null; created: boolean; duplicate: boolean; grouped: boolean; suppressed: boolean; severity: Severity; deliverAfter: string | null }

export const outboxKey = (eventKey: string) => `orch:${eventKey}`;

/** Create one in-app notification (admin client: jobs only; every query filters workspace_id). */
export async function notifyUser(admin: Db, ws: string, n: NotifyInput): Promise<NotifyResult> {
  const now = n.now ?? new Date();
  const s = n.settings ?? await loadOrchSettings(admin, ws, n.userId);
  const severity = classify(n.category, n.severity, s.notifications);
  if (suppressed(n.category, severity, s.notifications)) return { outboxId: null, created: false, duplicate: false, grouped: false, suppressed: true, severity, deliverAfter: null };
  const key = n.sharedOutbox?.dedupeKey ?? outboxKey(n.eventKey);
  const { data: ins, error } = await admin.from("outbox").upsert(
    { workspace_id: ws, user_id: n.userId, kind: n.sharedOutbox?.kind ?? "notification", dedupe_key: key, payload: { ...(n.payload ?? {}), category: n.category, title: n.title, body: n.body ?? null, href: n.href ?? null, severity } },
    { onConflict: "workspace_id,dedupe_key", ignoreDuplicates: true },
  ).select("id");
  if (error) throw error;
  if (!ins?.length) {
    const { data: ex } = await admin.from("outbox").select("id").eq("workspace_id", ws).eq("dedupe_key", key).maybeSingle();
    return { outboxId: ex?.id ?? null, created: false, duplicate: true, grouped: false, suppressed: false, severity, deliverAfter: null };
  }
  const outboxId = ins[0].id as string;
  const after = deliverAfter(now, severity, { tz: s.timezone, quietHours: s.quietHours, workingHours: s.workingHours, workdays: s.workdays });
  const groupKey = groupKeyFor(n.category, n.record, n.groupKey);

  // grouping: fold into an open notification of the same group created within the window
  let parent: { outbox_id: string; group_count: number } | null = null;
  if (s.notifications.groupWindowMinutes > 0) {
    const since = new Date(+now - s.notifications.groupWindowMinutes * 60_000).toISOString();
    const { data: p } = await admin.from("notification_state").select("outbox_id, group_count").eq("workspace_id", ws).eq("user_id", n.userId)
      .eq("group_key", groupKey).is("group_parent", null).eq("status", "pending").gte("created_at", since).neq("outbox_id", outboxId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    parent = p ?? null;
  }
  const { error: e2 } = await admin.from("notification_state").insert({
    outbox_id: outboxId, workspace_id: ws, user_id: n.userId, category: n.category, severity, title: n.title.slice(0, 300), body: n.body?.slice(0, 2000) ?? null,
    record_type: n.record?.type ?? null, record_id: n.record?.id ?? null, href: n.href ?? null, group_key: groupKey,
    group_parent: parent?.outbox_id ?? null, trigger_key: n.triggerKey ?? null, deliver_after: after.toISOString(), created_at: now.toISOString(),
  });
  if (e2) throw e2;
  if (parent) {
    await admin.from("notification_state").update({ group_count: parent.group_count + 1, updated_at: now.toISOString(), ...(severity === "urgent" ? { severity: "urgent", deliver_after: now.toISOString() } : {}) })
      .eq("workspace_id", ws).eq("outbox_id", parent.outbox_id);
  }
  return { outboxId, created: true, duplicate: false, grouped: !!parent, suppressed: false, severity, deliverAfter: after.toISOString() };
}

/** Notify every admin/owner of a workspace (budget, failed job alerts). */
export async function notifyAdmins(admin: Db, ws: string, n: Omit<NotifyInput, "userId">): Promise<NotifyResult[]> {
  const { data } = await admin.from("membership").select("user_id").eq("workspace_id", ws).in("role", ["owner", "admin"]);
  const out: NotifyResult[] = [];
  for (const m of (data ?? []) as { user_id: string }[]) out.push(await notifyUser(admin, ws, { ...n, userId: m.user_id, eventKey: `${n.eventKey}:${m.user_id}` }));
  return out;
}

export interface InboxItem {
  id: string; kind: string; category: string; severity: Severity; title: string; body: string | null; href: string | null;
  record: { type: string; id: string } | null; count: number; status: string; createdAt: string; snoozedUntil: string | null;
}

const LEGACY_TITLES: Record<string, string> = {
  brief_ready: "Your daily brief is ready", promise_overdue: "Overdue commitment", lease_event_alert: "Lease event coming up",
  deadline_48h: "Deadline within 48 hours", urgent_alert: "Urgent reply", brief_alert: "Daily brief delayed",
};

/** The user's in-app inbox (RLS: own rows). Deferred (quiet hours), grouped children, dismissed and cancelled rows are hidden. */
export async function listInbox(db: Db, ws: string, userId: string, opts: { now?: Date; includeClosed?: boolean; limit?: number } = {}): Promise<InboxItem[]> {
  const now = opts.now ?? new Date();
  const since = new Date(+now - 30 * 864e5).toISOString();
  const { data, error } = await db.from("outbox").select("id, kind, payload, created_at, notification_state!notification_state_outbox_id_fkey(*)")
    .eq("workspace_id", ws).eq("user_id", userId).gte("created_at", since).order("created_at", { ascending: false }).limit(opts.limit ?? 200);
  if (error) throw error;
  const out: InboxItem[] = [];
  for (const r of (data ?? []) as any[]) {
    const st = Array.isArray(r.notification_state) ? r.notification_state[0] : r.notification_state;
    const p = r.payload ?? {};
    if (st) {
      if (st.group_parent) continue;
      const open = st.status === "pending" || (st.status === "snoozed" && st.snoozed_until && Date.parse(st.snoozed_until) <= +now);
      if (!opts.includeClosed && (!open || Date.parse(st.deliver_after) > +now)) continue;
    }
    out.push({
      id: r.id, kind: r.kind, category: st?.category ?? p.category ?? r.kind, severity: (st?.severity ?? (r.kind === "urgent_alert" ? "urgent" : "info")) as Severity,
      title: st?.title ?? p.title ?? LEGACY_TITLES[r.kind] ?? r.kind.replace(/_/g, " "), body: st?.body ?? p.reason ?? p.body ?? null,
      href: st?.href ?? p.href ?? null, record: st?.record_type ? { type: st.record_type, id: st.record_id } : null,
      count: st?.group_count ?? 1, status: st?.status ?? "pending", createdAt: r.created_at, snoozedUntil: st?.snoozed_until ?? null,
    });
  }
  return out.sort((a, b) => Number(b.severity === "urgent") - Number(a.severity === "urgent") || b.createdAt.localeCompare(a.createdAt));
}

export class NotificationError extends Error {}

/** dismiss / snooze / complete (user client, RLS). Creates the state row for legacy outbox notifications. Children follow their group. */
export async function actOnNotification(db: Db, ws: string, userId: string, outboxId: string, action: "dismiss" | "snooze" | "complete", opts: { until?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const { data: ob } = await db.from("outbox").select("id, kind, payload").eq("workspace_id", ws).eq("id", outboxId).eq("user_id", userId).maybeSingle();
  if (!ob) throw new NotificationError("Notification not found.");
  let patch: Record<string, unknown>;
  if (action === "snooze") {
    const until = opts.until ? new Date(opts.until) : new Date(+now + 3 * 3600e3);
    if (isNaN(+until) || +until <= +now) throw new NotificationError("Snooze until must be in the future.");
    patch = { status: "snoozed", snoozed_until: until.toISOString() };
  } else patch = { status: action === "dismiss" ? "dismissed" : "completed", acted_at: now.toISOString() };
  const { data: st } = await db.from("notification_state").select("outbox_id").eq("workspace_id", ws).eq("outbox_id", outboxId).maybeSingle();
  if (st) {
    const { error } = await db.from("notification_state").update({ ...patch, updated_at: now.toISOString() }).eq("workspace_id", ws).eq("outbox_id", outboxId);
    if (error) throw error;
    await db.from("notification_state").update({ ...patch, updated_at: now.toISOString() }).eq("workspace_id", ws).eq("group_parent", outboxId);
  } else {
    const p = (ob.payload ?? {}) as Record<string, any>;
    const { error } = await db.from("notification_state").insert({ outbox_id: outboxId, workspace_id: ws, user_id: userId, category: p.category ?? ob.kind, title: p.title ?? null, href: p.href ?? null, ...patch });
    if (error) throw error;
  }
  return { ok: true, action };
}

/** Cancel open notifications whose triggering condition no longer applies. */
export async function cancelObsolete(admin: Db, ws: string, triggerKey: string, reason: string): Promise<number> {
  const { data, error } = await admin.from("notification_state").update({ status: "cancelled", cancel_reason: reason.slice(0, 300), updated_at: new Date().toISOString() })
    .eq("workspace_id", ws).eq("trigger_key", triggerKey).in("status", ["pending", "snoozed"]).select("outbox_id");
  if (error) throw error;
  return data?.length ?? 0;
}

/**
 * Periodic sweep: open notifications linked to a record that is now closed are cancelled
 * (task done/cancelled, meeting cancelled, change proposal decided).
 */
export async function sweepObsolete(admin: Db, ws: string): Promise<number> {
  const { data: open } = await admin.from("notification_state").select("outbox_id, record_type, record_id").eq("workspace_id", ws)
    .in("status", ["pending", "snoozed"]).in("record_type", ["task", "meeting_prep", "meeting_visit", "change_proposal"]).limit(1000);
  const rows = (open ?? []) as { outbox_id: string; record_type: string; record_id: string }[];
  if (!rows.length) return 0;
  const ids = (t: string) => [...new Set(rows.filter((r) => r.record_type === t).map((r) => r.record_id))];
  const closed = new Map<string, string>();
  const check = async (t: string, table: string, col: string, isClosed: (r: any) => boolean, why: string) => {
    const list = ids(t);
    for (let i = 0; i < list.length; i += 200) {
      const { data } = await admin.from(table).select(`id, ${col}, archived_at`).eq("workspace_id", ws).in("id", list.slice(i, i + 200));
      const found = new Set<string>();
      for (const r of (data ?? []) as any[]) { found.add(r.id); if (r.archived_at || isClosed(r)) closed.set(`${t}:${r.id}`, why); }
      for (const id of list.slice(i, i + 200)) if (!found.has(id)) closed.set(`${t}:${id}`, "record no longer exists");
    }
  };
  await check("task", "task", "status", (r) => ["done", "cancelled"].includes(r.status), "task closed");
  await check("meeting_prep", "meeting_prep", "status", (r) => r.status === "cancelled", "meeting cancelled");
  await check("meeting_visit", "meeting_visit", "status", (r) => r.status === "cancelled", "meeting cancelled");
  await check("change_proposal", "change_proposal", "state", (r) => !["proposed", "clarify"].includes(r.state), "approval decided");
  let n = 0;
  for (const r of rows) {
    const why = closed.get(`${r.record_type}:${r.record_id}`);
    if (!why) continue;
    const { data } = await admin.from("notification_state").update({ status: "cancelled", cancel_reason: why, updated_at: new Date().toISOString() })
      .eq("workspace_id", ws).eq("outbox_id", r.outbox_id).in("status", ["pending", "snoozed"]).select("outbox_id");
    n += data?.length ?? 0;
  }
  return n;
}
