import "server-only";
import type { Db } from "@/lib/supabase/server";
import { warmPaths } from "@/modules/outreach/service";
import * as R from "./rules";

/**
 * Account & contact workspaces. Every query filters workspace_id explicitly and runs through the user's RLS client.
 * Each section loads independently and time-boxed, so one slow/failed source shows "Couldn't load" instead of
 * breaking the page (rule S10).
 */
type Row = Record<string, any>;
export class AccountError extends Error {}

/** Throw on a Supabase error so timeboxed() turns it into a visible failure (never a silent empty list). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function q<T = any[]>(b: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await b;
  if (error) throw new Error(error.message);
  return (data ?? []) as T;
}
const today = () => new Date().toISOString().slice(0, 10);
const MS = 4000;

// ---------------------------------------------------------------- relationship levels
export async function currentLevels(db: Db, ws: string, personIds: string[]): Promise<Map<string, Row>> {
  const m = new Map<string, Row>();
  if (!personIds.length) return m;
  const rows = await q(db.from("contact_relationship_level").select("person_id, level, reason, basis, set_at, set_by_user_id").eq("workspace_id", ws).in("person_id", personIds).is("archived_at", null).order("set_at", { ascending: false }).limit(2000));
  for (const r of rows) if (!m.has(r.person_id)) m.set(r.person_id, r);
  return m;
}
export async function levelHistory(db: Db, ws: string, personId: string) {
  return q(db.from("contact_relationship_level").select("id, level, reason, basis, set_at, set_by_user_id").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null).order("set_at", { ascending: false }).limit(50));
}
/** Manual setter. Append-only: every change is a new row, so history is never overwritten. */
export async function setLevel(db: Db, ws: string, userId: string, personId: string, level: string, reason: string, accepted = false) {
  if (!R.isLevel(level)) throw new AccountError("Choose a relationship level.");
  const person = await q<Row | null>(db.from("person").select("id").eq("workspace_id", ws).eq("id", personId).maybeSingle());
  if (!person) throw new AccountError("Contact not found.");
  const cur = (await currentLevels(db, ws, [personId])).get(personId);
  if (cur?.level === level) return { unchanged: true };
  const { error } = await db.from("contact_relationship_level").insert({ workspace_id: ws, person_id: personId, level, reason: reason.trim() || null, basis: accepted ? "accepted_suggestion" : "manual", set_by_user_id: userId, owner_user_id: userId });
  if (error) throw new AccountError(error.message);
  return { unchanged: false };
}

async function personInteractions(db: Db, ws: string, personIds: string[], limit = 200) {
  if (!personIds.length) return [] as Row[];
  const links = await q(db.from("interaction_link").select("entity_id, interaction:interaction_id(id, occurred_at, channel, direction, subject, summary, promises, objections, opportunity_id, is_meaningful, created_at, updated_at)").eq("workspace_id", ws).eq("entity_type", "person").in("entity_id", personIds).is("archived_at", null).limit(limit));
  return links.filter((l) => l.interaction).map((l) => ({ ...l.interaction, person_id: l.entity_id }));
}

// ---------------------------------------------------------------- what changed
export async function lastViewed(db: Db, ws: string, userId: string, orgId: string): Promise<string | null> {
  const r = await q<Row | null>(db.from("account_view").select("viewed_at").eq("workspace_id", ws).eq("org_id", orgId).eq("user_id", userId).maybeSingle());
  return r?.viewed_at ?? null;
}
/** Record the visit. Viewers lack insert rights under RLS; that just means no baseline is stored for them. */
export async function markViewed(db: Db, ws: string, userId: string, orgId: string) {
  const { error } = await db.from("account_view").upsert({ workspace_id: ws, org_id: orgId, user_id: userId, owner_user_id: userId, viewed_at: new Date().toISOString() }, { onConflict: "workspace_id,org_id,user_id" });
  return !error;
}

