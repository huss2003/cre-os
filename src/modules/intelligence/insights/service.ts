import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { isoDate } from "../common";
import { stageIndex } from "../network/graph";
import {
  cohortFunnel, stageConversion, timeToStage, lostReasons, landlordConcentration, portfolioView, procurementMap, experimentSummary,
  TARGETS, type Touch, type OppLite, type StageEvent, type LeaseLite, type ExperimentLite,
} from "./metrics";

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

async function all<T = Row>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await p;
  if (error) throw error;
  return (data ?? []) as T[];
}

async function namesOf(db: Db, workspaceId: string, table: "organisation" | "asset", ids: string[]) {
  const m = new Map<string, string>();
  const u = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < u.length; i += 100) {
    const col = table === "organisation" ? "display_name" : "name";
    for (const r of await all<Row>(db.from(table).select(`id, ${col}`).eq("workspace_id", workspaceId).in("id", u.slice(i, i + 100)))) m.set(String(r.id), String(r[col]));
  }
  return m;
}

export async function funnelData(db: Db, workspaceId: string, since: string) {
  const [ints, opps, events, draftsCount] = await Promise.all([
    all<Row>(db.from("interaction").select("id, occurred_at, direction, opportunity_id").eq("workspace_id", workspaceId).is("archived_at", null).gte("occurred_at", since).limit(10000)),
    all<Row>(db.from("opportunity").select("id, org_id, stage, outcome, outcome_reason, created_at, stage_entered_at").eq("workspace_id", workspaceId).is("archived_at", null).limit(5000)),
    all<Row>(db.from("opportunity_stage_history").select("opportunity_id, to_stage, changed_at").eq("workspace_id", workspaceId).limit(20000)),
    db.from("draft").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).gte("created_at", since),
  ]);
  const ids = ints.map((i) => String(i.id));
  const links: Row[] = [];
  for (let i = 0; i < ids.length; i += 100) links.push(...await all<Row>(db.from("interaction_link").select("interaction_id, entity_type, entity_id").eq("workspace_id", workspaceId).in("interaction_id", ids.slice(i, i + 100)).in("entity_type", ["organisation", "person"])));
  const oppOrg = new Map(opps.map((o) => [String(o.id), String(o.org_id)]));
  const touches: Touch[] = [];
  for (const it of ints) {
    const mine = links.filter((l) => l.interaction_id === it.id);
    const orgs = new Set(mine.filter((l) => l.entity_type === "organisation").map((l) => String(l.entity_id)));
    if (it.opportunity_id && oppOrg.has(String(it.opportunity_id))) orgs.add(oppOrg.get(String(it.opportunity_id))!);
    const person = mine.find((l) => l.entity_type === "person");
    for (const org of orgs) touches.push({ org_id: org, person_id: person ? String(person.entity_id) : null, occurred_at: String(it.occurred_at), direction: it.direction as string | null, kind: "interaction" });
  }
  const oppLite: OppLite[] = opps.map((o) => ({ id: String(o.id), org_id: String(o.org_id), stage: String(o.stage), outcome: String(o.outcome), outcome_reason: o.outcome_reason as string | null, created_at: String(o.created_at), stage_entered_at: o.stage_entered_at as string | null }));
  const ev: StageEvent[] = events.map((e) => ({ opportunity_id: String(e.opportunity_id), to_stage: String(e.to_stage), changed_at: String(e.changed_at) }));
  return {
    cohorts: cohortFunnel(touches, oppLite, ev), conversion: stageConversion(oppLite, ev), timeToStage: timeToStage(oppLite, ev), lost: lostReasons(oppLite),
    draftsExcluded: draftsCount.count ?? 0, unlinkedInteractions: ints.filter((it) => !links.some((l) => l.interaction_id === it.id && l.entity_type === "organisation") && !it.opportunity_id).length,
    targets: TARGETS, opps: oppLite,
  };
}

