import "server-only";
import type { Db } from "@/lib/supabase/server";
import { createDraft } from "@/lib/services/drafts";
import { createTask } from "@/lib/services/tasks";
import { fmt, localDate } from "@/lib/util/time";
import type { CalendarEventItem } from "./types";

/**
 * Calendar & visits (spec §8 "Calendar and visits"). Read-only provider events become meeting_visit rows keyed by
 * external id. Reschedule => new version_key (invalidates the T-60 pre-meeting brief) + previous_start_at; cancellation
 * => status cancelled. Conflicts and locality clusters are computed deterministically. Invites are DRAFTS only.
 */
export type VisitKind = "meeting" | "site_visit" | "call" | "internal";
export interface GeoName { name: string; aliases: string[] }

export function versionKey(provider: string, externalId: string, startIso: string) {
  return `${provider}:${externalId}:${new Date(startIso).toISOString()}`;
}

export function inferKind(e: Pick<CalendarEventItem, "title" | "isOnline" | "attendees" | "location">, ownDomains: string[] = []): VisitKind {
  const t = `${e.title ?? ""} ${e.location ?? ""}`.toLowerCase();
  if (/(site visit|tour|walk-?through|recce|inspection)/.test(t)) return "site_visit";
  const external = e.attendees.filter((a) => !ownDomains.some((d) => a.address.toLowerCase().endsWith(`@${d}`)));
  if (/(internal|pipeline review|team sync|1:1|standup)/.test(t) || (e.attendees.length > 0 && external.length === 0 && ownDomains.length > 0)) return "internal";
  if (e.isOnline || /(call|teams|zoom|meet\.google)/.test(t)) return "call";
  return "meeting";
}

