import "server-only";
import type { Db } from "@/lib/supabase/server";
import { stableHash } from "@/lib/util/crypto";
import { isoDate } from "../common";
import { objectionTexts } from "../research/dossier";
import { strategize, currentQuote, type DealContext, type StrategyOutput, type ObjectionFact, type QuoteFact, type AvailabilityFact } from "./strategist";

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export async function loadDealContext(db: Db, workspaceId: string, opportunityId: string): Promise<DealContext> {
  const { data: opp, error } = await db.from("opportunity")
    .select("id, name, stage, outcome, stage_entered_at, temperature, mandate_status, expected_close, next_action, next_action_due, risks, requirement_id, org_id")
    .eq("workspace_id", workspaceId).eq("id", opportunityId).maybeSingle();
  if (error) throw error;
  if (!opp) throw new Error("opportunity not found or not visible");
  const reqId = opp.requirement_id as string | null;
  const none = Promise.resolve({ data: [] as Row[], error: null });
  const [reqRes, shRes, quoteRes, intRes, leaseRes, finRes, objRes, histRes, optRes, claimRes] = await Promise.all([
    reqId ? db.from("requirement").select("id, decision_date, occupation_date, area_target_sf, area_min_sf, area_max_sf, budget_min, budget_max, constraints, status, confirmed_at").eq("workspace_id", workspaceId).eq("id", reqId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    reqId ? db.from("stakeholder").select("id, person_id, role, employment_id").eq("workspace_id", workspaceId).eq("requirement_id", reqId).is("archived_at", null) : none,
    reqId ? db.from("quote").select("id, version, valid_until, superseded_by, created_at, terms_json, evidence, approved_at, space_id").eq("workspace_id", workspaceId).eq("requirement_id", reqId).is("archived_at", null) : none,
    db.from("interaction").select("id, occurred_at, objections").eq("workspace_id", workspaceId).eq("opportunity_id", opportunityId).is("archived_at", null).order("occurred_at", { ascending: false }).limit(50),
    db.from("lease").select("id, contractual_expiry, status").eq("workspace_id", workspaceId).eq("tenant_org_id", String(opp.org_id)).is("archived_at", null),
    reqId ? db.from("finance_scenario").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("requirement_id", reqId).is("archived_at", null) : Promise.resolve({ count: 0, error: null }),
    // deals' objection log (written by logObjection) — by opportunity, or by the requirement when not tied to an opportunity
    reqId
      ? db.from("objection_log").select("id, opportunity_id, requirement_id, category, objection, outcome, raised_on").eq("workspace_id", workspaceId).or(`opportunity_id.eq.${opportunityId},and(opportunity_id.is.null,requirement_id.eq.${reqId})`).is("archived_at", null).order("raised_on", { ascending: false }).limit(50)
      : db.from("objection_log").select("id, opportunity_id, requirement_id, category, objection, outcome, raised_on").eq("workspace_id", workspaceId).eq("opportunity_id", opportunityId).is("archived_at", null).order("raised_on", { ascending: false }).limit(50),
    db.from("opportunity_stage_history").select("id, to_stage, changed_at").eq("workspace_id", workspaceId).eq("opportunity_id", opportunityId).order("changed_at", { ascending: false }).limit(1),
    reqId ? db.from("shortlist_option").select("id, availability_id, space_id, asset_id, option_status").eq("workspace_id", workspaceId).eq("requirement_id", reqId).in("option_status", ["proposed", "shortlisted", "visited", "selected"]).is("archived_at", null).limit(50) : none,
    db.from("signal_claim").select("id, claim_type, predicate, source_url, evidence_excerpt, source_object_id").eq("workspace_id", workspaceId).eq("subject_type", "organisation").eq("subject_id", String(opp.org_id)).is("archived_at", null).is("source_url", null).is("evidence_excerpt", null).is("source_object_id", null).limit(20),
  ]);
  const sh = (shRes.data ?? []) as Row[];
  const personIds = [...new Set(sh.map((s) => String(s.person_id)))];
  const [emps, people] = personIds.length ? await Promise.all([
    db.from("employment").select("person_id, org_id, is_current, fact_status").eq("workspace_id", workspaceId).in("person_id", personIds),
    db.from("person").select("id, full_name").eq("workspace_id", workspaceId).in("id", personIds),
  ]) : [{ data: [] }, { data: [] }];
  const empRows = (emps.data ?? []) as Row[];
  const names = new Map(((people.data ?? []) as Row[]).map((p) => [String(p.id), String(p.full_name)]));
  const ints = (intRes.data ?? []) as Row[];
  const leaseRows = ((leaseRes.data ?? []) as Row[]).filter((l) => l.contractual_expiry).sort((a, b) => String(a.contractual_expiry).localeCompare(String(b.contractual_expiry)));
  const today = isoDate(new Date())!;
  const curLease = leaseRows.find((l) => String(l.contractual_expiry) >= today) ?? leaseRows[leaseRows.length - 1] ?? null;
  const r = reqRes.data as Row | null;

  const objections: ObjectionFact[] = [
    ...((objRes.data ?? []) as Row[]).map((o) => ({ id: String(o.id), source: "objection_log" as const, text: String(o.objection), category: (o.category as string | null) ?? null, raised_on: (o.raised_on as string | null) ?? null, outcome: (o.outcome as string | null) ?? "open" })),
    ...ints.flatMap((i) => objectionTexts(i.objections).map((t) => ({ id: String(i.id), source: "interaction" as const, text: t, category: null, raised_on: String(i.occurred_at).slice(0, 10), outcome: "open" }))),
  ].slice(0, 20);

  // shortlisted options -> latest availability snapshot (for the unverified-availability check)
  const opts = (optRes.data ?? []) as Row[];
  let availability: AvailabilityFact[] = [];
  const avIds = opts.map((o) => o.availability_id).filter(Boolean) as string[];
  if (avIds.length) {
    const { data: av } = await db.from("availability").select("id, space_id, as_of, valid_until, status, fact_status").eq("workspace_id", workspaceId).in("id", avIds);
    const spaceIds = [...new Set(((av ?? []) as Row[]).map((a) => String(a.space_id)))];
    const { data: spaces } = spaceIds.length ? await db.from("space").select("id, floor_text, unit, asset:asset_id(name)").eq("workspace_id", workspaceId).in("id", spaceIds) : { data: [] };
    const sname = new Map(((spaces ?? []) as Row[]).map((s) => [String(s.id), [((s.asset ?? {}) as Row).name, s.floor_text, s.unit].filter(Boolean).join(" ") || "space"]));
    availability = ((av ?? []) as Row[]).map((a) => ({ id: String(a.id), label: `Option ${sname.get(String(a.space_id)) ?? "space"}`, as_of: (a.as_of as string | null) ?? null, valid_until: (a.valid_until as string | null) ?? null, status: String(a.status), fact_status: (a.fact_status as string | null) ?? null }));
  }

  const quotes: QuoteFact[] = ((quoteRes.data ?? []) as Row[]).map((q) => ({
    id: String(q.id), version: q.version === null || q.version === undefined ? null : Number(q.version), valid_until: q.valid_until as string | null, superseded: !!q.superseded_by,
    created_at: (q.created_at as string | null) ?? null, terms: (q.terms_json ?? null) as Record<string, unknown> | null, evidence: (q.evidence as string | null) ?? null, approved: !!q.approved_at,
  }));
  const hist = ((histRes.data ?? []) as Row[])[0];
  return {
    opportunity: {
      id: String(opp.id), name: String(opp.name), stage: String(opp.stage), outcome: String(opp.outcome), stage_entered_at: opp.stage_entered_at as string | null,
      temperature: opp.temperature as string | null, mandate_status: opp.mandate_status as string | null, expected_close: opp.expected_close as string | null,
      next_action: opp.next_action as string | null, next_action_due: opp.next_action_due as string | null, risks: opp.risks as string | null,
    },
    requirement: r ? {
      id: String(r.id), decision_date: r.decision_date as string | null, occupation_date: r.occupation_date as string | null, area_target_sf: num(r.area_target_sf), area_min_sf: num(r.area_min_sf), area_max_sf: num(r.area_max_sf),
      budget_min: num(r.budget_min), budget_max: num(r.budget_max), constraints: (r.constraints ?? null) as Record<string, unknown> | null, status: r.status as string | null, confirmed_at: (r.confirmed_at as string | null) ?? null,
    } : null,
    stakeholders: sh.map((s) => {
      const atOrg = empRows.filter((e) => e.person_id === s.person_id && e.org_id === opp.org_id);
      const cur = atOrg.find((e) => e.is_current === true);
      return { id: String(s.id), person_id: String(s.person_id), name: names.get(String(s.person_id)) ?? null, role: String(s.role),
        employment_current: atOrg.length ? !!cur : null, employment_status: (cur?.fact_status as string | undefined) ?? null };
    }),
    quotes,
    lastInteractionAt: ints[0] ? String(ints[0].occurred_at) : null,
    objections,
    currentLeaseExpiry: curLease ? String(curLease.contractual_expiry) : null,
    currentLeaseId: curLease ? String(curLease.id) : null,
    financeScenarioCount: finRes.error ? 0 : finRes.count ?? 0,
    latestStageChange: hist ? { id: String(hist.id), to_stage: String(hist.to_stage), changed_at: String(hist.changed_at) } : null,
    availability,
    unsourcedClaims: ((claimRes.data ?? []) as Row[]).map((c) => ({ id: String(c.id), claim_type: String(c.claim_type), text: String(c.predicate ?? "") })),
  };
}

export async function strategyFor(db: Db, workspaceId: string, opportunityId: string, now = new Date()): Promise<StrategyOutput & { context: DealContext }> {
  const context = await loadDealContext(db, workspaceId, opportunityId);
  return { ...strategize(context, isoDate(now)!), context };
}

/** Deal-fact fingerprint: a snapshot is re-saved only when these recorded facts change (stage, quotes, objections, people). */
export function dealFingerprint(c: DealContext): string {
  return stableHash([
    `stage:${c.opportunity.stage}:${c.opportunity.outcome}`,
    ...c.quotes.map((q) => `q:${q.id}:${q.version ?? ""}:${q.superseded}:${q.valid_until ?? ""}`),
    ...(c.objections as (string | ObjectionFact)[]).map((o) => (typeof o === "string" ? `o:${o}` : `o:${o.source}:${o.id}:${o.outcome ?? ""}:${o.text.length}`)),
    ...c.stakeholders.map((s) => `s:${s.id ?? s.person_id}:${s.role}:${s.employment_current}`),
    `req:${c.requirement?.id ?? ""}:${c.requirement?.status ?? ""}:${c.requirement?.confirmed_at ?? ""}`,
  ].sort());
}

const STEP_STATUSES = ["planned", "offered", "accepted", "rejected", "withdrawn"] as const;
export type ConcessionStatus = (typeof STEP_STATUSES)[number];

/**
 * Save a snapshot of the strategist output to negotiation_log and add any new ladder steps to deals' concession_step
 * (canonical ladder table; status 'planned'; npv_equivalent left to the finance concession-equivalence engine).
 * Idempotent: a kind is re-logged only when the deal fingerprint changed since its last snapshot; existing ladder steps
 * (and the user's statuses on them) are never modified. Suggestion-only: no stage, price or term is changed.
 */
export async function saveStrategySnapshot(db: Db, workspaceId: string, opportunityId: string, userId: string | null, now = new Date()) {
  const s = await strategyFor(db, workspaceId, opportunityId, now);
  const day = isoDate(now)!;
  const fp = dealFingerprint(s.context);
  const { data: existing } = await db.from("negotiation_log").select("kind, content, created_at").eq("workspace_id", workspaceId).eq("opportunity_id", opportunityId).neq("kind", "note").order("created_at", { ascending: false }).limit(100);
  const lastFp = new Map<string, string | null>();
  for (const e of (existing ?? []) as Row[]) if (!lastFp.has(String(e.kind))) lastFp.set(String(e.kind), ((e.content ?? {}) as Row).fingerprint as string | null ?? null);
  const kinds: [string, Row][] = [
    ["health_check", { health: s.health }],
    ["stakeholder_gaps", { gaps: s.gaps }],
    ["batna_questions", { questions: s.batna_questions }],
    ["risks", { risks: s.risks }],
    ["evidence_gaps", { evidence_gaps: s.evidence_gaps }],
  ];
  const rows = kinds.filter(([k]) => lastFp.get(k) !== fp).map(([kind, content]) => ({
    workspace_id: workspaceId, opportunity_id: opportunityId, kind, content: { ...content, as_of: day, fingerprint: fp, facts: s.facts, assumptions: s.assumptions }, generated_by: "rule", owner_user_id: userId,
  }));
  if (rows.length) { const { error } = await db.from("negotiation_log").insert(rows); if (error) throw error; }
  const ladder = await seedConcessionSteps(db, workspaceId, opportunityId, s, userId);
  return { saved: rows.length, ladderAdded: ladder, strategy: s };
}

async function seedConcessionSteps(db: Db, workspaceId: string, opportunityId: string, s: StrategyOutput & { context: DealContext }, userId: string | null) {
  const { data: steps, error } = await db.from("concession_step").select("id, step_no, value_json, row_version").eq("workspace_id", workspaceId).eq("opportunity_id", opportunityId).is("archived_at", null);
  if (error) throw error;
  const have = new Set(((steps ?? []) as Row[]).map((x) => String(((x.value_json ?? {}) as Row).item ?? "")));
  let next = Math.max(0, ...((steps ?? []) as Row[]).map((x) => Number(x.step_no))) + 1;
  const q = currentQuote(s.context);
  const fresh = s.concession_ladder.filter((c) => !have.has(c.item)).map((c) => ({
    workspace_id: workspaceId, opportunity_id: opportunityId, quote_id: q?.id ?? null, step_no: next++, concession_type: c.concession_type,
    ask: c.ask, give: c.give, status: "planned", owner_user_id: userId,
    value_json: { item: c.item, party: c.party, finance_type: c.finance_type, ...(c.finance_value !== null ? { finance_value: c.finance_value, finance_value_basis: c.finance_value_basis } : {}),
      suggested_by: "strategist", suggested_rank: c.rank, value_basis: c.value_basis, basis: c.basis, assumptions: c.assumptions },
    rationale: `${c.why}${c.basis.length ? ` Based on: ${c.basis.map((b) => b.label).join("; ")}.` : ""}${c.assumptions.length ? ` Assumptions: ${c.assumptions.join(" ")}` : ""}`.slice(0, 2000),
  }));
  if (fresh.length) { const { error: e } = await db.from("concession_step").insert(fresh); if (e) throw e; }
  // Size existing strategist steps that were saved before a number was known (only adds finance_value; status untouched).
  for (const st of (steps ?? []) as Row[]) {
    const v = (st.value_json ?? {}) as Row;
    if (v.suggested_by !== "strategist" || (v.finance_value !== undefined && v.finance_value !== null)) continue;
    const sug = s.concession_ladder.find((c) => c.item === v.item);
    if (!sug || sug.finance_value === null) continue;
    const { error: e } = await db.from("concession_step").update({ value_json: { ...v, finance_type: sug.finance_type, finance_value: sug.finance_value, finance_value_basis: sug.finance_value_basis } })
      .eq("workspace_id", workspaceId).eq("id", String(st.id)).eq("row_version", Number(st.row_version));
    if (e) throw e;
  }
  return fresh.length;
}

export async function addNegotiationNote(db: Db, workspaceId: string, opportunityId: string, note: string, userId: string) {
  const { data, error } = await db.from("negotiation_log").insert({ workspace_id: workspaceId, opportunity_id: opportunityId, kind: "note", content: { text: note.slice(0, 4000) }, generated_by: "user", owner_user_id: userId }).select().single();
  if (error) throw error;
  return data;
}

/** The adviser records what happened to a ladder step (the system never offers anything itself). */
export async function setConcessionStatus(db: Db, workspaceId: string, id: string, status: ConcessionStatus | "proposed", expectedVersion?: number) {
  const st = status === "proposed" ? "planned" : status;
  if (!STEP_STATUSES.includes(st)) throw new Error("invalid status");
  let q = db.from("concession_step").update({ status: st }).eq("workspace_id", workspaceId).eq("id", id);
  if (expectedVersion !== undefined) q = q.eq("row_version", expectedVersion);
  const { data, error } = await q.select();
  if (error) throw error;
  if (!data?.length) throw new Error("conflict_or_not_found");
  return data[0];
}

export async function negotiationHistory(db: Db, workspaceId: string, opportunityId: string) {
  const [log, items] = await Promise.all([
    db.from("negotiation_log").select("id, kind, content, generated_by, created_at").eq("workspace_id", workspaceId).eq("opportunity_id", opportunityId).order("created_at", { ascending: false }).limit(50),
    db.from("concession_step").select("id, step_no, concession_type, ask, give, value_json, npv_equivalent, engine_version, within_approved_bounds, status, rationale, quote_id, row_version").eq("workspace_id", workspaceId).eq("opportunity_id", opportunityId).is("archived_at", null).order("step_no"),
  ]);
  return { log: (log.data ?? []) as Row[], concessions: (items.data ?? []) as Row[] };
}

/** Job entry: re-run the snapshot for an opportunity after a stage change / new quote / new objection (service role). */
export async function refreshStrategyForEvent(db: Db, workspaceId: string, opportunityId: string) {
  const { data: opp, error } = await db.from("opportunity").select("id, outcome, archived_at, account_owner_user_id, owner_user_id").eq("workspace_id", workspaceId).eq("id", opportunityId).maybeSingle();
  if (error) throw error;
  if (!opp || opp.archived_at || (opp.outcome && opp.outcome !== "open")) return { skipped: "not_open" };
  const owner = (opp.account_owner_user_id as string | null) ?? (opp.owner_user_id as string | null) ?? null;
  const r = await saveStrategySnapshot(db, workspaceId, opportunityId, owner);
  return { saved: r.saved, ladderAdded: r.ladderAdded };
}