export async function leaseData(db: Db, workspaceId: string, today: string) {
  const leases = await all<Row>(db.from("lease").select("id, tenant_org_id, tenant_name_raw, landlord_org_id, asset_id, area_sf, contractual_expiry, status").eq("workspace_id", workspaceId).is("archived_at", null).limit(5000));
  const ids = leases.map((l) => String(l.id));
  const events: Row[] = [];
  for (let i = 0; i < ids.length; i += 100) events.push(...await all<Row>(db.from("lease_event").select("lease_id, event_type, event_date, confirmed").eq("workspace_id", workspaceId).in("lease_id", ids.slice(i, i + 100)).is("archived_at", null)));
  const orgNames = await namesOf(db, workspaceId, "organisation", leases.flatMap((l) => [l.tenant_org_id as string, l.landlord_org_id as string]));
  const assetNames = await namesOf(db, workspaceId, "asset", leases.map((l) => l.asset_id as string));
  const lite: LeaseLite[] = leases.map((l) => ({
    id: String(l.id), tenant_org_id: l.tenant_org_id as string | null, tenant: l.tenant_org_id ? orgNames.get(String(l.tenant_org_id)) ?? null : (l.tenant_name_raw as string | null),
    landlord: l.landlord_org_id ? orgNames.get(String(l.landlord_org_id)) ?? null : null, building: l.asset_id ? assetNames.get(String(l.asset_id)) ?? null : null,
    area_sf: num(l.area_sf), contractual_expiry: l.contractual_expiry as string | null,
    events: events.filter((e) => e.lease_id === l.id).map((e) => ({ event_type: String(e.event_type), event_date: e.event_date as string | null, confirmed: !!e.confirmed })),
  }));
  const to = `${Number(today.slice(0, 4)) + 3}${today.slice(4)}`;
  return { concentration: landlordConcentration(lite, today, to).slice(0, 25), portfolio: portfolioView(lite, today).filter((p) => p.sites >= 1).slice(0, 25), leaseCount: lite.length };
}

export async function freshness(db: Db, workspaceId: string, today: string) {
  const [claims, expiredClaims, avail, expiredAvail, dossiers, overdue, findings] = await Promise.all([
    db.from("signal_claim").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).is("archived_at", null),
    db.from("signal_claim").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).is("archived_at", null).lt("expires_on", today),
    db.from("availability").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "available").is("archived_at", null),
    db.from("availability").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "available").is("archived_at", null).lt("valid_until", today),
    db.from("research_dossier").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("is_current", true),
    db.from("research_dossier").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("is_current", true).lt("next_refresh_at", new Date().toISOString()),
    db.from("evidence_finding").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "open"),
  ]);
  return [
    { label: "Evidence claims expired", stale: expiredClaims.count ?? 0, total: claims.count ?? 0 },
    { label: "Availability snapshots past validity", stale: expiredAvail.count ?? 0, total: avail.count ?? 0 },
    { label: "Dossiers overdue for refresh", stale: overdue.count ?? 0, total: dossiers.count ?? 0 },
    { label: "Open patrol findings", stale: findings.count ?? 0, total: null as number | null },
  ];
}

export async function procurementData(db: Db, workspaceId: string, opps: OppLite[]) {
  const late = opps.filter((o) => o.outcome === "open" && stageIndex(o.stage) >= stageIndex("requirement_confirmed"));
  if (!late.length) return [];
  const full = await all<Row>(db.from("opportunity").select("id, name, stage, requirement_id").eq("workspace_id", workspaceId).in("id", late.map((o) => o.id)));
  const reqIds = full.map((o) => o.requirement_id).filter(Boolean) as string[];
  const [reqs, sh] = await Promise.all([
    reqIds.length ? all<Row>(db.from("requirement").select("id, decision_date, constraints").eq("workspace_id", workspaceId).in("id", reqIds)) : Promise.resolve([] as Row[]),
    reqIds.length ? all<Row>(db.from("stakeholder").select("requirement_id, role").eq("workspace_id", workspaceId).in("requirement_id", reqIds).is("archived_at", null)) : Promise.resolve([] as Row[]),
  ]);
  return full.map((o) => {
    const r = reqs.find((x) => x.id === o.requirement_id);
    return procurementMap({ id: String(o.id), name: String(o.name), stage: String(o.stage) }, r ? { decision_date: r.decision_date as string | null, constraints: (r.constraints ?? null) as Record<string, unknown> | null } : null, sh.filter((s) => s.requirement_id === o.requirement_id).map((s) => String(s.role)));
  });
}