// ---------------------------------------------------------------- account workspace
export async function loadAccount(db: Db, ws: string, userId: string, orgId: string) {
  const since = await R.timeboxed(lastViewed(db, ws, userId, orgId), MS);

  const opps = R.timeboxed(q(db.from("opportunity").select("id, name, stage, outcome, temperature, expected_fee, expected_close, next_action, next_action_due, requirement_id, stage_entered_at, created_at, updated_at").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).order("updated_at", { ascending: false }).limit(100)), MS);
  const reqs = R.timeboxed(async () => {
    const rs = await q(db.from("requirement").select("id, title, objective, status, area_min_sf, area_target_sf, area_max_sf, area_basis, seats_target, budget_min, budget_max, budget_basis, decision_date, occupation_date, transaction_kinds, created_at, updated_at").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).order("created_at", { ascending: false }).limit(100));
    const ids = rs.map((r) => r.id);
    const sc = ids.length ? await q(db.from("score_result").select("entity_id, score, band, missing, completeness, previous_score").eq("workspace_id", ws).eq("model_key", "requirement").eq("is_current", true).in("entity_id", ids)) : [];
    return rs.map((r) => ({ ...r, score: sc.find((s) => s.entity_id === r.id) ?? null }));
  }, MS);

  const leases = R.timeboxed(async () => {
    const ls = await q(db.from("lease").select("id, asset_id, space_id, tenant_name_raw, area_sf, area_basis, start_date, contractual_expiry, lockin_months_raw, tenure_months_raw, status, fact_status, registration_ref, source_object_id, amends_lease_id, created_at, updated_at, asset:asset_id(id, name), space:space_id(floor_text, unit, carpet_sf, chargeable_sf, seats)").eq("workspace_id", ws).eq("tenant_org_id", orgId).is("archived_at", null).order("contractual_expiry", { ascending: false, nullsFirst: false }).limit(200));
    const ids = ls.map((l) => l.id);
    const ev = ids.length ? await q(db.from("lease_event").select("lease_id, event_type, event_date, date_basis, notice_days, confirmed, needs_review").eq("workspace_id", ws).in("lease_id", ids).is("archived_at", null).order("event_date").limit(1000)) : [];
    const t = today();
    return ls.map((l) => ({ ...l, events: ev.filter((e) => e.lease_id === l.id), historical: (l.contractual_expiry && l.contractual_expiry < t) || (l.status && !["active", "unknown"].includes(l.status)) }));
  }, MS);

  const signals = R.timeboxed(async () => {
    const ss = await q(db.from("signal").select("id, category, kind, title, summary, event_date, verification, confidence, status, priority_band, recommended_action, missing_info, latest_evidence_on, created_at, updated_at").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).order("detected_at", { ascending: false }).limit(100));
    const ids = ss.map((s) => s.id);
    const ev = ids.length ? await q(db.from("signal_evidence").select("signal_id, role, source_name, source_url, excerpt, evidence_tier, fact_status, published_on").eq("workspace_id", ws).in("signal_id", ids).is("archived_at", null).limit(1000)) : [];
    return ss.map((s) => ({ ...s, support: ev.filter((e) => e.signal_id === s.id && e.role !== "counter"), counter: ev.filter((e) => e.signal_id === s.id && e.role === "counter") }));
  }, MS);

  const people = R.timeboxed(async () => {
    const emps = await q(db.from("employment").select("id, person_id, title, function, seniority, is_current, end_date, start_date, fact_status, person:person_id(id, full_name, do_not_contact)").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).limit(500));
    const pids = [...new Set(emps.map((e) => e.person_id))];
    if (!pids.length) return { emps, groups: [] as R.StakeGroup[], levels: new Map<string, Row>(), past: [] as Row[] };
    const [ra, cm, st, lv] = await Promise.all([
      q(db.from("contact_role_assessment").select("person_id, role_class, department, cre_relevance").eq("workspace_id", ws).in("person_id", pids).eq("active", true)),
      q(db.from("contact_method").select("person_id, method_type, verified_on, verify_status, suppressed").eq("workspace_id", ws).in("person_id", pids).is("archived_at", null)),
      q(db.from("stakeholder").select("person_id, role, requirement:requirement_id(org_id)").eq("workspace_id", ws).in("person_id", pids).is("archived_at", null)),
      currentLevels(db, ws, pids),
    ]);
    const list: R.StakePerson[] = emps.map((e) => {
      const a = ra.find((r) => r.person_id === e.person_id);
      return {
        personId: e.person_id, name: e.person?.full_name ?? "Contact", title: e.title, department: a?.department ?? e.function ?? null, roleClass: a?.role_class ?? null,
        stakeholderRoles: st.filter((s) => s.person_id === e.person_id && s.requirement?.org_id === orgId).map((s) => s.role),
        level: (lv.get(e.person_id)?.level as R.Level) ?? null, channel: R.bestChannel(cm.filter((m) => m.person_id === e.person_id)), current: !!e.is_current && !e.end_date,
      };
    });
    const groups = R.groupStakeholders(list);
    const past = emps.filter((e) => !(e.is_current && !e.end_date));
    return { emps, groups, levels: lv, past };
  }, MS);

  const peopleIds = async () => { const p = await people; return p.ok ? [...new Set(p.data.emps.filter((e) => e.is_current).map((e) => e.person_id))] : []; };

  const warm = R.timeboxed(async () => {
    const p = await people; if (!p.ok) throw new Error(p.error);
    const top = p.data.groups.flatMap((g) => g.people).filter((x) => x.influence === "decides" || x.influence === "approves").slice(0, 4);
    const res = await Promise.all(top.map(async (t) => ({ target: t, paths: (await warmPaths(db, ws, userId, t.personId)).slice(0, 2) })));
    return res.filter((r) => r.paths.length);
  }, MS);

  const timeline = R.timeboxed(async () => {
    const orgLinks = await q(db.from("interaction_link").select("interaction:interaction_id(id, occurred_at, channel, direction, subject, summary, promises, objections, opportunity_id, created_at, updated_at)").eq("workspace_id", ws).eq("entity_type", "organisation").eq("entity_id", orgId).is("archived_at", null).limit(300));
    const pi = await personInteractions(db, ws, await peopleIds(), 300);
    const by = new Map<string, Row>();
    for (const i of [...orgLinks.map((l) => l.interaction).filter(Boolean), ...pi]) if (!by.has(i.id)) by.set(i.id, i);
    const outreach = await q(db.from("outreach_item").select("id, channel, status, scenario, step, planned_on, sent_at, responded_at, response, person:person_id(full_name), created_at, updated_at").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).order("created_at", { ascending: false }).limit(100));
    return { interactions: [...by.values()].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))), outreach };
  }, MS);

  const meetings = R.timeboxed(async () => {
    const o = await opps; const oppIds = o.ok ? o.data.map((x) => x.id) : [];
    const a = await q(db.from("meeting_visit").select("id, title, start_at, kind, status, location, opportunity_id").eq("workspace_id", ws).eq("linked_entity_type", "organisation").eq("linked_entity_id", orgId).is("archived_at", null).limit(100));
    const b = oppIds.length ? await q(db.from("meeting_visit").select("id, title, start_at, kind, status, location, opportunity_id").eq("workspace_id", ws).in("opportunity_id", oppIds).is("archived_at", null).limit(100)) : [];
    const m = new Map<string, Row>(); for (const x of [...a, ...b]) m.set(x.id, x);
    return [...m.values()].sort((x, y) => String(y.start_at).localeCompare(String(x.start_at)));
  }, MS);

  const documents = R.timeboxed(async () => {
    const [o, r] = await Promise.all([opps, reqs]);
    const ids: [string, string[]][] = [["organisation", [orgId]], ["opportunity", o.ok ? o.data.map((x) => x.id) : []], ["requirement", r.ok ? r.data.map((x) => x.id) : []]];
    const all = await Promise.all(ids.filter(([, v]) => v.length).map(([t, v]) => q(db.from("document_version").select("id, kind, purpose, status, version_no, linked_entity_type, linked_entity_id, stale_at, created_at").eq("workspace_id", ws).eq("linked_entity_type", t).in("linked_entity_id", v).is("archived_at", null).order("created_at", { ascending: false }).limit(50))));
    return all.flat();
  }, MS);

  const scores = R.timeboxed(async () => {
    const [o, r] = await Promise.all([opps, reqs]);
    const ids = [orgId, ...(o.ok ? o.data.map((x) => x.id) : []), ...(r.ok ? r.data.map((x) => x.id) : [])];
    const rows = await q(db.from("score_result").select("id, model_key, entity_type, entity_id, score, band, confidence, completeness, factors, missing, recommended_action, previous_score, change_reason, is_current, calculated_at, created_at, updated_at").eq("workspace_id", ws).in("entity_id", ids).order("calculated_at", { ascending: false }).limit(300));
    return rows;
  }, MS);

  const tasks = R.timeboxed(q(db.from("task").select("id, title, due_at, status").eq("workspace_id", ws).eq("linked_entity_type", "organisation").eq("linked_entity_id", orgId).in("status", ["open", "in_progress", "snoozed"]).is("archived_at", null).order("due_at", { nullsFirst: false }).limit(50)), MS);

  const txns = R.timeboxed(q(db.from("market_transaction").select("id, deal_type, period_start, area_sf, seats, broker_name_raw, broker:broker_org_id(id, display_name), asset:asset_id(id, name)").eq("workspace_id", ws).eq("tenant_org_id", orgId).is("archived_at", null).order("period_start", { ascending: false, nullsFirst: false }).limit(50)), MS);

  const [O, Q, L, S, P, W, T, M, D, SC, TK, TX] = await Promise.all([opps, reqs, leases, signals, people, warm, timeline, meetings, documents, scores, tasks, txns]);

  // What changed since last visit — computed before we stamp this visit.
  const viewedAt = since.ok ? since.data : null;
  const changes = R.diffSince(viewedAt, {
    signal: S.ok ? S.data.map((s) => ({ id: s.id, label: s.title, created_at: s.created_at, updated_at: s.updated_at })) : [],
    score: SC.ok ? SC.data.filter((s) => s.is_current).map((s) => ({ id: s.id, label: `${MODEL_LABEL[s.model_key] ?? s.model_key} ${s.score}${s.previous_score != null ? ` (was ${s.previous_score})` : ""}`, created_at: s.created_at })) : [],
    interaction: T.ok ? T.data.interactions.map((i) => ({ id: i.id, label: `${i.channel}: ${i.subject ?? "(no subject)"}`, created_at: i.created_at, updated_at: i.updated_at })) : [],
    requirement: Q.ok ? Q.data.map((r) => ({ id: r.id, label: r.title, created_at: r.created_at, updated_at: r.updated_at })) : [],
    lease: L.ok ? L.data.map((l) => ({ id: l.id, label: `${l.asset?.name ?? l.tenant_name_raw ?? "Lease"}`, created_at: l.created_at, updated_at: l.updated_at })) : [],
  });
  await markViewed(db, ws, userId, orgId);

  const actions = R.nextActions({
    orgId,
    openOppsWithAction: O.ok ? O.data.filter((o) => !o.outcome) : [],
    requirements: Q.ok ? Q.data.filter((r) => !["closed", "lost", "won", "cancelled"].includes(r.status)).map((r) => ({ id: r.id, title: r.title, missing: r.score?.missing ?? [] })) : [],
    leaseEvents: L.ok ? L.data.flatMap((l) => l.events) : [],
    peopleCount: P.ok ? P.data.groups.reduce((a, g) => a + g.people.length, 0) : 1,
    hasDecider: P.ok ? P.data.groups.some((g) => g.people.some((p) => p.influence === "decides")) : true,
    lastInteractionAt: T.ok ? T.data.interactions[0]?.occurred_at ?? null : "unknown",
    unverifiedSignals: S.ok ? S.data.filter((s) => s.verification !== "fact" && s.status !== "dismissed").length : 0,
    today: today(),
  }).filter((a) => !(a.key === "first-touch" && !T.ok) && !(a.key === "stale" && !T.ok));

  return { viewedAt, sinceOk: since.ok, changes, opps: O, reqs: Q, leases: L, signals: S, people: P, warm: W, timeline: T, meetings: M, documents: D, scores: SC, tasks: TK, transactions: TX, actions };
}
export type Account = Awaited<ReturnType<typeof loadAccount>>;

