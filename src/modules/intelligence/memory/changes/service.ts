/**
 * Module 13 §5.2 / §6 — change detection, historical comparison, requirement evolution, change impact analysis.
 * Reads Module 1 records through the caller's client (RLS for users; the orchestrator dispatcher passes the service
 * role and every query filters workspace_id explicitly — S2). Writes ONLY its own rows (memory_change,
 * memory_recommendation) plus orchestrator events/marks; canonical fields are never touched (S4).
 */
import "server-only";
import type { MemCtx, Row } from "../types";
import { q, today as todayIso } from "../data";
import { publishEvent } from "@/modules/orchestrator/events/publish";
import { markEntity } from "@/modules/orchestrator/reassess/marks";
import {
  decisionMakerImpact, detectAvailabilityChanges, detectDecisionMakerChange, detectEmploymentChanges, detectLeaseChanges,
  detectOpportunityInactive, detectRejectedRelevant, detectRequirementChanges, REQUIREMENT_FIELD_GROUPS, fieldVerification, type RequirementVersionRow,
} from "./detect";
import { CHANGE_LABEL, hrefFor, type DetectedChange, type RecordRef } from "./types";
import { recommendationForChange } from "../recommend/rules";
import { loadRejections } from "../integrate/rejections";

export interface ChangeScope { requirementId?: string; personId?: string; orgId?: string; assetId?: string; opportunityId?: string; all?: boolean }

const OPEN_STAGE_EXCLUDE = "(signed,collected)";

// ------------------------------------------------------------------ requirement evolution (§5.2)

export interface RequirementEvolution {
  requirementId: string;
  title: string | null;
  original: { version: number; at: string; snapshot: Row } | null;
  current: { version: number; at: string; snapshot: Row } | null;
  steps: {
    version: number; at: string; reason: string | null;
    source: { type: string; id: string | null; label: string; href: string | null };
    changes: { field: string; kind: string; from: Row; to: Row; text: string; material: boolean; verification: string; previousObsolete: boolean; obsoleteNote: string }[];
  }[];
  materialChangeCount: number;
  unknown: string[];
}

/**
 * Original preserved (version 1 snapshot), every update recorded with what/when/source, and whether the earlier value
 * is obsolete. A previous value is obsolete only when the new value is client-confirmed; otherwise it is "superseded,
 * pending confirmation" (the newer value may itself be an estimate).
 */
export async function getRequirementEvolution(ctx: MemCtx, requirementId: string): Promise<RequirementEvolution> {
  const ws = ctx.workspaceId;
  const [req, versions] = await Promise.all([
    ctx.db.from("requirement").select("id, title").eq("workspace_id", ws).eq("id", requirementId).maybeSingle().then((r) => r.data as Row | null),
    q<Row[]>(ctx.db.from("requirement_version").select("id, version, snapshot, field_status, change_reason, change_proposal_id, created_at").eq("workspace_id", ws).eq("requirement_id", requirementId).order("version").limit(500)),
  ]);
  const geoIds = new Set<string>();
  for (const v of versions) for (const k of ["preferred_geography_ids", "excluded_geography_ids"]) for (const g of (v.snapshot?.[k] ?? []) as string[]) geoIds.add(g);
  const geos = geoIds.size ? await q<Row[]>(ctx.db.from("geography").select("id, name").in("id", [...geoIds])) : [];
  const geoName = (id: string) => geos.find((g) => g.id === id)?.name ?? `unknown area ${id.slice(0, 8)}`;
  const detected = detectRequirementChanges(requirementId, versions as RequirementVersionRow[], geoName);
  const proposals = versions.some((v) => v.change_proposal_id)
    ? await q<Row[]>(ctx.db.from("change_proposal").select("id, reason, proposed_by_kind, capture_id, decided_at").eq("workspace_id", ws).in("id", versions.map((v) => v.change_proposal_id).filter(Boolean)))
    : [];
  const steps: RequirementEvolution["steps"] = [];
  for (const v of versions.slice(1)) {
    const ch = detected.filter((d) => d.dedupeKey.endsWith(`-v${v.version}`));
    if (!ch.length) continue;
    const p = proposals.find((x) => x.id === v.change_proposal_id);
    steps.push({
      version: v.version, at: v.created_at, reason: v.change_reason ?? null,
      source: p
        ? { type: p.capture_id ? "capture" : "change_proposal", id: p.capture_id ?? p.id, label: `${p.capture_id ? "Captured note" : "Approved change"}${p.reason ? `: ${p.reason}` : ""} (${p.proposed_by_kind ?? "user"})`, href: p.capture_id ? `/capture/${p.capture_id}` : "/approvals" }
        : { type: "requirement_version", id: v.id, label: `Edited on the requirement (version ${v.version})${v.change_reason ? `: ${v.change_reason}` : ""}`, href: hrefFor("requirement", requirementId) },
      changes: ch.map((c) => {
        const g = REQUIREMENT_FIELD_GROUPS.find((x) => x.kind === c.kind)!;
        const confirmed = v.field_status?.[g.status] === "client_confirmed";
        return { field: c.field ?? g.field, kind: c.kind, from: c.previous as Row, to: c.latest as Row, text: c.difference.text, material: c.material, verification: fieldVerification(v.field_status?.[g.status]),
          previousObsolete: confirmed, obsoleteNote: confirmed ? "Previous value is obsolete (new value client-confirmed)." : "Previous value superseded; new value not client-confirmed yet." };
      }),
    });
  }
  const first = versions[0], last = versions[versions.length - 1];
  return {
    requirementId, title: req?.title ?? null,
    original: first ? { version: first.version, at: first.created_at, snapshot: first.snapshot } : null,
    current: last ? { version: last.version, at: last.created_at, snapshot: last.snapshot } : null,
    steps, materialChangeCount: steps.reduce((n, s) => n + s.changes.filter((c) => c.material).length, 0),
    unknown: versions.length ? [] : ["No requirement history recorded (no saved versions)."],
  };
}

