import "server-only";
/**
 * Relationship Caretaker data layer. Two modes (S1/S2): user client (RLS) with access=null, or the admin client in jobs
 * with an explicit workspace filter (+ member access when building one user's view).
 * Writes (job side only): deduped follow-up tasks linked to the interaction / visit, and deduped private alerts.
 * Never writes interaction.promises — a promise is only closed by a person.
 */
import { createTask } from "@/lib/services/tasks";
import type { Db } from "@/lib/supabase/server";
import { applyRestrictions, isRestrictive, parsePromises, promiseSuggestions, referralSuggestions, renewalSuggestions, sortSuggestions, visitSuggestions,
  type InteractionCtx, type RelSuggestion, type Restrictions, type VisitFeedbackCtx, type WonDealCtx } from "./caretaker";
import { addDays } from "./dates";
import { fetchAll, notify } from "./db";
import { rowsByKeys } from "./keys";
import type { RadarItem } from "./lease-radar";
import { visible, type MemberAccess } from "./visibility";

const VIS = "classification, owner_user_id, archived_at";

function chunk<T>(a: T[], n = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

function filt<T>(access: MemberAccess | null | undefined, rows: T[] | null | undefined, type: string): T[] {
  return access ? (visible(access, rows as any, type) as T[]) : (rows ?? []);
}

/** People and companies for which proactive suggestions are suppressed. */
export async function loadRestrictions(db: Db, workspaceId: string, personIds: string[], orgIds: string[]): Promise<Restrictions> {
  const persons = new Set<string>();
  const orgs = new Set<string>();
  const pids = [...new Set(personIds)];
  const oids = [...new Set(orgIds)];
  for (const part of chunk(pids)) {
    const [{ data: cps }, { data: tombs }, { data: ppl }] = await Promise.all([
      db.from("consent_permission").select("person_id, suppressed, revoked_at, purpose").eq("workspace_id", workspaceId).in("person_id", part).is("archived_at", null),
      db.from("suppression_tombstone").select("person_id").eq("workspace_id", workspaceId).in("person_id", part),
      db.from("person").select("id, contact_restrictions").eq("workspace_id", workspaceId).in("id", part),
    ]);
    // suppressed, or a revoked outreach/contact permission => no proactive suggestions
    for (const c of cps ?? []) if (c.suppressed || (c.revoked_at && (!c.purpose || /outreach|contact|marketing|all/i.test(c.purpose)))) persons.add(c.person_id);
    for (const t of tombs ?? []) if (t.person_id) persons.add(t.person_id);
    for (const p of ppl ?? []) if (isRestrictive(p.contact_restrictions)) persons.add(p.id);
  }
  for (const part of chunk(oids)) {
    const { data } = await db.from("organisation").select("id, contact_restrictions").eq("workspace_id", workspaceId).in("id", part);
    for (const o of data ?? []) if (isRestrictive(o.contact_restrictions)) orgs.add(o.id);
  }
  return { persons, orgs };
}

async function linksFor(db: Db, workspaceId: string, interactionIds: string[]): Promise<Map<string, { persons: string[]; orgs: string[] }>> {
  const out = new Map<string, { persons: string[]; orgs: string[] }>();
  for (const part of chunk(interactionIds)) {
    const { data } = await db.from("interaction_link").select("interaction_id, entity_type, entity_id").eq("workspace_id", workspaceId).in("interaction_id", part).in("entity_type", ["person", "organisation"]);
    for (const l of data ?? []) {
      const cur = out.get(l.interaction_id) ?? { persons: [], orgs: [] };
      (l.entity_type === "person" ? cur.persons : cur.orgs).push(l.entity_id);
      out.set(l.interaction_id, cur);
    }
  }
  // a linked person's current employer counts as the account (company-level restrictions apply)
  const people = [...new Set([...out.values()].flatMap((v) => v.persons))];
  const emp = new Map<string, string[]>();
  for (const part of chunk(people)) {
    const { data } = await db.from("employment").select("person_id, org_id").eq("workspace_id", workspaceId).eq("is_current", true).in("person_id", part);
    for (const e of data ?? []) emp.set(e.person_id, [...(emp.get(e.person_id) ?? []), e.org_id]);
  }
  for (const v of out.values()) for (const p of v.persons) for (const o of emp.get(p) ?? []) if (!v.orgs.includes(o)) v.orgs.push(o);
  return out;
}

async function orgNameMap(db: Db, workspaceId: string, ids: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const part of chunk([...new Set(ids)])) {
    const { data } = await db.from("organisation").select("id, display_name").eq("workspace_id", workspaceId).in("id", part);
    for (const o of data ?? []) m.set(o.id, o.display_name);
  }
  return m;
}