export const MODEL_LABEL: Record<string, string> = {
  lead: "Lead priority", requirement: "Requirement readiness", opportunity: "Deal health", relationship: "Relationship strength", company: "Company attractiveness", contact: "Contact relevance",
};

// ---------------------------------------------------------------- contact workspace extras
export async function loadContactExtras(db: Db, ws: string, personId: string) {
  const [ints, levels, hist, ra, outreach, memories, stake] = await Promise.all([
    R.timeboxed(personInteractions(db, ws, [personId]), MS),
    R.timeboxed(currentLevels(db, ws, [personId]), MS),
    R.timeboxed(levelHistory(db, ws, personId), MS),
    R.timeboxed(q(db.from("contact_role_assessment").select("role_class, department, cre_relevance, reason, source").eq("workspace_id", ws).eq("person_id", personId).eq("active", true).limit(1)), MS),
    R.timeboxed(q(db.from("outreach_item").select("id, channel, status, scenario, step, planned_on, sent_at, responded_at, org:org_id(display_name)").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null).order("created_at", { ascending: false }).limit(30)), MS),
    R.timeboxed(q(db.from("assistant_memory").select("id").eq("workspace_id", ws).eq("entity_type", "person").eq("entity_id", personId).is("archived_at", null).limit(200)), MS),
    R.timeboxed(q(db.from("stakeholder").select("requirement:requirement_id(id, title, org_id)").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null)), MS),
  ]);
  const meetings = await R.timeboxed(async () => {
    const a = await q(db.from("meeting_visit").select("id, title, start_at, kind, status, location").eq("workspace_id", ws).eq("linked_entity_type", "person").eq("linked_entity_id", personId).is("archived_at", null).limit(50));
    const fromInts = ints.ok ? ints.data.filter((i) => i.channel === "meeting" || i.channel === "visit").map((i) => ({ id: i.id, title: i.subject ?? "Meeting", start_at: i.occurred_at, kind: i.channel, status: "logged", location: null })) : [];
    return [...a, ...fromInts].sort((x, y) => String(y.start_at).localeCompare(String(x.start_at)));
  }, MS);
  const opps = await R.timeboxed(async () => {
    const ids = stake.ok ? stake.data.map((s) => s.requirement?.id).filter(Boolean) : [];
    return ids.length ? q(db.from("opportunity").select("id, name, stage, org_id").eq("workspace_id", ws).in("requirement_id", ids).is("archived_at", null).limit(50)) : [];
  }, MS);
  const methods = await R.timeboxed(q(db.from("contact_method").select("id, verify_status").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null)), MS);
  const methodStatus = new Map<string, string | null>(methods.ok ? methods.data.map((m: Row) => [m.id, m.verify_status]) : []);
  const suggestion = ints.ok ? R.suggestLevel(ints.data) : null;
  const commitments = ints.ok ? ints.data.flatMap((i) => ((i.promises ?? []) as unknown[]).map((p) => ({ at: i.occurred_at as string, text: typeof p === "string" ? p : String((p as Row).what ?? (p as Row).text ?? JSON.stringify(p)) }))) : [];
  return { ints, current: levels.ok ? levels.data.get(personId) ?? null : null, levelOk: levels.ok, hist, ra, outreach, memories, meetings, opps, stake, suggestion, commitments, methodStatus };
}