// ------------------------------------------------------------------ detection

async function lastActivity(ctx: MemCtx, oppIds: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!oppIds.length) return m;
  const ints = await q<Row[]>(ctx.db.from("interaction").select("opportunity_id, occurred_at").eq("workspace_id", ctx.workspaceId).in("opportunity_id", oppIds).order("occurred_at", { ascending: false }).limit(1000));
  for (const i of ints) if (!m.has(i.opportunity_id)) m.set(i.opportunity_id, i.occurred_at);
  const hist = await q<Row[]>(ctx.db.from("opportunity_stage_history").select("opportunity_id, created_at").eq("workspace_id", ctx.workspaceId).in("opportunity_id", oppIds).order("created_at", { ascending: false }).limit(1000)).catch(() => [] as Row[]);
  for (const h of hist) if (!m.has(h.opportunity_id) || m.get(h.opportunity_id)! < h.created_at) m.set(h.opportunity_id, h.created_at);
  return m;
}

async function personChanges(ctx: MemCtx, personIds: string[]): Promise<DetectedChange[]> {
  if (!personIds.length) return [];
  const rows = await q<Row[]>(ctx.db.from("employment").select("id, person_id, org_id, title, seniority, start_date, end_date, is_current, fact_status, created_at, org:org_id(display_name), person:person_id(full_name)")
    .eq("workspace_id", ctx.workspaceId).in("person_id", personIds).is("archived_at", null).limit(2000));
  const by = new Map<string, Row[]>();
  for (const r of rows) by.set(r.person_id, [...(by.get(r.person_id) ?? []), { ...r, org_name: r.org?.display_name ?? null }]);
  return [...by].flatMap(([pid, list]) => detectEmploymentChanges(pid, list[0]?.person?.full_name ?? "Contact", list));
}

