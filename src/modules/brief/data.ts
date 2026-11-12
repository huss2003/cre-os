import "server-only";
/**
 * Loaders for the plan, brief and pages. Two calling modes (rule S2):
 *  - user client (ctx.db, RLS enforced) with `access = null`;
 *  - admin client from jobs with `access = loadMemberAccess(...)`, so every row is filtered exactly as RLS would for
 *    that member, and every query filters workspace_id explicitly.
 */
import type { Db } from "@/lib/supabase/server";
import { atLocal } from "@/lib/util/time";
import type { IntelLite, MeetingView, PipelineInput, ReplyLite, TaskLite } from "./builder";
import { pipelineSnapshot } from "./builder";
import { addDays, monthStart } from "./dates";
import { fetchAll } from "./db";
import { computeSourceHealth, type SourceStatus } from "./source-health";
import type { BriefSettings } from "./settings";
import { visible, type MemberAccess } from "./visibility";

const VIS = "classification, owner_user_id, archived_at";

function chunk<T>(a: T[], n = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

export interface LoadCtx { db: Db; workspaceId: string; userId: string; tz: string; access: MemberAccess | null }

function filt<T extends { id: string }>(c: LoadCtx, rows: T[] | null | undefined, type: string): T[] {
  return c.access ? visible(c.access, rows as any, type) as T[] : (rows ?? []);
}

/**
 * Job mode (service role): push the member's read scope into the query, so a row cap applies to rows the user can
 * see rather than to the whole workspace (filtering after `.limit()` under-counted busy workspaces). `filt` still runs.
 */
function scoped(c: LoadCtx, q: any, type: string): any {
  const m = c.access;
  if (!m) return q;
  q = q.in("classification", m.allowedClassifications.length ? m.allowedClassifications : ["__none__"]);
  if (m.role === "owner" || m.role === "admin" || m.seeAllAccounts) return q;
  const shared = [...m.shares].filter((k) => k.startsWith(`${type}:`)).map((k) => k.slice(type.length + 1)).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  return q.or(shared.length ? `owner_user_id.eq.${m.userId},id.in.(${shared.join(",")})` : `owner_user_id.eq.${m.userId}`);
}

export async function loadSources(c: LoadCtx, settings: BriefSettings, now: Date): Promise<SourceStatus[]> {
  const { data: accounts } = await c.db.from("connector_account").select("id, provider, status, last_error")
    .eq("workspace_id", c.workspaceId).eq("user_id", c.userId);
  const ids = (accounts ?? []).map((a: { id: string }) => a.id);
  const cursors = ids.length
    ? (await c.db.from("connector_cursor").select("connector_account_id, resource, last_success_at, last_attempt_at, last_error").eq("workspace_id", c.workspaceId).in("connector_account_id", ids)).data ?? []
    : [];
  return computeSourceHealth(accounts ?? [], cursors, now, settings);
}

/** The user's meetings on a local date (owner = user, or unowned). */
export async function loadMeetings(c: LoadCtx, date: string): Promise<MeetingView[]> {
  const from = atLocal(date, "00:00", c.tz).toISOString();
  const to = atLocal(addDays(date, 1), "00:00", c.tz).toISOString();
  const { data, error } = await c.db.from("meeting_visit")
    .select(`id, title, start_at, end_at, kind, status, location, route_group, linked_entity_type, linked_entity_id, ${VIS}`)
    .eq("workspace_id", c.workspaceId).is("archived_at", null).gte("start_at", from).lt("start_at", to)
    .or(`owner_user_id.eq.${c.userId},owner_user_id.is.null`).order("start_at").limit(200);
  if (error) throw error;
  return filt(c, data, "meeting_visit").map((m: any) => ({
    id: m.id, title: m.title, startAt: m.start_at, endAt: m.end_at, kind: m.kind, status: m.status, location: m.location,
    routeGroup: m.route_group, linkedEntityType: m.linked_entity_type, linkedEntityId: m.linked_entity_id,
  }));
}

export function toTaskLite(t: any): TaskLite {
  return {
    id: t.id, title: t.title, dueAt: t.due_at, priority: t.priority, status: t.status, snoozedUntil: t.snoozed_until,
    linkedEntityType: t.linked_entity_type, linkedEntityId: t.linked_entity_id, source: t.source, completedAt: t.completed_at, updatedAt: t.updated_at,
  };
}

/** Open/snoozed/stale tasks assigned to the user (or unassigned and owned by them). */
export async function loadOpenTasks(c: LoadCtx): Promise<TaskLite[]> {
  const rows = await fetchAll((f, t) => c.db.from("task")
    .select(`id, title, due_at, priority, status, snoozed_until, linked_entity_type, linked_entity_id, source, completed_at, updated_at, assigned_user_id, ${VIS}`)
    .eq("workspace_id", c.workspaceId).is("archived_at", null).in("status", ["open", "snoozed", "stale"])
    .or(`assigned_user_id.eq.${c.userId},and(assigned_user_id.is.null,owner_user_id.eq.${c.userId})`)
    .order("id").range(f, t), { cap: 5000 });
  return filt(c, rows, "task").map(toTaskLite);
}

export async function loadApprovals(c: LoadCtx): Promise<{ changes: number; drafts: number; oldestAt: string | null }> {
  const [{ data: cps }, { data: drafts }] = await Promise.all([
    scoped(c, c.db.from("change_proposal").select(`id, created_at, ${VIS}`).eq("workspace_id", c.workspaceId).is("archived_at", null)
      .in("state", ["proposed", "clarify"]).eq("approval_required", true), "change_proposal").order("created_at").order("id").limit(1000),
    c.db.from("draft").select(`id, created_at, ${VIS}`).eq("workspace_id", c.workspaceId).is("archived_at", null)
      .eq("state", "drafted").eq("owner_user_id", c.userId).order("created_at").limit(1000),
  ]);
  const ch = filt(c, cps as { id: string; created_at: string }[], "change_proposal");
  const dr = filt(c, drafts, "draft") as { created_at: string }[];
  const oldest = [...ch, ...dr].map((r) => r.created_at).sort()[0] ?? null;
  return { changes: ch.length, drafts: dr.length, oldestAt: oldest };
}

/** Org ids linked to interactions (directly or via a person's current employment). */
async function orgLinks(c: LoadCtx, interactionIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!interactionIds.length) return out;
  const links = (await Promise.all(chunk(interactionIds).map(async (p) =>
    (await c.db.from("interaction_link").select("interaction_id, entity_type, entity_id").eq("workspace_id", c.workspaceId).in("interaction_id", p).in("entity_type", ["organisation", "person"])).data ?? []))).flat();
  const personIds = [...new Set(links.filter((l: any) => l.entity_type === "person").map((l: any) => l.entity_id))];
  const emp = personIds.length
    ? (await Promise.all(chunk(personIds).map(async (p) => (await c.db.from("employment").select("person_id, org_id").eq("workspace_id", c.workspaceId).eq("is_current", true).in("person_id", p)).data ?? []))).flat()
    : [];
  const orgsOfPerson = new Map<string, string[]>();
  for (const e of emp as any[]) orgsOfPerson.set(e.person_id, [...(orgsOfPerson.get(e.person_id) ?? []), e.org_id]);
  for (const l of links as any[]) {
    const orgs = l.entity_type === "organisation" ? [l.entity_id] : orgsOfPerson.get(l.entity_id) ?? [];
    const cur = out.get(l.interaction_id) ?? [];
    for (const o of orgs) if (!cur.includes(o)) cur.push(o);
    out.set(l.interaction_id, cur);
  }
  return out;
}

