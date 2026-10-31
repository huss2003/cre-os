import "server-only";
import type { Db } from "@/lib/supabase/server";
import { createDraft } from "@/lib/services/drafts";
import { createTask } from "@/lib/services/tasks";
import { sha256 } from "@/lib/util/crypto";
import { fmt, localDate } from "@/lib/util/time";
import { notify } from "@/modules/brief/db";
import { ensureInteractionLink } from "./links";
import { CLUSTER_MAX_MINUTES, estimateTravelMinutes, hasPoint, toPoint } from "./travel";
import type { CalendarEventItem } from "./types";

/**
 * Calendar & visits (spec §8 "Calendar and visits"). Read-only provider events become meeting_visit rows keyed by
 * external id. Reschedule => new version_key (invalidates the T-60 pre-meeting brief) + previous_start_at; cancellation
 * => status cancelled. Conflicts and locality clusters are computed deterministically. Invites are DRAFTS only.
 */
export type VisitKind = "meeting" | "site_visit" | "call" | "internal";
export interface GeoName { name: string; aliases: string[]; lat?: number | string | null; lon?: number | string | null }

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

export interface AgendaItem {
  id: string; title: string | null; start_at: string; end_at: string; status: string; kind: string; locality?: string | null; location?: string | null;
  lat?: number | string | null; lon?: number | string | null; owner_user_id?: string | null; version_key?: string | null;
}

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
  const { data } = await db.from("geography").select("name, aliases, lat, lon").eq("workspace_id", ws).in("level", ["locality", "micro_market", "corridor"]).is("archived_at", null).limit(2000);
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
    .select("id, title, start_at, end_at, timezone, location, lat, lon, kind, status, route_group, version_key, opportunity_id, provider, owner_user_id, linked_entity_type, linked_entity_id, calendar_event(locality, attendees, is_online, previous_start_at, reschedule_count, last_synced_at), visit_feedback(id, attended, client_rating, next_step), visit_checklist_item(id, item_key, label, position, done)")
    .eq("workspace_id", ws).is("archived_at", null).gte("end_at", from.toISOString()).lte("start_at", to.toISOString()).order("start_at");
  if (error) throw error;
  return (data ?? []).map((r) => {
    const ce = (Array.isArray(r.calendar_event) ? r.calendar_event[0] : r.calendar_event) as { locality: string | null; attendees: { address: string; name?: string | null; response?: string | null }[]; is_online: boolean; previous_start_at: string | null; reschedule_count: number; last_synced_at: string } | null;
    const fb = (Array.isArray(r.visit_feedback) ? r.visit_feedback[0] : r.visit_feedback) as { id: string; attended: boolean | null; client_rating: number | null; next_step: string | null } | null;
    const checklist = (r.visit_checklist_item ?? []) as StoredChecklistItem[];
    const manualLocality = r.provider === "manual" && r.route_group ? r.route_group.split(":").slice(1).join(":") || null : null;
    return { ...r, calendar_event: undefined, visit_feedback: undefined, visit_checklist_item: undefined, event: ce, feedback: fb, checklist,
      locality: ce?.locality ?? manualLocality };
  });
}

/** Fill missing coordinates from the matched locality's centroid (geography.lat/lon). Coordinates stay null if unknown. */
export function withPoints<T extends AgendaItem>(items: T[], geos: GeoName[]): (T & { point_source: "exact" | "locality" | null })[] {
  const byName = new Map(geos.filter(hasPoint).map((g) => [g.name.toLowerCase(), g]));
  return items.map((i) => {
    if (hasPoint(i)) return { ...i, point_source: "exact" as const };
    const g = i.locality ? byName.get(i.locality.toLowerCase()) : undefined;
    return g ? { ...i, lat: g.lat, lon: g.lon, point_source: "locality" as const } : { ...i, point_source: null };
  });
}

const inPerson = (i: AgendaItem) => i.status !== "cancelled" && (i.kind === "site_visit" || i.kind === "meeting");

export interface TravelConflict { a: string; b: string; gapMinutes: number; travelMinutes: number }