async function requirementChanges(ctx: MemCtx, reqIds: string[]): Promise<DetectedChange[]> {
  if (!reqIds.length) return [];
  const ws = ctx.workspaceId;
  const out: DetectedChange[] = [];
  const [versions, stakes, reqs] = await Promise.all([
    q<Row[]>(ctx.db.from("requirement_version").select("id, requirement_id, version, snapshot, field_status, change_reason, change_proposal_id, created_at").eq("workspace_id", ws).in("requirement_id", reqIds).order("version").limit(5000)),
    q<Row[]>(ctx.db.from("stakeholder").select("id, requirement_id, person_id, employment_id, role, created_at, archived_at, person:person_id(full_name), employment:employment_id(is_current, end_date)").eq("workspace_id", ws).in("requirement_id", reqIds).limit(2000)),
    q<Row[]>(ctx.db.from("requirement").select("id, org_id").eq("workspace_id", ws).in("id", reqIds)),
  ]);
  for (const id of reqIds) out.push(...detectRequirementChanges(id, versions.filter((v) => v.requirement_id === id) as RequirementVersionRow[]));
  // Employment status of stakeholders who have no employment link: current employment at the requirement's company.
  const orgOf = new Map(reqs.map((r) => [r.id, r.org_id]));
  const pids = [...new Set(stakes.map((s) => s.person_id))];
  const emp = pids.length ? await q<Row[]>(ctx.db.from("employment").select("person_id, org_id, is_current, end_date").eq("workspace_id", ws).in("person_id", pids).is("archived_at", null)) : [];
  for (const id of reqIds) {
    const list = stakes.filter((s) => s.requirement_id === id).map((s) => {
      const org = orgOf.get(id);
      const atOrg = emp.filter((e) => e.person_id === s.person_id && e.org_id === org);
      const current = s.employment ? !!s.employment.is_current && !s.employment.end_date : atOrg.length ? atOrg.some((e) => e.is_current && !e.end_date) : null;
      return { ...s, person_name: s.person?.full_name ?? null, current_employment: current };
    });
    out.push(...detectDecisionMakerChange(id, list));
  }
  // Previously rejected properties with newer availability / quotes.
  for (const id of reqIds) {
    const rej = (await loadRejections(ctx, { requirementId: id })).filter((r) => r.at);
    if (!rej.length) continue;
    const assetIds = [...new Set(rej.map((r) => r.assetId))];
    const spaces = await q<Row[]>(ctx.db.from("space").select("id, asset_id").eq("workspace_id", ws).in("asset_id", assetIds));
    const sIds = spaces.map((s) => s.id);
    const assetOf = new Map(spaces.map((s) => [s.id, s.asset_id]));
    const [av, qs] = sIds.length ? await Promise.all([
      q<Row[]>(ctx.db.from("availability").select("id, space_id, as_of, created_at, status, asking_rent_min, rent_basis").eq("workspace_id", ws).in("space_id", sIds).is("archived_at", null).limit(500)),
      q<Row[]>(ctx.db.from("quote").select("id, space_id, created_at, terms_json").eq("workspace_id", ws).in("space_id", sIds).is("archived_at", null).limit(500)),
    ]) : [[], []];
    out.push(...detectRejectedRelevant(rej, [
      ...av.map((a) => ({ assetId: assetOf.get(a.space_id)!, at: a.created_at, id: a.id, kind: "availability" as const, text: `${a.status ?? "status unknown"}${a.asking_rent_min != null ? `, asking ${a.asking_rent_min}${a.rent_basis ? ` ${a.rent_basis}` : ""}` : ", rent unknown"}` })),
      ...qs.map((x) => ({ assetId: assetOf.get(x.space_id)!, at: x.created_at, id: x.id, kind: "quote" as const, text: `new quotation${x.terms_json?.rent != null ? ` (rent ${x.terms_json.rent})` : ""} — historical quote, not current pricing` })),
    ]));
  }
  return out;
}

async function orgChanges(ctx: MemCtx, orgIds: string[], today: string): Promise<DetectedChange[]> {
  if (!orgIds.length) return [];
  const leases = await q<Row[]>(ctx.db.from("lease").select("id, tenant_org_id, asset_id, area_sf, area_basis, start_date, contractual_expiry, fact_status, amends_lease_id, created_at, asset:asset_id(name), lease_event(id, event_type, event_date, confirmed), org:tenant_org_id(display_name)")
    .eq("workspace_id", ctx.workspaceId).in("tenant_org_id", orgIds).is("archived_at", null).limit(2000));
  const by = new Map<string, Row[]>();
  for (const l of leases) by.set(l.tenant_org_id, [...(by.get(l.tenant_org_id) ?? []), { ...l, asset_name: l.asset?.name ?? null }]);
  return [...by].flatMap(([oid, list]) => detectLeaseChanges({ id: oid, name: list[0]?.org?.display_name ?? "Company" }, list, today));
}

