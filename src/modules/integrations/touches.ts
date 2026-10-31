import "server-only";
import type { Db } from "@/lib/supabase/server";

/**
 * Account-level touch calendar (spec "Account saturation and contact collision"): one calendar across you and
 * colleagues so the same account/person is not approached twice. Colleague details are exposed only through the
 * security-definer RPC integrations_touch_collisions (who/when/channel), never their message content.
 */
export type TouchChannel = "email" | "whatsapp" | "linkedin" | "call" | "meeting" | "visit" | "calendar_invite" | "introduction" | "other";
export type TouchKind = "planned" | "drafted" | "sent" | "inbound" | "meeting";

export interface TouchInput {
  orgId?: string | null;
  personId?: string | null;
  userId?: string | null;
  channel: TouchChannel;
  kind: TouchKind;
  at?: string;
  draftId?: string | null;
  enrollmentId?: string | null;
  interactionId?: string | null;
  dedupeKey?: string;
  note?: string;
}

export function touchChannelForDraft(channel: string): TouchChannel {
  return (["email", "whatsapp", "linkedin", "calendar_invite", "introduction"].includes(channel) ? channel : "other") as TouchChannel;
}

/** Idempotent when dedupeKey is given (unique workspace_id+dedupe_key). */
export async function recordTouch(db: Db, workspaceId: string, t: TouchInput) {
  if (!t.orgId && !t.personId) return null;
  const row = {
    workspace_id: workspaceId, org_id: t.orgId ?? null, person_id: t.personId ?? null, user_id: t.userId ?? null,
    channel: t.channel, touch_kind: t.kind, at: t.at ?? new Date().toISOString(), draft_id: t.draftId ?? null,
    enrollment_id: t.enrollmentId ?? null, interaction_id: t.interactionId ?? null, dedupe_key: t.dedupeKey ?? null,
    note: t.note ?? null, owner_user_id: t.userId ?? null,
  };
  if (t.dedupeKey) {
    const { data: existing } = await db.from("account_touch").select("id").eq("workspace_id", workspaceId).eq("dedupe_key", t.dedupeKey).maybeSingle();
    if (existing) return existing;
  }
  const { data, error } = await db.from("account_touch").insert(row).select("id").single();
  if (error) {
    if (error.code === "23505") return null; // concurrent duplicate
    throw error;
  }
  return data;
}

export interface CollisionTouch {
  user_id: string | null;
  display_name: string | null;
  channel: string;
  touch_kind: string;
  at: string;
}

export interface CollisionReport {
  collisions: CollisionTouch[];          // other colleagues' outbound/planned touches in the window
  outboundLast7d: number;                // all outbound touches on the account in the last 7 days (any colleague)
  saturated: boolean;                    // account weekly cap reached
  recentInbound: boolean;                // the person/account wrote in recently (reply => pause outreach)
}

/** Default account-level caps (configurable per sequence via caps.account_per_week). */
export const DEFAULT_ACCOUNT_PER_WEEK = 2;
export const COLLISION_WINDOW_DAYS = 14;

/** Pure evaluation (unit-testable). */
export function evaluateCollisions(touches: CollisionTouch[], me: string | null, now: Date, accountPerWeek = DEFAULT_ACCOUNT_PER_WEEK): CollisionReport {
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const outbound = touches.filter((t) => ["planned", "drafted", "sent"].includes(t.touch_kind));
  const outboundLast7d = touches.filter((t) => t.touch_kind === "sent" && Date.parse(t.at) >= weekAgo).length;
  return {
    collisions: outbound.filter((t) => t.user_id && t.user_id !== me),
    outboundLast7d,
    saturated: outboundLast7d >= accountPerWeek,
    recentInbound: touches.some((t) => t.touch_kind === "inbound" && Date.parse(t.at) >= weekAgo),
  };
}

export async function checkCollision(db: Db, workspaceId: string, q: { orgId?: string | null; personId?: string | null; userId: string | null; accountPerWeek?: number; now?: Date }): Promise<CollisionReport> {
  const now = q.now ?? new Date();
  const since = new Date(now.getTime() - COLLISION_WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await db.rpc("integrations_touch_collisions", { p_ws: workspaceId, p_org: q.orgId ?? null, p_person: q.personId ?? null, p_since: since });
  if (error) throw error;
  return evaluateCollisions((data ?? []) as CollisionTouch[], q.userId, now, q.accountPerWeek);
}

/** Same check for job context (service-role client; explicit workspace filter, no RPC membership check). */
export async function collisionsDirect(admin: Db, workspaceId: string, q: { orgId?: string | null; personId?: string | null; userId: string | null; accountPerWeek?: number; now?: Date }): Promise<CollisionReport> {
  const now = q.now ?? new Date();
  if (!q.orgId && !q.personId) return evaluateCollisions([], q.userId, now, q.accountPerWeek);
  const since = new Date(now.getTime() - COLLISION_WINDOW_DAYS * 86_400_000).toISOString();
  const ors = [q.orgId ? `org_id.eq.${q.orgId}` : null, q.personId ? `person_id.eq.${q.personId}` : null].filter(Boolean).join(",");
  const { data, error } = await admin.from("account_touch").select("user_id, channel, touch_kind, at").eq("workspace_id", workspaceId)
    .is("archived_at", null).gte("at", since).or(ors).limit(200);
  if (error) throw error;
  return evaluateCollisions((data ?? []).map((t) => ({ ...t, display_name: null })) as CollisionTouch[], q.userId, now, q.accountPerWeek);
}

/** Touch calendar for an account (visible rows only, RLS applies). */
export async function accountTouchCalendar(db: Db, workspaceId: string, orgId: string, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await db.from("account_touch").select("id, person_id, user_id, channel, touch_kind, at, draft_id, enrollment_id, note")
    .eq("workspace_id", workspaceId).eq("org_id", orgId).gte("at", since).order("at", { ascending: false });
  return data ?? [];
}

/** Current employer of a person (for account-level touches). */
export async function currentOrgForPerson(db: Db, workspaceId: string, personId: string): Promise<string | null> {
  const { data } = await db.from("employment").select("org_id").eq("workspace_id", workspaceId).eq("person_id", personId).eq("is_current", true)
    .order("start_date", { ascending: false, nullsFirst: false }).limit(1);
  return data?.[0]?.org_id ?? null;
}
