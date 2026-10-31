import "server-only";
import type { Db } from "@/lib/supabase/server";
import { isoDate } from "../common";
import { objectionTexts } from "../research/dossier";
import { strategize, type DealContext, type StrategyOutput } from "./strategist";

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export async function loadDealContext(db: Db, workspaceId: string, opportunityId: string): Promise<DealContext> {
  const { data: opp, error } = await db.from("opportunity")
    .select("id, name, stage, outcome, stage_entered_at, temperature, mandate_status, expected_close, next_action, next_action_due, risks, requirement_id, org_id")
    .eq("workspace_id", workspaceId).eq("id", opportunityId).maybeSingle();
  if (error) throw error;
  if (!opp) throw new Error("opportunity not found or not visible");
  const reqId = opp.requirement_id as string | null;
  const [reqRes, shRes, quoteRes, intRes, leaseRes, finRes] = await Promise.all([
    reqId ? db.from("requirement").select("decision_date, occupation_date, area_target_sf, area_min_sf, area_max_sf, budget_min, budget_max, constraints, status").eq("workspace_id", workspaceId).eq("id", reqId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    reqId ? db.from("stakeholder").select("person_id, role").eq("workspace_id", workspaceId).eq("requirement_id", reqId).is("archived_at", null) : Promise.resolve({ data: [], error: null }),
    reqId ? db.from("quote").select("id, valid_until, superseded_by").eq("workspace_id", workspaceId).eq("requirement_id", reqId).is("archived_at", null) : Promise.resolve({ data: [], error: null }),
    db.from("interaction").select("occurred_at, objections").eq("workspace_id", workspaceId).eq("opportunity_id", opportunityId).is("archived_at", null).order("occurred_at", { ascending: false }).limit(50),
    db.from("lease").select("contractual_expiry, status").eq("workspace_id", workspaceId).eq("tenant_org_id", String(opp.org_id)).is("archived_at", null),
    reqId ? db.from("finance_scenario").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("requirement_id", reqId).is("archived_at", null) : Promise.resolve({ count: 0, error: null }),
  ]);
  const sh = (shRes.data ?? []) as Row[];
  const personIds = [...new Set(sh.map((s) => String(s.person_id)))];
  const emps = personIds.length ? ((await db.from("employment").select("person_id, org_id, is_current").eq("workspace_id", workspaceId).in("person_id", personIds)).data ?? []) as Row[] : [];
  const ints = (intRes.data ?? []) as Row[];
  const leases = ((leaseRes.data ?? []) as Row[]).filter((l) => l.contractual_expiry).map((l) => String(l.contractual_expiry)).sort();
  const today = isoDate(new Date())!;
  const r = reqRes.data as Row | null;
  return {
    opportunity: {
      id: String(opp.id), name: String(opp.name), stage: String(opp.stage), outcome: String(opp.outcome), stage_entered_at: opp.stage_entered_at as string | null,
      temperature: opp.temperature as string | null, mandate_status: opp.mandate_status as string | null, expected_close: opp.expected_close as string | null,
      next_action: opp.next_action as string | null, next_action_due: opp.next_action_due as string | null, risks: opp.risks as string | null,
    },
    requirement: r ? {
      decision_date: r.decision_date as string | null, occupation_date: r.occupation_date as string | null, area_target_sf: num(r.area_target_sf), area_min_sf: num(r.area_min_sf), area_max_sf: num(r.area_max_sf),
      budget_min: num(r.budget_min), budget_max: num(r.budget_max), constraints: (r.constraints ?? null) as Record<string, unknown> | null, status: r.status as string | null,
    } : null,
    stakeholders: sh.map((s) => {
      const atOrg = emps.filter((e) => e.person_id === s.person_id && e.org_id === opp.org_id);
      return { person_id: String(s.person_id), role: String(s.role), employment_current: atOrg.length ? atOrg.some((e) => e.is_current === true) : null };
    }),
    quotes: ((quoteRes.data ?? []) as Row[]).map((q) => ({ id: String(q.id), valid_until: q.valid_until as string | null, superseded: !!q.superseded_by })),
    lastInteractionAt: ints[0] ? String(ints[0].occurred_at) : null,
    objections: ints.flatMap((i) => objectionTexts(i.objections)).slice(0, 10),
    currentLeaseExpiry: leases.find((d) => d >= today) ?? leases[leases.length - 1] ?? null,
    financeScenarioCount: finRes.error ? 0 : finRes.count ?? 0,
  };
}

export async function strategyFor(db: Db, workspaceId: string, opportunityId: string, now = new Date()): Promise<StrategyOutput & { context: DealContext }> {
  const context = await loadDealContext(db, workspaceId, opportunityId);
  return { ...strategize(context, isoDate(now)!), context };
}

/**
 * Save a snapshot of the strategist output to negotiation_log (one row per kind) and seed the concession ladder once.
 * Idempotent per opportunity per day (re-running the same day updates nothing new).
 */
export async function saveStrategySnapshot(db: Db, workspaceId: string, opportunityId: string, userId: string, now = new Date()) {
  const s = await strategyFor(db, workspaceId, opportunityId, now);
  const day = isoDate(now)!;
  const { data: existing } = await db.from("negotiation_log").select("id, kind, content").eq("workspace_id", workspaceId).eq("opportunity_id", opportunityId).gte("created_at", `${day}T00:00:00Z`);
  const have = new Set(((existing ?? []) as Row[]).map((e) => String(e.kind)));
  const rows = ([
    ["health_check", { health: s.health }],
    ["stakeholder_gaps", { gaps: s.gaps }],
    ["batna_questions", { questions: s.batna_questions }],
    ["risks", { risks: s.risks }],
  ] as const).filter(([k]) => !have.has(k)).map(([kind, content]) => ({ workspace_id: workspaceId, opportunity_id: opportunityId, kind, content: { ...content, as_of: day }, generated_by: "rule", owner_user_id: userId }));
  if (rows.length) { const { error } = await db.from("negotiation_log").insert(rows); if (error) throw error; }
  const { count } = await db.from("concession_item").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("opportunity_id", opportunityId);
  if (!count) {
    const { error } = await db.from("concession_item").insert(s.concession_ladder.map((c) => ({ workspace_id: workspaceId, opportunity_id: opportunityId, rank: c.rank, party: c.party, item: c.item, ask: c.ask, give: c.give, value_basis: c.value_basis, owner_user_id: userId })));
    if (error) throw error;
  }
  return { saved: rows.length, strategy: s };
}

export async function addNegotiationNote(db: Db, workspaceId: string, opportunityId: string, note: string, userId: string) {
  const { data, error } = await db.from("negotiation_log").insert({ workspace_id: workspaceId, opportunity_id: opportunityId, kind: "note", content: { text: note.slice(0, 4000) }, generated_by: "user", owner_user_id: userId }).select().single();
  if (error) throw error;
  return data;
}

export async function setConcessionStatus(db: Db, workspaceId: string, id: string, status: "proposed" | "offered" | "accepted" | "rejected" | "withdrawn", expectedVersion?: number) {
  let q = db.from("concession_item").update({ status }).eq("workspace_id", workspaceId).eq("id", id);
  if (expectedVersion !== undefined) q = q.eq("row_version", expectedVersion);
  const { data, error } = await q.select();
  if (error) throw error;
  if (!data?.length) throw new Error("conflict_or_not_found");
  return data[0];
}

export async function negotiationHistory(db: Db, workspaceId: string, opportunityId: string) {
  const [log, items] = await Promise.all([
    db.from("negotiation_log").select("id, kind, content, generated_by, created_at").eq("workspace_id", workspaceId).eq("opportunity_id", opportunityId).order("created_at", { ascending: false }).limit(50),
    db.from("concession_item").select("id, rank, party, item, ask, give, value_basis, status, row_version").eq("workspace_id", workspaceId).eq("opportunity_id", opportunityId).is("archived_at", null).order("rank"),
  ]);
  return { log: (log.data ?? []) as Row[], concessions: (items.data ?? []) as Row[] };
}