async function assetChanges(ctx: MemCtx, assetIds: string[]): Promise<DetectedChange[]> {
  if (!assetIds.length) return [];
  const spaces = await q<Row[]>(ctx.db.from("space").select("id, asset_id, floor_text, unit, asset:asset_id(name)").eq("workspace_id", ctx.workspaceId).in("asset_id", assetIds).limit(500));
  if (!spaces.length) return [];
  const av = await q<Row[]>(ctx.db.from("availability").select("id, space_id, as_of, created_at, status, asking_rent_min, asking_rent_max, rent_basis, cam_psf_month, fact_status, source_object_id")
    .eq("workspace_id", ctx.workspaceId).in("space_id", spaces.map((s) => s.id)).is("archived_at", null).limit(3000));
  return spaces.flatMap((s) => detectAvailabilityChanges({ id: s.id, assetId: s.asset_id, label: `${s.asset?.name ?? "Building"}${s.floor_text || s.unit ? ` · ${[s.floor_text, s.unit].filter(Boolean).join(" ")}` : ""}` }, av.filter((a) => a.space_id === s.id)));
}

async function opportunityChanges(ctx: MemCtx, opps: Row[], today: string): Promise<DetectedChange[]> {
  const last = await lastActivity(ctx, opps.map((o) => o.id));
  return opps.flatMap((o) => detectOpportunityInactive(o, last.get(o.id) ?? null, today));
}

/** Fill affected records / opportunities for each change (§6.2) — opportunities stay with their own company (§10). */
async function enrich(ctx: MemCtx, changes: DetectedChange[]): Promise<DetectedChange[]> {
  const ws = ctx.workspaceId;
  const reqIds = [...new Set(changes.filter((c) => c.entityType === "requirement").map((c) => c.entityId))];
  const orgIds = [...new Set(changes.filter((c) => c.entityType === "organisation").map((c) => c.entityId))];
  const personIds = [...new Set(changes.filter((c) => c.entityType === "person").map((c) => c.entityId))];
  const stakes = personIds.length ? await q<Row[]>(ctx.db.from("stakeholder").select("person_id, requirement_id").eq("workspace_id", ws).in("person_id", personIds).is("archived_at", null)) : [];
  const allReq = [...new Set([...reqIds, ...stakes.map((s) => s.requirement_id)])];
  const opps = allReq.length || orgIds.length
    ? await q<Row[]>(ctx.db.from("opportunity").select("id, name, org_id, requirement_id, stage").eq("workspace_id", ws).is("archived_at", null).not("stage", "in", OPEN_STAGE_EXCLUDE)
      .or([allReq.length ? `requirement_id.in.(${allReq.join(",")})` : null, orgIds.length ? `org_id.in.(${orgIds.join(",")})` : null].filter(Boolean).join(",")))
    : [];
  for (const c of changes) {
    let list: Row[] = [];
    if (c.entityType === "requirement") list = opps.filter((o) => o.requirement_id === c.entityId);
    else if (c.entityType === "organisation") list = opps.filter((o) => o.org_id === c.entityId);
    else if (c.entityType === "person") {
      const rs = new Set(stakes.filter((s) => s.person_id === c.entityId).map((s) => s.requirement_id));
      // Employer change: only opportunities of the requirements the person was a stakeholder on — they are FLAGGED, never moved.
      list = opps.filter((o) => rs.has(o.requirement_id));
    }
    c.affectedOpportunityIds = [...new Set([...c.affectedOpportunityIds, ...list.map((o) => o.id)])];
    const recs: RecordRef[] = [...c.affectedRecords.filter((r) => r.id), ...list.map((o) => ({ type: "opportunity", id: o.id, label: o.name }))];
    c.affectedRecords = recs.filter((r, i) => recs.findIndex((x) => x.type === r.type && x.id === r.id) === i);
  }
  return changes;
}