export interface CaretakerResult { suggestions: RelSuggestion[]; withheld: { key: string; kind: string; reason: string }[] }

/**
 * All relationship suggestions for `today`. `opts.userId` narrows to the member's own relationships (owner of the
 * interaction / visit / deal, or unowned); `access` filters rows exactly as RLS would in job mode.
 */
export async function computeRelationshipSuggestions(db: Db, workspaceId: string, today: string, radar: RadarItem[], opts: { access?: MemberAccess | null; userId?: string | null } = {}): Promise<CaretakerResult> {
  const access = opts.access ?? null;
  const since = addDays(today, -365) + "T00:00:00Z";
  const mineOnly = <T extends { owner_user_id?: string | null }>(rows: T[]) => (opts.userId ? rows.filter((r) => !r.owner_user_id || r.owner_user_id === opts.userId) : rows);

  // promises
  const ints = mineOnly(filt(access, await fetchAll((f, t) => db.from("interaction").select(`id, occurred_at, channel, subject, promises, ${VIS}`)
    .eq("workspace_id", workspaceId).is("archived_at", null).gte("occurred_at", since).not("promises", "is", null)
    .order("id").range(f, t), { cap: 10_000 }), "interaction") as any[]).filter((i) => parsePromises(i.promises).some((p) => p.status === "open" && p.due));
  const links = await linksFor(db, workspaceId, ints.map((i) => i.id));

  // post-visit feedback (last 30 days of visits)
  let fb: any[] = [];
  try {
    fb = mineOnly(filt(access, (await db.from("visit_feedback").select(`id, meeting_visit_id, concerns, dealbreakers, next_step, follow_up_due, client_rating, created_at, ${VIS}`)
      .eq("workspace_id", workspaceId).is("archived_at", null).gte("created_at", addDays(today, -30) + "T00:00:00Z").limit(500)).data, "visit_feedback"));
  } catch { fb = []; }
  const mvIds = [...new Set(fb.map((f) => f.meeting_visit_id))];
  const mvs = new Map<string, any>();
  for (const part of chunk(mvIds)) {
    const { data } = await db.from("meeting_visit").select("id, title, start_at, opportunity_id, linked_entity_type, linked_entity_id").eq("workspace_id", workspaceId).in("id", part);
    for (const m of data ?? []) mvs.set(m.id, m);
  }
  const visitOpps = [...new Set([...mvs.values()].map((m) => m.opportunity_id).filter(Boolean))];

  // won / late-stage deals in the referral window (+ orgs of visit opportunities)
  const opps = mineOnly(filt(access, (await db.from("opportunity").select(`id, name, org_id, requirement_id, outcome, stage, stage_entered_at, ${VIS}`)
    .eq("workspace_id", workspaceId).is("archived_at", null).gte("stage_entered_at", addDays(today, -60) + "T00:00:00Z")
    .or("outcome.eq.won,stage.in.(possession,invoiced,recognised,collected)").limit(500)).data, "opportunity") as any[]);
  const oppOrg = new Map<string, string>();
  for (const part of chunk(visitOpps)) {
    const { data } = await db.from("opportunity").select("id, org_id").eq("workspace_id", workspaceId).in("id", part);
    for (const o of data ?? []) oppOrg.set(o.id, o.org_id);
  }
  // stakeholders of those deals (via the requirement): their opt-outs apply to the deal's referral prompt
  const byReq = new Map<string, string[]>();
  for (const part of chunk([...new Set(opps.map((o) => o.requirement_id).filter(Boolean))] as string[])) {
    const { data } = await db.from("stakeholder").select("requirement_id, person_id").eq("workspace_id", workspaceId).in("requirement_id", part).is("archived_at", null);
    for (const s of data ?? []) if (s.person_id) byReq.set(s.requirement_id, [...(byReq.get(s.requirement_id) ?? []), s.person_id]);
  }
  const stake = new Map<string, string[]>(opps.map((o) => [o.id, o.requirement_id ? byReq.get(o.requirement_id) ?? [] : []]));

  const allOrgIds = [...[...links.values()].flatMap((v) => v.orgs), ...opps.map((o) => o.org_id), ...oppOrg.values(), ...radar.map((r) => r.tenantOrgId).filter((x): x is string => !!x)];
  const names = await orgNameMap(db, workspaceId, allOrgIds);

  const iCtx: InteractionCtx[] = ints.map((i) => {
    const l = links.get(i.id) ?? { persons: [], orgs: [] };
    return { id: i.id, occurredAt: i.occurred_at, subject: i.subject, channel: i.channel, promises: i.promises, ownerUserId: i.owner_user_id, personIds: l.persons, orgIds: l.orgs, orgName: l.orgs.map((o) => names.get(o)).find(Boolean) ?? null };
  });
  const vCtx: VisitFeedbackCtx[] = fb.filter((f) => mvs.has(f.meeting_visit_id)).map((f) => {
    const m = mvs.get(f.meeting_visit_id);
    const orgIds = [m.linked_entity_type === "organisation" ? m.linked_entity_id : null, m.opportunity_id ? oppOrg.get(m.opportunity_id) : null].filter(Boolean) as string[];
    const personIds = m.linked_entity_type === "person" ? [m.linked_entity_id] : [];
    return { id: f.id, meetingVisitId: m.id, meetingTitle: m.title, visitDate: String(m.start_at).slice(0, 10), concerns: f.concerns, dealbreakers: f.dealbreakers, nextStep: f.next_step,
      followUpDue: f.follow_up_due, rating: f.client_rating, ownerUserId: f.owner_user_id, orgIds, personIds };
  });
  const dCtx: WonDealCtx[] = opps.map((o) => ({ id: o.id, name: o.name, orgId: o.org_id, orgName: names.get(o.org_id) ?? null, outcome: o.outcome, stage: o.stage, stageEnteredAt: o.stage_entered_at, ownerUserId: o.owner_user_id }));

  const raw = [
    ...promiseSuggestions(iCtx, today),
    ...visitSuggestions(vCtx, today),
    ...referralSuggestions(dCtx, today).map((s) => ({ ...s, personIds: stake.get(s.link.id) ?? [] })),
    ...renewalSuggestions(radar),
  ];
  const restr = await loadRestrictions(db, workspaceId, raw.flatMap((s) => s.personIds), raw.flatMap((s) => s.orgIds));
  const { kept, withheld } = applyRestrictions(raw, restr);
  return { suggestions: sortSuggestions(kept), withheld };
}