export async function experimentsData(db: Db, workspaceId: string, now = new Date()) {
  const ex = await all<Row>(db.from("experiment").select("*").eq("workspace_id", workspaceId).is("archived_at", null).order("created_at", { ascending: false }).limit(20));
  if (!ex.length) return [];
  const subs = await all<Row>(db.from("experiment_subject").select("experiment_id, variant_key, exposed_at, outcome_at").eq("workspace_id", workspaceId).in("experiment_id", ex.map((e) => String(e.id))));
  return ex.map((e) => ({ experiment: e, summary: experimentSummary(e as unknown as ExperimentLite, subs.filter((s) => s.experiment_id === e.id) as never, now) }));
}

/** Everything /insights shows. Descriptive only. */
export async function insightsOverview(db: Db, workspaceId: string, now = new Date()) {
  const today = isoDate(now)!;
  const since = new Date(now.getTime() - 400 * 86_400_000).toISOString();
  const funnel = await funnelData(db, workspaceId, since);
  const [leases, fresh, procurement, experiments, playbook] = await Promise.all([
    leaseData(db, workspaceId, today), freshness(db, workspaceId, today), procurementData(db, workspaceId, funnel.opps), experimentsData(db, workspaceId, now),
    all<Row>(db.from("playbook_item").select("id, kind, prompt_text, response_text, persona, stage, tags, source_rights").eq("workspace_id", workspaceId).is("archived_at", null).order("created_at", { ascending: false }).limit(30)),
  ]);
  const openOpps = funnel.opps.filter((o) => o.outcome === "open");
  return { today, funnel, leases, freshness: fresh, procurement, experiments, playbook, openOpps };
}

// ------------------------------------------------------------------ knowledge capture & experiments (writes)
export const PlaybookInput = z.object({
  kind: z.enum(["question", "objection", "answer", "talk_track"]),
  prompt: z.string().min(3).max(2000),
  response: z.string().max(4000).optional().nullable(),
  persona: z.string().max(80).optional().nullable(),
  stage: z.string().max(40).optional().nullable(),
  tags: z.array(z.string().max(40)).max(10).default([]),
  sourceRights: z.enum(["own_experience", "client_permitted", "public_source", "internal_only"]),
  anonymised: z.literal(true, { message: "Confirm the item is anonymised (no client, person or price details)." }),
});

export async function addPlaybookItem(db: Db, workspaceId: string, raw: z.input<typeof PlaybookInput>, userId: string) {
  const i = PlaybookInput.parse(raw);
  const { data, error } = await db.from("playbook_item").insert({
    workspace_id: workspaceId, kind: i.kind, prompt_text: i.prompt, response_text: i.response ?? null, persona: i.persona ?? null, stage: i.stage ?? null,
    tags: i.tags, source_rights: i.sourceRights, anonymised: true, owner_user_id: userId,
  }).select().single();
  if (error) throw error;
  return data;
}

export const ExperimentInput = z.object({
  name: z.string().min(2).max(160),
  hypothesis: z.string().min(5).max(1000),
  dimension: z.enum(["trigger", "persona", "channel", "message", "cohort"]),
  variants: z.array(z.object({ key: z.string().min(1).max(30), label: z.string().min(1).max(80) })).min(2).max(6),
  outcomeMetric: z.string().max(60).default("qualified_discussion"),
  outcomeWindowDays: z.number().int().min(1).max(365),
  minSamplePerVariant: z.number().int().min(1).max(10000).default(30),
});

export async function createExperiment(db: Db, workspaceId: string, raw: z.input<typeof ExperimentInput>, userId: string) {
  const i = ExperimentInput.parse(raw);
  const { data, error } = await db.from("experiment").insert({
    workspace_id: workspaceId, name: i.name, hypothesis: i.hypothesis, dimension: i.dimension, variants: i.variants, outcome_metric: i.outcomeMetric,
    outcome_window_days: i.outcomeWindowDays, min_sample_per_variant: i.minSamplePerVariant, status: "design", owner_user_id: userId,
  }).select().single();
  if (error) throw error;
  return data;
}