/** Consecutive in-person items (same owner, same local day) where the gap is shorter than the estimated travel time. */
export function findTravelConflicts(items: AgendaItem[], tz = "Asia/Kolkata"): TravelConflict[] {
  const groups = new Map<string, AgendaItem[]>();
  for (const i of items.filter(inPerson)) {
    const k = `${i.owner_user_id ?? ""}|${localDate(new Date(i.start_at), tz)}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const out: TravelConflict[] = [];
  for (const list of groups.values()) {
    const sorted = list.sort((x, y) => Date.parse(x.start_at) - Date.parse(y.start_at));
    for (let n = 1; n < sorted.length; n++) {
      const prev = sorted[n - 1], next = sorted[n];
      if (!hasPoint(prev) || !hasPoint(next)) continue;
      const gap = (Date.parse(next.start_at) - Date.parse(prev.end_at)) / 60_000;
      if (gap < 0) continue; // overlaps are reported by findConflicts
      const travel = estimateTravelMinutes(toPoint(prev), toPoint(next));
      if (gap < travel) out.push({ a: prev.id, b: next.id, gapMinutes: Math.round(gap), travelMinutes: travel });
    }
  }
  return out;
}

export interface RouteLeg { from: string; to: string; travelMinutes: number; gapMinutes: number; feasible: boolean }
export interface RouteCluster { day: string; label: string; items: AgendaItem[]; legs: RouteLeg[]; basis: "travel_estimate" | "locality" }

/**
 * Provisional route clusters: per day, in-person visits within CLUSTER_MAX_MINUTES estimated travel of each other
 * (single-link) form one cluster; visits without coordinates fall back to locality grouping. User confirms routes.
 */
export function planRoutes(items: AgendaItem[], tz = "Asia/Kolkata"): RouteCluster[] {
  const byDay = new Map<string, AgendaItem[]>();
  for (const i of items.filter(inPerson)) {
    const d = localDate(new Date(i.start_at), tz);
    byDay.set(d, [...(byDay.get(d) ?? []), i]);
  }
  const out: RouteCluster[] = [];
  for (const [day, list] of byDay) {
    const pts = list.filter(hasPoint);
    const parent = new Map(pts.map((p) => [p.id, p.id]));
    const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
    for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) {
      if (estimateTravelMinutes(toPoint(pts[a] as { lat: number; lon: number }), toPoint(pts[b] as { lat: number; lon: number })) <= CLUSTER_MAX_MINUTES) parent.set(find(pts[a].id), find(pts[b].id));
    }
    const groups = new Map<string, AgendaItem[]>();
    for (const p of pts) groups.set(find(p.id), [...(groups.get(find(p.id)) ?? []), p]);
    for (const g of groups.values()) {
      const sorted = g.sort((x, y) => Date.parse(x.start_at) - Date.parse(y.start_at));
      const legs: RouteLeg[] = sorted.slice(1).map((n, k) => {
        const prev = sorted[k];
        const travel = estimateTravelMinutes(toPoint(prev as { lat: number; lon: number }), toPoint(n as { lat: number; lon: number }));
        const gap = Math.round((Date.parse(n.start_at) - Date.parse(prev.end_at)) / 60_000);
        return { from: prev.id, to: n.id, travelMinutes: travel, gapMinutes: gap, feasible: gap >= travel };
      });
      const names = [...new Set(sorted.map((x) => x.locality).filter(Boolean))] as string[];
      out.push({ day, label: names.join(" / ") || "Nearby visits", items: sorted, legs, basis: "travel_estimate" });
    }
    const noPoint = list.filter((i) => !hasPoint(i) && i.locality);
    const byLoc = new Map<string, AgendaItem[]>();
    for (const i of noPoint) byLoc.set(i.locality!, [...(byLoc.get(i.locality!) ?? []), i]);
    for (const [loc, g] of byLoc) out.push({ day, label: loc, items: g.sort((x, y) => Date.parse(x.start_at) - Date.parse(y.start_at)), legs: [], basis: "locality" });
  }
  return out.sort((x, y) => x.day.localeCompare(y.day) || Date.parse(x.items[0].start_at) - Date.parse(y.items[0].start_at));
}

export interface ConflictAlert { kind: "overlap" | "travel"; a: AgendaItem; b: AgendaItem; detail: string; dedupeKey: string }

/** Pure: all conflicts (overlap + travel) as alert candidates with a dedupe key bound to both items' versions. */
export function conflictAlerts(items: AgendaItem[], tz = "Asia/Kolkata", now = new Date()): ConflictAlert[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const future = (i: AgendaItem) => Date.parse(i.end_at) > now.getTime() && i.status !== "cancelled";
  const key = (kind: string, a: AgendaItem, b: AgendaItem) => `calendar_conflict:${kind}:${[a.id, b.id].sort().join(":")}:${sha256(`${a.version_key ?? a.start_at}|${b.version_key ?? b.start_at}`).slice(0, 16)}`;
  const out: ConflictAlert[] = [];
  for (const [x, y] of findConflicts(items)) {
    const a = byId.get(x)!, b = byId.get(y)!;
    if (!future(a) || !future(b)) continue;
    out.push({ kind: "overlap", a, b, dedupeKey: key("overlap", a, b),
      detail: `“${a.title ?? "event"}” (${fmt(a.start_at, "dd MMM HH:mm", tz)}) overlaps “${b.title ?? "event"}” (${fmt(b.start_at, "HH:mm", tz)}).` });
  }
  for (const t of findTravelConflicts(items, tz)) {
    const a = byId.get(t.a)!, b = byId.get(t.b)!;
    if (!future(a) || !future(b)) continue;
    out.push({ kind: "travel", a, b, dedupeKey: key("travel", a, b),
      detail: `Only ${t.gapMinutes} min between “${a.title ?? "visit"}” and “${b.title ?? "visit"}” (${fmt(b.start_at, "dd MMM HH:mm", tz)}); estimated travel ${t.travelMinutes} min (estimate, no live traffic).` });
  }
  return out;
}

/**
 * Write deduped in-app conflict alerts (outbox via notify) for the next `days`. Service-role client (job) — explicit
 * workspace filter. Re-running is a no-op; a reschedule that still conflicts alerts again (new version key).
 */
export async function detectConflictsAndNotify(admin: Db, ws: string, opts: { now?: Date; days?: number; tz?: string } = {}) {
  const now = opts.now ?? new Date();
  const items = withPoints(await agenda(admin, ws, now, new Date(now.getTime() + (opts.days ?? 14) * 86_400_000)), await loadGeos(admin, ws));
  const alerts = conflictAlerts(items, opts.tz, now);
  for (const al of alerts) {
    const owner = al.a.owner_user_id ?? al.b.owner_user_id ?? null;
    await notify(admin, ws, owner, "calendar_conflict", al.dedupeKey, { kind: al.kind, detail: al.detail, meeting_visit_ids: [al.a.id, al.b.id], href: "/calendar" });
  }
  return alerts.map((a) => a.dedupeKey);
}

export interface FeedbackInput {
  attended?: boolean | null; clientRating?: number | null; liked?: string | null; concerns?: string | null; dealbreakers?: string | null; nextStep?: string | null; followUpDue?: string | null;
}

/**
 * Visit feedback form: one row per visit (upsert). The outcome is logged once as an interaction linked to the visit
 * (and its asset / opportunity); a next step becomes one follow-up task linked to the visit and that interaction.
 */
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
  const { data: mv } = await db.from("meeting_visit").select("id, title, kind, start_at, opportunity_id, linked_entity_type, linked_entity_id").eq("workspace_id", ws).eq("id", meetingVisitId).maybeSingle();

  // outcome => one interaction per visit (dedupe on source_message_id)
  let interactionId: string | null = null;
  const notes = [f.liked && `Liked: ${f.liked}`, f.concerns && `Concerns: ${f.concerns}`, f.dealbreakers && `Deal-breakers: ${f.dealbreakers}`,
    f.clientRating ? `Client interest ${f.clientRating}/5` : null, f.nextStep && `Next step: ${f.nextStep}`].filter(Boolean) as string[];
  if (mv && (f.attended === true || notes.length)) {
    const src = `visit:${meetingVisitId}`;
    const summary = `${f.attended === false ? "Did not take place" : "Visit outcome"}${notes.length ? ` — ${notes.join("; ")}` : ""}`.slice(0, 2000);
    const { data: ex } = await db.from("interaction").select("id").eq("workspace_id", ws).eq("source_message_id", src).limit(1);
    if (ex?.[0]) {
      interactionId = ex[0].id as string;
      await db.from("interaction").update({ summary }).eq("workspace_id", ws).eq("id", interactionId);
    } else {
      const { data: it, error } = await db.from("interaction").insert({
        workspace_id: ws, occurred_at: mv.start_at, channel: mv.kind === "site_visit" ? "visit" : "meeting", direction: "outbound", subject: mv.title, summary,
        source_message_id: src, opportunity_id: mv.opportunity_id, is_meaningful: f.attended !== false, classification: "corporate_confidential", owner_user_id: userId,
      }).select("id").single();
      if (error) throw error;
      interactionId = it.id as string;
    }
    await ensureInteractionLink(db, ws, { interactionId, entityType: "meeting_visit", entityId: meetingVisitId, role: "outcome_of", ownerUserId: userId });
    if (mv.linked_entity_type && mv.linked_entity_id) await ensureInteractionLink(db, ws, { interactionId, entityType: mv.linked_entity_type, entityId: mv.linked_entity_id, role: "about", ownerUserId: userId });
    if (mv.opportunity_id) await ensureInteractionLink(db, ws, { interactionId, entityType: "opportunity", entityId: mv.opportunity_id, role: "about", ownerUserId: userId });
  }

  let taskId: string | null = null;
  if (f.nextStep?.trim()) {
    const t = await createTask(db, ws, { title: f.nextStep.trim().slice(0, 200), dueAt: f.followUpDue ? `${f.followUpDue}T12:00:00+05:30` : null, linkedEntityType: "meeting_visit",
      description: `Follow-up from ${mv?.kind === "site_visit" ? "site visit" : "meeting"} “${mv?.title ?? "visit"}”${interactionId ? ` (interaction ${interactionId})` : ""}.`,
      linkedEntityId: meetingVisitId, source: "workflow", idempotencyKey: `integrations.visit_feedback:${meetingVisitId}`, ownerUserId: userId });
    taskId = t.id;
    if (interactionId) await ensureInteractionLink(db, ws, { interactionId, entityType: "task", entityId: t.id, role: "follow_up", ownerUserId: userId });
  }
  return { feedback: res.data, taskId, interactionId };
}

// ------------------------------------------------------------------ planned visits (by hand) + checklist

export interface PlannedVisitInput {
  title: string; kind: "site_visit" | "meeting"; start: string; end: string; assetId?: string | null; location?: string | null; opportunityId?: string | null;
}
export class VisitInputError extends Error {}

/**
 * Create a planned (provisional) visit or meeting by hand — not from calendar sync. Linking an asset copies its
 * name/address and coordinates (used for travel estimates) and its locality (route grouping). Nothing is sent:
 * an invite to the client is a separate draft.
 */
export async function createPlannedVisit(db: Db, ws: string, p: PlannedVisitInput, userId: string, tz = "Asia/Kolkata") {
  const start = new Date(p.start), end = new Date(p.end);
  if (!p.title.trim()) throw new VisitInputError("title is required");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new VisitInputError("end must be after start");
  let location = p.location?.trim() || null;
  let lat: number | null = null, lon: number | null = null, locality: string | null = null;
  if (p.assetId) {
    const { data: a } = await db.from("asset").select("id, name, address, lat, lon, locality_id").eq("workspace_id", ws).eq("id", p.assetId).maybeSingle();
    if (!a) throw new VisitInputError("building not found");
    location = location ?? [a.name, a.address].filter(Boolean).join(", ");
    if (hasPoint(a)) { lat = Number(a.lat); lon = Number(a.lon); }
    if (a.locality_id) {
      const { data: g } = await db.from("geography").select("name").eq("workspace_id", ws).eq("id", a.locality_id).maybeSingle();
      locality = g?.name ?? null;
    }
  }
  if (!locality && location) locality = matchLocality(location, await loadGeos(db, ws));
  const id = crypto.randomUUID();
  const { data, error } = await db.from("meeting_visit").insert({
    id, workspace_id: ws, provider: "manual", title: p.title.trim().slice(0, 200), start_at: start.toISOString(), end_at: end.toISOString(), timezone: tz,
    location, lat, lon, kind: p.kind, status: "provisional", opportunity_id: p.opportunityId ?? null,
    linked_entity_type: p.assetId ? "asset" : null, linked_entity_id: p.assetId ?? null,
    route_group: locality ? `${localDate(start, tz)}:${locality}` : null, version_key: versionKey("manual", id, start.toISOString()),
    classification: "corporate_confidential", owner_user_id: userId,
  }).select().single();
  if (error) throw error;
  return data;
}

/** The user confirms (or cancels / reschedules) a hand-made visit. Synced events are owned by the provider calendar. */
export async function updatePlannedVisit(db: Db, ws: string, id: string, patch: { status?: "confirmed" | "cancelled" | "provisional"; start?: string; end?: string }) {
  const { data: cur } = await db.from("meeting_visit").select("id, provider, start_at, end_at, row_version").eq("workspace_id", ws).eq("id", id).maybeSingle();
  if (!cur) throw new VisitInputError("visit not found");
  if (cur.provider !== "manual") throw new VisitInputError("this event comes from your connected calendar — change it there");
  const start = patch.start ? new Date(patch.start).toISOString() : cur.start_at;
  const end = patch.end ? new Date(patch.end).toISOString() : cur.end_at;
  if (Date.parse(end) <= Date.parse(start)) throw new VisitInputError("end must be after start");
  const moved = Date.parse(start) !== Date.parse(cur.start_at);
  const { data, error } = await db.from("meeting_visit").update({
    ...(patch.status ? { status: patch.status } : {}), start_at: start, end_at: end, ...(moved ? { version_key: versionKey("manual", id, start) } : {}),
  }).eq("workspace_id", ws).eq("id", id).eq("row_version", cur.row_version).select().maybeSingle();
  if (error) throw error;
  if (!data) throw new VisitInputError("the visit changed meanwhile — reload and try again");
  return data;
}

export interface ChecklistItemDef { key: string; label: string }
export interface StoredChecklistItem { id: string; item_key: string; label: string; position: number; done: boolean }

export const SITE_VISIT_CHECKLIST: ChecklistItemDef[] = [
  { key: "confirm_slot", label: "Slot confirmed with client and landlord / building team" },
  { key: "pack", label: "Shortlist pack, floor plans and indicative commercials ready" },
  { key: "access", label: "Building access, visitor passes and parking arranged" },
  { key: "floorplate", label: "Floor plate, efficiency and column grid checked" },
  { key: "services", label: "Power back-up, HVAC hours and lift capacity checked" },
  { key: "condition", label: "Fit-out condition and handover state noted" },
  { key: "photos", label: "Photos of key areas taken (with permission)" },
  { key: "reactions", label: "Client reactions, concerns and deal-breakers captured" },
  { key: "next_step", label: "Next step agreed before leaving" },
];
export const MEETING_CHECKLIST: ChecklistItemDef[] = [
  { key: "brief_read", label: "Pre-meeting brief read" },
  { key: "agenda", label: "Agenda and one clear ask prepared" },
  { key: "notes", label: "Notes and promises captured" },
  { key: "next_step", label: "Next step agreed" },
];

/** Pure: default items for the visit kind merged with stored ticks and custom items. */
export function checklistFor(kind: string, stored: StoredChecklistItem[]) {
  const defs = kind === "site_visit" ? SITE_VISIT_CHECKLIST : kind === "meeting" ? MEETING_CHECKLIST : [];
  const byKey = new Map(stored.map((s) => [s.item_key, s]));
  const items = defs.map((d, i) => ({ key: d.key, label: d.label, position: i * 10, done: byKey.get(d.key)?.done ?? false, custom: false }));
  for (const s of stored.filter((x) => x.item_key.startsWith("custom:"))) items.push({ key: s.item_key, label: s.label, position: s.position, done: s.done, custom: true });
  return items.sort((a, b) => a.position - b.position);
}

/** Tick / untick a checklist item, or add a custom one (label). Upsert per (visit, item_key) — idempotent. */
export async function setChecklistItem(db: Db, ws: string, meetingVisitId: string, p: { itemKey?: string | null; label?: string | null; done: boolean }, userId: string) {
  const { data: mv } = await db.from("meeting_visit").select("id, kind").eq("workspace_id", ws).eq("id", meetingVisitId).maybeSingle();
  if (!mv) throw new VisitInputError("visit not found");
  const defs = mv.kind === "site_visit" ? SITE_VISIT_CHECKLIST : MEETING_CHECKLIST;
  let key = p.itemKey ?? null;
  let label: string;
  if (key && !key.startsWith("custom:")) {
    const d = defs.find((x) => x.key === key);
    if (!d) throw new VisitInputError("unknown checklist item");
    label = d.label;
  } else {
    label = (p.label ?? "").trim().slice(0, 200);
    if (!label && !key) throw new VisitInputError("label required");
    key = key ?? `custom:${sha256(label.toLowerCase()).slice(0, 16)}`;
    if (!label) {
      const { data: ex } = await db.from("visit_checklist_item").select("label").eq("workspace_id", ws).eq("meeting_visit_id", meetingVisitId).eq("item_key", key).maybeSingle();
      label = ex?.label ?? "item";
    }
  }
  const position = defs.findIndex((x) => x.key === key);
  const { data, error } = await db.from("visit_checklist_item").upsert({
    workspace_id: ws, meeting_visit_id: meetingVisitId, item_key: key, label, position: position >= 0 ? position * 10 : 1000,
    done: p.done, done_at: p.done ? new Date().toISOString() : null, done_by: p.done ? userId : null, owner_user_id: userId,
  }, { onConflict: "workspace_id,meeting_visit_id,item_key" }).select().single();
  if (error) throw error;
  return data;
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