/**
 * Job side (admin client): overdue-promise alerts and post-visit follow-up tasks, deduped by suggestion key.
 * Tasks link to the interaction / meeting visit they came from; nothing is sent and no promise is changed.
 */
export async function runCaretaker(admin: Db, workspaceId: string, today: string, radar: RadarItem[], fallbackOwner: string | null): Promise<{ suggestions: number; withheld: number; tasks: number; alerts: number }> {
  const { suggestions, withheld } = await computeRelationshipSuggestions(admin, workspaceId, today, radar);
  let tasks = 0, alerts = 0;
  const keys = suggestions.filter((s) => s.createTask).map((s) => `brief.${s.key}`);
  const existing = new Set<string>((await rowsByKeys<{ idempotency_key: string }>(admin, "task", workspaceId, "idempotency_key", keys, "idempotency_key")).map((r) => r.idempotency_key));
  for (const s of suggestions) {
    const owner = s.ownerUserId ?? fallbackOwner;
    if (s.createTask && !existing.has(`brief.${s.key}`)) {
      await createTask(admin, workspaceId, {
        title: s.title, description: `${s.why}. Suggested follow-up — you decide and you send (no automatic messages).`,
        dueAt: s.due ? `${s.due}T05:30:00.000Z` : null, priority: s.priority, source: "workflow",
        linkedEntityType: s.link.type, linkedEntityId: s.link.id, idempotencyKey: `brief.${s.key}`,
        ownerUserId: owner, assignedUserId: owner,
      });
      tasks++;
    }
    if (s.kind === "promise_overdue" && owner) {
      await notify(admin, workspaceId, owner, "promise_overdue", s.key, { title: s.title, reason: s.why, due: s.due, interaction_id: s.link.id, href: s.href });
      alerts++;
    }
  }
  return { suggestions: suggestions.length, withheld: withheld.length, tasks, alerts };
}