export async function orgNames(c: LoadCtx, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const part of chunk([...new Set(ids.filter(Boolean))])) {
    const { data } = await c.db.from("organisation").select(`id, display_name, ${VIS}`).eq("workspace_id", c.workspaceId).in("id", part);
    for (const r of filt(c, data, "organisation") as any[]) map.set(r.id, r.display_name);
  }
  return map;
}

/** Meaningful inbound replies since `sinceIso` (hot-reply candidates). Only shown by the builder when the inbox is healthy. */
export async function loadReplies(c: LoadCtx, sinceIso: string): Promise<ReplyLite[]> {
  const { data, error } = await c.db.from("interaction").select(`id, occurred_at, subject, summary, channel, ${VIS}`)
    .eq("workspace_id", c.workspaceId).is("archived_at", null).eq("direction", "inbound").eq("is_meaningful", true)
    .in("channel", ["email", "whatsapp", "linkedin"]).gte("occurred_at", sinceIso).order("occurred_at", { ascending: false }).limit(50);
  if (error) throw error;
  const rows = filt(c, data, "interaction") as any[];
  const links = await orgLinks(c, rows.map((r) => r.id));
  const names = await orgNames(c, [...links.values()].flat());
  return rows.map((r) => {
    const org = (links.get(r.id) ?? []).find((o) => names.has(o)) ?? null;
    return { id: r.id, occurredAt: r.occurred_at, subject: r.subject, summary: r.summary, orgId: org, orgName: org ? names.get(org)! : null };
  });
}