/** §6.3 impact analysis for a decision-maker change. */
export async function analyseDecisionMakerChange(ctx: MemCtx, change: DetectedChange) {
  const ws = ctx.workspaceId;
  const prev = change.previous as Row | null, next = change.latest as Row | null;
  const req = (await ctx.db.from("requirement").select("id, org_id").eq("workspace_id", ws).eq("id", change.entityId).maybeSingle()).data as Row | null;
  const hist = async (pid: string | undefined) => {
    if (!pid) return { interactions: 0, lastAt: null as string | null, sources: [] as { type: string; id: string; label: string; href: string | null }[] };
    const links = await q<Row[]>(ctx.db.from("interaction_link").select("interaction:interaction_id(id, occurred_at, channel, subject)").eq("workspace_id", ws).eq("entity_type", "person").eq("entity_id", pid).is("archived_at", null).limit(200));
    const ints = links.map((l) => l.interaction).filter(Boolean).sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
    return { interactions: ints.length, lastAt: ints[0]?.occurred_at ?? null, sources: ints.slice(0, 5).map((i) => ({ type: "interaction", id: i.id, label: `${i.channel} ${String(i.occurred_at).slice(0, 10)}${i.subject ? ` — ${i.subject}` : ""}`, href: hrefFor("person", pid) })) };
  };
  const [hp, hn, emps, opps] = await Promise.all([
    hist(prev?.personId), hist(next?.personId),
    req?.org_id ? q<Row[]>(ctx.db.from("employment").select("person_id, title, is_current, end_date, person:person_id(full_name)").eq("workspace_id", ws).eq("org_id", req.org_id).is("archived_at", null).limit(100)) : Promise.resolve([] as Row[]),
    req?.org_id ? q<Row[]>(ctx.db.from("opportunity").select("id, name, stage").eq("workspace_id", ws).eq("org_id", req.org_id).is("archived_at", null).or("outcome.is.null,outcome.eq.open").not("stage", "in", OPEN_STAGE_EXCLUDE)) : Promise.resolve([] as Row[]),
  ]);
  return decisionMakerImpact({
    previous: prev ? { personId: prev.personId, name: prev.name ?? null, role: prev.role } : null,
    next: next ? { personId: next.personId, name: next.name ?? null, role: next.role } : null,
    historyWithPrevious: hp, historyWithNext: { interactions: hn.interactions, lastAt: hn.lastAt },
    contacts: emps.map((e) => ({ personId: e.person_id, name: e.person?.full_name ?? "Unnamed", title: e.title ?? null, current: !!e.is_current && !e.end_date })),
    activeOpportunities: opps.map((o) => ({ id: o.id, name: o.name, stage: o.stage })),
  });
}

export interface DetectResult { detected: DetectedChange[]; inserted: { id: string; change: DetectedChange }[]; notified: number; recommendations: number }

/**
 * Detect changes for a scope, store new ones (idempotent on dedupe_key), and for NEW material changes notify the
 * orchestrator (event `intelligence.change_detected`), flag affected opportunities for review and emit a
 * recommendation. Re-running never duplicates rows, events or marks.
 */