export function matchLocality(text: string | null | undefined, geos: GeoName[]): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  let best: { name: string; len: number } | null = null;
  for (const g of geos) {
    for (const n of [g.name, ...(g.aliases ?? [])]) {
      const v = n.trim().toLowerCase();
      if (v.length >= 3 && new RegExp(`(^|[^a-z])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(t) && (!best || v.length > best.len)) best = { name: g.name, len: v.length };
    }
  }
  return best?.name ?? null;
}

export interface AgendaItem { id: string; title: string | null; start_at: string; end_at: string; status: string; kind: string; locality?: string | null; location?: string | null }

/** Overlapping, non-cancelled items (pairs of ids). */
export function findConflicts(items: AgendaItem[]): [string, string][] {
  const live = items.filter((i) => i.status !== "cancelled").sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  const out: [string, string][] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length && Date.parse(live[j].start_at) < Date.parse(live[i].end_at); j++) out.push([live[i].id, live[j].id]);
  }
  return out;
}

/** Group in-person items by local day + locality (provisional route clustering; no live traffic data). */
export function clusterByLocality(items: AgendaItem[], tz = "Asia/Kolkata") {
  const groups = new Map<string, AgendaItem[]>();
  for (const i of items) {
    if (i.status === "cancelled" || i.kind === "call" || i.kind === "internal" || !i.locality) continue;
    const k = `${localDate(new Date(i.start_at), tz)}|${i.locality}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  return [...groups.entries()].map(([k, v]) => ({ day: k.split("|")[0], locality: k.split("|")[1], items: v.sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at)) }));
}

export async function loadGeos(db: Db, ws: string): Promise<GeoName[]> {
  const { data } = await db.from("geography").select("name, aliases").eq("workspace_id", ws).in("level", ["locality", "micro_market", "corridor"]).is("archived_at", null).limit(2000);
  return (data ?? []) as GeoName[];
}

export type EventChange = "created" | "rescheduled" | "cancelled" | "updated" | "unchanged";

/** Upsert one provider event into meeting_visit + calendar_event. Idempotent per (provider, external id, change key). */
export async function upsertCalendarEvent(db: Db, ws: string, p: {
  item: CalendarEventItem; provider: string; connectorAccountId: string | null; ownerUserId: string | null; geos: GeoName[]; ownDomains?: string[];
}): Promise<{ meetingVisitId: string | null; change: EventChange }> {
  const e = p.item;
  const { data: ce } = await db.from("calendar_event").select("id, meeting_visit_id, change_key, reschedule_count, meeting_visit(start_at, end_at, status)")
    .eq("workspace_id", ws).eq("provider", p.provider).eq("external_id", e.id).maybeSingle();
  const cancelled = e.isCancelled || !!e.removed;
  const now = new Date().toISOString();
  if (!ce) {
    if (e.removed) return { meetingVisitId: null, change: "unchanged" };
    const locality = matchLocality(`${e.location ?? ""} ${e.title ?? ""}`, p.geos);
    const kind = inferKind(e, p.ownDomains);
    const { data: mv, error } = await db.from("meeting_visit").insert({
      workspace_id: ws, external_calendar_id: e.id, provider: p.provider, title: e.title, start_at: e.start, end_at: e.end, timezone: e.timezone,
      location: e.location, kind, status: cancelled ? "cancelled" : "confirmed", route_group: locality ? `${localDate(new Date(e.start))}:${locality}` : null,
      version_key: versionKey(p.provider, e.id, e.start), classification: "corporate_confidential", owner_user_id: p.ownerUserId,
    }).select("id").single();
    if (error) throw error;
    const { error: e2 } = await db.from("calendar_event").insert({
      workspace_id: ws, meeting_visit_id: mv.id, connector_account_id: p.connectorAccountId, provider: p.provider, external_id: e.id, ical_uid: e.iCalUId,
      organizer: e.organizer, attendees: e.attendees, is_online: e.isOnline, change_key: e.changeKey, locality, last_synced_at: now, owner_user_id: p.ownerUserId,
    });
    if (e2 && e2.code !== "23505") throw e2;
    return { meetingVisitId: mv.id, change: cancelled ? "cancelled" : "created" };
  }
  const mvCur = (ce.meeting_visit as unknown as { start_at: string; end_at: string; status: string } | null);
  if (cancelled) {
    if (mvCur?.status === "cancelled") return { meetingVisitId: ce.meeting_visit_id, change: "unchanged" };
    await db.from("meeting_visit").update({ status: "cancelled" }).eq("workspace_id", ws).eq("id", ce.meeting_visit_id);
    await db.from("calendar_event").update({ change_key: e.changeKey, last_synced_at: now }).eq("workspace_id", ws).eq("id", ce.id);
    return { meetingVisitId: ce.meeting_visit_id, change: "cancelled" };
  }
  if (ce.change_key && e.changeKey && ce.change_key === e.changeKey && mvCur?.status !== "cancelled") {
    await db.from("calendar_event").update({ last_synced_at: now }).eq("workspace_id", ws).eq("id", ce.id);
    return { meetingVisitId: ce.meeting_visit_id, change: "unchanged" };
  }
  const moved = !!mvCur && (Date.parse(mvCur.start_at) !== Date.parse(e.start) || Date.parse(mvCur.end_at) !== Date.parse(e.end));
  const locality = matchLocality(`${e.location ?? ""} ${e.title ?? ""}`, p.geos);
  await db.from("meeting_visit").update({
    title: e.title, start_at: e.start, end_at: e.end, timezone: e.timezone, location: e.location, status: mvCur?.status === "completed" ? "completed" : "confirmed",
    route_group: locality ? `${localDate(new Date(e.start))}:${locality}` : null, version_key: versionKey(p.provider, e.id, e.start),
  }).eq("workspace_id", ws).eq("id", ce.meeting_visit_id);
  await db.from("calendar_event").update({
    attendees: e.attendees, organizer: e.organizer, is_online: e.isOnline, change_key: e.changeKey, locality, last_synced_at: now,
    ...(moved ? { previous_start_at: mvCur!.start_at, reschedule_count: (ce.reschedule_count ?? 0) + 1 } : {}),
  }).eq("workspace_id", ws).eq("id", ce.id);
  return { meetingVisitId: ce.meeting_visit_id, change: moved ? "rescheduled" : mvCur?.status === "cancelled" ? "created" : "updated" };
}

export async function agenda(db: Db, ws: string, from: Date, to: Date) {
  const { data, error } = await db.from("meeting_visit")
    .select("id, title, start_at, end_at, timezone, location, kind, status, route_group, version_key, opportunity_id, provider, calendar_event(locality, attendees, is_online, previous_start_at, reschedule_count, last_synced_at), visit_feedback(id, attended, client_rating, next_step)")
    .eq("workspace_id", ws).is("archived_at", null).gte("end_at", from.toISOString()).lte("start_at", to.toISOString()).order("start_at");
  if (error) throw error;
  return (data ?? []).map((r) => {
    const ce = (Array.isArray(r.calendar_event) ? r.calendar_event[0] : r.calendar_event) as { locality: string | null; attendees: { address: string; name?: string | null; response?: string | null }[]; is_online: boolean; previous_start_at: string | null; reschedule_count: number; last_synced_at: string } | null;
    const fb = (Array.isArray(r.visit_feedback) ? r.visit_feedback[0] : r.visit_feedback) as { id: string; attended: boolean | null; client_rating: number | null; next_step: string | null } | null;
    return { ...r, calendar_event: undefined, visit_feedback: undefined, event: ce, feedback: fb, locality: ce?.locality ?? null };
  });
}

export interface FeedbackInput {
  attended?: boolean | null; clientRating?: number | null; liked?: string | null; concerns?: string | null; dealbreakers?: string | null; nextStep?: string | null; followUpDue?: string | null;
}

/** Visit feedback form: one row per visit (upsert). A next step with a due date becomes one task. */
export async function saveVisitFeedback(db: Db, ws: string, meetingVisitId: string, f: FeedbackInput, userId: string) {
  const row = {
    workspace_id: ws, meeting_visit_id: meetingVisitId, attended: f.attended ?? null, client_rating: f.clientRating ?? null, liked: f.liked ?? null,
    concerns: f.concerns ?? null, dealbreakers: f.dealbreakers ?? null, next_step: f.nextStep ?? null, follow_up_due: f.followUpDue ?? null, submitted_by: userId,
  };
  const { data: existing } = await db.from("visit_feedback").select("id").eq("workspace_id", ws).eq("meeting_visit_id", meetingVisitId).maybeSingle();
  const res = existing
    ? await db.from("visit_feedback").update(row).eq("workspace_id", ws).eq("id", existing.id).select().single()
    : await db.from("visit_feedback").insert({ ...row, owner_user_id: userId }).select().single();
  if (res.error) throw res.error;
  if (f.attended) await db.from("meeting_visit").update({ status: "completed" }).eq("workspace_id", ws).eq("id", meetingVisitId).neq("status", "cancelled");
  let taskId: string | null = null;
  if (f.nextStep?.trim()) {
    const t = await createTask(db, ws, { title: f.nextStep.trim().slice(0, 200), dueAt: f.followUpDue ? `${f.followUpDue}T12:00:00+05:30` : null, linkedEntityType: "meeting_visit",
      linkedEntityId: meetingVisitId, source: "workflow", idempotencyKey: `integrations.visit_feedback:${meetingVisitId}`, ownerUserId: userId });
    taskId = t.id;
  }
  return { feedback: res.data, taskId };
}

/** Calendar invite as a DRAFT (no calendar write scope exists). The user sends it from their own calendar/mail. */
export async function draftInvite(db: Db, ws: string, p: {
  title: string; start: string; end: string; location?: string | null; attendeeAddress?: string | null; attendeeName?: string | null; recipientPersonId?: string | null;
  opportunityId?: string | null; note?: string | null; tz?: string; ownerUserId: string;
}) {
  const tz = p.tz ?? "Asia/Kolkata";
  const body = [
    `Hi ${p.attendeeName?.split(/\s+/)[0] ?? "there"},`, "",
    `Proposed: ${p.title}`, `When: ${fmt(p.start, "EEE dd MMM yyyy, HH:mm", tz)}–${fmt(p.end, "HH:mm", tz)} (${tz})`,
    p.location ? `Where: ${p.location}` : null, p.note ? `\n${p.note}` : null, "", "Please let me know if this works.", "", "Best regards",
  ].filter((x) => x !== null).join("\n");
  return createDraft(db, ws, { channel: "calendar_invite", recipientAddress: p.attendeeAddress ?? null, recipientDisplay: p.attendeeName ?? null,
    recipientPersonId: p.recipientPersonId ?? null, subject: `Invitation: ${p.title}`, body, opportunityId: p.opportunityId ?? null, purpose: "calendar invite", ownerUserId: p.ownerUserId });
}