/**
 * Distinct companies first approached (first outbound by this user in the last 2 years) in the local month — drafts,
 * follow-ups and repeated contacts don't count (spec §13). Also returns every org approached before (for exploration).
 */
export async function loadApproaches(c: LoadCtx, date: string): Promise<{ thisMonth: number; approached: Set<string> }> {
  const mStart = atLocal(monthStart(date), "00:00", c.tz).toISOString();
  const end = atLocal(addDays(date, 1), "00:00", c.tz).toISOString();
  const rows = await fetchAll((f, t) => c.db.from("interaction").select(`id, occurred_at, ${VIS}`)
    .eq("workspace_id", c.workspaceId).is("archived_at", null).eq("direction", "outbound")
    .in("channel", ["email", "call", "linkedin", "whatsapp", "meeting", "visit"]).eq("owner_user_id", c.userId)
    .lt("occurred_at", end).gte("occurred_at", addDays(date, -730) + "T00:00:00Z").order("id").range(f, t), { cap: 20_000 });
  const vis = filt(c, rows, "interaction") as any[];
  const links = await orgLinks(c, vis.map((r) => r.id));
  const first = new Map<string, string>();
  for (const r of vis) for (const o of links.get(r.id) ?? []) if (!first.has(o) || r.occurred_at < first.get(o)!) first.set(o, r.occurred_at);
  let n = 0;
  for (const at of first.values()) if (at >= mStart) n++;
  return { thisMonth: n, approached: new Set(first.keys()) };
}

export async function loadIntel(c: LoadCtx, today: string): Promise<IntelLite[]> {
  const since = addDays(today, -21);
  const { data, error } = await c.db.from("signal_claim")
    .select(`id, subject_id, claim_type, evidence_excerpt, source_url, published_on, observed_on, expires_on, status, evidence_tier, ${VIS}`)
    .eq("workspace_id", c.workspaceId).is("archived_at", null).eq("subject_type", "organisation").not("source_url", "is", null)
    .or(`observed_on.gte.${since},published_on.gte.${since}`).order("observed_on", { ascending: false, nullsFirst: false }).limit(100);
  if (error) throw error;
  const rows = (filt(c, data, "signal_claim") as any[]).filter((s) => !s.expires_on || s.expires_on >= today);
  const names = await orgNames(c, rows.map((r) => r.subject_id));
  return rows.filter((r) => names.has(r.subject_id)).map((r) => ({
    id: r.id, orgId: r.subject_id, orgName: names.get(r.subject_id)!, claimType: r.claim_type, excerpt: r.evidence_excerpt,
    sourceUrl: r.source_url, date: r.observed_on ?? r.published_on, status: r.status, evidenceTier: r.evidence_tier,
  }));
}

export async function loadPipeline(c: LoadCtx, today: string): Promise<PipelineInput> {
  const opps = filt(c, await fetchAll((f, t) => c.db.from("opportunity")
    .select(`id, stage, outcome, expected_fee, credit_share, expected_close, next_action, next_action_due, account_owner_user_id, ${VIS}`)
    .eq("workspace_id", c.workspaceId).is("archived_at", null).order("id").range(f, t)), "opportunity") as any[];
  const fees = filt(c, await fetchAll((f, t) => c.db.from("fee_milestone")
    .select(`id, invoiced_amount, invoiced_on, collected_amount, collected_on, ${VIS}`)
    .eq("workspace_id", c.workspaceId).is("archived_at", null).order("id").range(f, t)), "fee_milestone") as any[];
  return pipelineSnapshot(opps, fees, today);
}