export async function detectChanges(ctx: MemCtx, scope: ChangeScope, opts: { today?: string; notify?: boolean; persist?: boolean } = {}): Promise<DetectResult> {
  const ws = ctx.workspaceId, today = opts.today ?? todayIso();
  const reqIds = new Set<string>(), personIds = new Set<string>(), orgIds = new Set<string>(), assetIds = new Set<string>();
  let opps: Row[] = [];
  const oppCols = "id, name, stage, outcome, stage_entered_at, updated_at, org_id, requirement_id";
  if (scope.requirementId) {
    reqIds.add(scope.requirementId);
    opps.push(...await q<Row[]>(ctx.db.from("opportunity").select(oppCols).eq("workspace_id", ws).eq("requirement_id", scope.requirementId).is("archived_at", null)));
  }
  if (scope.personId) {
    personIds.add(scope.personId);
    for (const s of await q<Row[]>(ctx.db.from("stakeholder").select("requirement_id").eq("workspace_id", ws).eq("person_id", scope.personId).limit(50))) reqIds.add(s.requirement_id);
  }
  if (scope.orgId) {
    orgIds.add(scope.orgId);
    for (const r of await q<Row[]>(ctx.db.from("requirement").select("id").eq("workspace_id", ws).eq("org_id", scope.orgId).is("archived_at", null).limit(50))) reqIds.add(r.id);
    for (const e of await q<Row[]>(ctx.db.from("employment").select("person_id").eq("workspace_id", ws).eq("org_id", scope.orgId).is("archived_at", null).limit(100))) personIds.add(e.person_id);
    opps.push(...await q<Row[]>(ctx.db.from("opportunity").select(oppCols).eq("workspace_id", ws).eq("org_id", scope.orgId).is("archived_at", null)));
  }
  if (scope.assetId) assetIds.add(scope.assetId);
  if (scope.opportunityId) opps.push(...await q<Row[]>(ctx.db.from("opportunity").select(oppCols).eq("workspace_id", ws).eq("id", scope.opportunityId)));
  if (scope.all) {
    const since = new Date(Date.parse(`${today}T00:00:00Z`) - 120 * 864e5).toISOString();
    for (const r of await q<Row[]>(ctx.db.from("requirement").select("id").eq("workspace_id", ws).is("archived_at", null).gte("updated_at", since).order("updated_at", { ascending: false }).limit(60))) reqIds.add(r.id);
    for (const e of await q<Row[]>(ctx.db.from("employment").select("person_id").eq("workspace_id", ws).gte("created_at", since).order("created_at", { ascending: false }).limit(100))) personIds.add(e.person_id);
    const soon = new Date(Date.parse(`${today}T00:00:00Z`) + 180 * 864e5).toISOString().slice(0, 10);
    for (const l of await q<Row[]>(ctx.db.from("lease").select("tenant_org_id").eq("workspace_id", ws).is("archived_at", null).not("tenant_org_id", "is", null).gte("contractual_expiry", today).lte("contractual_expiry", soon).limit(60))) orgIds.add(l.tenant_org_id);
    opps.push(...await q<Row[]>(ctx.db.from("opportunity").select(oppCols).eq("workspace_id", ws).is("archived_at", null).or("outcome.is.null,outcome.eq.open").order("updated_at").limit(150)));
  }
  opps = opps.filter((o, i) => opps.findIndex((x) => x.id === o.id) === i);
  const all = [
    ...await personChanges(ctx, [...personIds]),
    ...await requirementChanges(ctx, [...reqIds]),
    ...await orgChanges(ctx, [...orgIds], today),
    ...await assetChanges(ctx, [...assetIds]),
    ...await opportunityChanges(ctx, opps, today),
  ];
  const detected = await enrich(ctx, all.filter((c, i) => all.findIndex((x) => x.dedupeKey === c.dedupeKey) === i));
  const res: DetectResult = { detected, inserted: [], notified: 0, recommendations: 0 };
  if (opts.persist === false || !detected.length) return res;

  for (const c of detected) if (c.kind === "decision_maker_change") c.impact = await analyseDecisionMakerChange(ctx, c);
  const rows = detected.map((c) => ({
    workspace_id: ws, owner_user_id: ctx.userId || null, dedupe_key: c.dedupeKey, change_kind: c.kind, entity_type: c.entityType, entity_id: c.entityId, field: c.field,
    previous_value: c.previous ?? null, latest_value: c.latest ?? null, difference: c.difference, changed_at: c.changedAt, source_ref: c.source ?? {}, verification: c.verification,
    affected_records: c.affectedRecords, affected_opportunity_ids: c.affectedOpportunityIds, modules: c.modules, material: c.material, impact: c.impact ?? {},
  }));
  const ins = await ctx.db.from("memory_change").upsert(rows, { onConflict: "workspace_id,dedupe_key", ignoreDuplicates: true }).select("id, dedupe_key");
  if (ins.error) throw new Error(`memory_change: ${ins.error.message}`);
  for (const r of (ins.data ?? []) as Row[]) res.inserted.push({ id: r.id, change: detected.find((c) => c.dedupeKey === r.dedupe_key)! });

  for (const { id, change: c } of res.inserted) {
    if (!c.material) continue;
    const rec = recommendationForChange(c, id);
    if (rec) {
      const r = await ctx.db.from("memory_recommendation").upsert({ workspace_id: ws, owner_user_id: ctx.userId || null, dedupe_key: rec.ref, kind: rec.kind, entity_type: rec.entityType, entity_id: rec.entityId,
        title: rec.title, why: rec.why, supporting: rec.supporting, source_refs: rec.sourceRefs, confidence: rec.confidence, next_action: rec.nextAction, href: rec.href, change_id: id },
      { onConflict: "workspace_id,dedupe_key", ignoreDuplicates: true }).select("id");
      if (!r.error) res.recommendations += (r.data ?? []).length;
    }
    if (opts.notify === false) continue;
    // Notify the orchestrator (§5.2 step 8, §6.2, §11 Module 9) and flag affected opportunities for reassessment.
    await publishEvent(ctx.db, ws, { type: "intelligence.change_detected", subjectType: c.entityType, subjectId: c.entityId, dedupeKey: `memchange:${id}`,
      payload: { change_id: id, kind: c.kind, label: CHANGE_LABEL[c.kind], field: c.field, modules: c.modules, affected_opportunity_ids: c.affectedOpportunityIds } }).catch(() => null);
    for (const oid of c.affectedOpportunityIds.slice(0, 20)) {
      await markEntity(ctx.db, ws, { entityType: "opportunity", entityId: oid, mark: "review", reason: `${CHANGE_LABEL[c.kind]}: ${c.difference.text}`.slice(0, 400), causeType: "memory_change", causeId: id, dedupeKey: `memchange:${id}:opp:${oid}`, owner: ctx.userId || null }).catch(() => null);
    }
    await ctx.db.from("memory_change").update({ notified_at: new Date().toISOString() }).eq("workspace_id", ws).eq("id", id);
    res.notified++;
  }
  return res;
}

// ------------------------------------------------------------------ historical comparison (§6.2) / listing

export interface ChangeRow {
  id: string; kind: string; label: string; entityType: string; entityId: string; field: string | null;
  previous: unknown; latest: unknown; difference: { text: string; delta?: number | null; pct?: number | null }; changedAt: string | null; detectedAt: string;
  source: Row; verification: string; affectedRecords: RecordRef[]; affectedOpportunityIds: string[]; modules: string[]; material: boolean; impact: Row; state: string;
}
const toRow = (r: Row): ChangeRow => ({
  id: r.id, kind: r.change_kind, label: CHANGE_LABEL[r.change_kind as keyof typeof CHANGE_LABEL] ?? r.change_kind, entityType: r.entity_type, entityId: r.entity_id, field: r.field,
  previous: r.previous_value, latest: r.latest_value, difference: r.difference ?? { text: "" }, changedAt: r.changed_at, detectedAt: r.created_at, source: r.source_ref ?? {},
  verification: r.verification, affectedRecords: r.affected_records ?? [], affectedOpportunityIds: r.affected_opportunity_ids ?? [], modules: r.modules ?? [], material: r.material, impact: r.impact ?? {}, state: r.state,
});

/** Stored changes for an entity (and, for companies, its requirements / people), newest first. */
export async function listChanges(ctx: MemCtx, f: { entityType?: string; entityId?: string; kinds?: string[]; state?: "open" | "all"; limit?: number } = {}): Promise<ChangeRow[]> {
  let qy = ctx.db.from("memory_change").select("*").eq("workspace_id", ctx.workspaceId).is("archived_at", null);
  if (f.entityId) {
    const ids = [f.entityId];
    if (f.entityType === "organisation") {
      ids.push(...(await q<Row[]>(ctx.db.from("requirement").select("id").eq("workspace_id", ctx.workspaceId).eq("org_id", f.entityId).limit(100))).map((r) => r.id));
      ids.push(...(await q<Row[]>(ctx.db.from("employment").select("person_id").eq("workspace_id", ctx.workspaceId).eq("org_id", f.entityId).limit(200))).map((r) => r.person_id));
    }
    qy = qy.in("entity_id", [...new Set(ids)]);
  }
  if (f.kinds?.length) qy = qy.in("change_kind", f.kinds);
  if (f.state !== "all") qy = qy.eq("state", "open");
  return (await q<Row[]>(qy.order("created_at", { ascending: false }).limit(f.limit ?? 50))).map(toRow);
}

/** "What changed" for one record: detect (persisting) then return the historical comparison rows. */
export async function whatChanged(ctx: MemCtx, scope: ChangeScope, opts: { since?: string; persist?: boolean } = {}) {
  const r = await detectChanges(ctx, scope, { persist: opts.persist ?? true, notify: true });
  const items = r.detected.filter((c) => !opts.since || (c.changedAt ?? "") >= opts.since);
  return items.sort((a, b) => String(b.changedAt ?? "").localeCompare(String(a.changedAt ?? "")));
}

export async function setChangeState(ctx: MemCtx, id: string, state: "acknowledged" | "dismissed" | "open") {
  const { error } = await ctx.db.from("memory_change").update({ state }).eq("workspace_id", ctx.workspaceId).eq("id", id);
  if (error) throw new Error(error.message);
}
