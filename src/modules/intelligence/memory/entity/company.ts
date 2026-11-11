import "server-only";
/** Company memory (spec §3.2). Opportunities belong to the company, not to a contact (§10). */
import { missingQuestions, type RequirementRow } from "@/modules/deals/requirements/contract";
import { commitmentsFrom, interactionsFor, labels, objectionsFrom, q, today, type Commitment, type Objection } from "../data";
import { hrefFor, item, verificationOf, type MemCtx, type MemoryItem, type Row } from "../types";

const CLOSED_REQ = new Set(["closed", "lost", "won", "dormant", "cancelled"]);

export interface CompanyContext {
  org: Row;
  relatedOrgs: { id: string; name: string; relation: string; direction: "from" | "to"; current: boolean }[];
  locations: { assetId: string | null; name: string; areaSf: number | null; expiry: string | null; current: boolean; leaseId: string }[];
  currentRequirements: Row[];
  historicalRequirements: Row[];
  people: { personId: string; name: string; title: string | null; current: boolean; decisionMaker: boolean; verification: string }[];
  decisionMakers: { personId: string; name: string; role: string; requirementTitle: string | null }[];
  rentHistory: MemoryItem[];
  transactions: Row[];
  activeOpportunities: Row[];
  previousOpportunities: Row[];
  interactions: Row[];
  commitments: Commitment[];
  objections: Objection[];
  developments: Row[];
  unresolvedQuestions: { text: string; href: string | null }[];
  unknowns: string[];
}

export async function getCompanyContext(ctx: MemCtx, orgId: string): Promise<CompanyContext | null> {
  const ws = ctx.workspaceId;
  const { data: org } = await ctx.db.from("organisation").select("id, display_name, legal_name, sector, hq_city, hq_country, headcount_min, headcount_max, is_gcc, domain, source_confidence").eq("workspace_id", ws).eq("id", orgId).maybeSingle();
  if (!org) return null;
  const [rels, leases, reqs, emps, opps, txns, signals, tasks] = await Promise.all([
    q(ctx.db.from("organisation_relation").select("id, from_org_id, to_org_id, relation_type, valid_to").eq("workspace_id", ws).is("archived_at", null).or(`from_org_id.eq.${orgId},to_org_id.eq.${orgId}`).limit(100)),
    q(ctx.db.from("lease").select("id, asset_id, area_sf, start_date, contractual_expiry, status, fact_status, source_object_id, created_at, asset:asset_id(name)").eq("workspace_id", ws).eq("tenant_org_id", orgId).is("archived_at", null).order("contractual_expiry", { ascending: false, nullsFirst: false }).limit(100)),
    q(ctx.db.from("requirement").select("*").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).order("updated_at", { ascending: false }).limit(100)),
    q(ctx.db.from("employment").select("person_id, title, is_current, end_date, fact_status, person:person_id(full_name)").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).limit(300)),
    q(ctx.db.from("opportunity").select("id, name, stage, outcome, outcome_reason, requirement_id, next_action, next_action_due, updated_at").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).order("updated_at", { ascending: false }).limit(100)),
    q(ctx.db.from("market_transaction").select("id, deal_type, period_start, area_sf, asset:asset_id(name)").eq("workspace_id", ws).eq("tenant_org_id", orgId).is("archived_at", null).order("period_start", { ascending: false, nullsFirst: false }).limit(50)).catch(() => [] as Row[]),
    q(ctx.db.from("signal").select("id, title, kind, event_date, verification, status, created_at").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).neq("status", "dismissed").order("created_at", { ascending: false }).limit(20)).catch(() => [] as Row[]),
    q(ctx.db.from("task").select("id, title, due_at").eq("workspace_id", ws).eq("linked_entity_type", "organisation").eq("linked_entity_id", orgId).in("status", ["open", "in_progress"]).is("archived_at", null).limit(30)),
  ]);
  const relNames = await labels(ctx, "organisation", rels.map((r) => (r.from_org_id === orgId ? r.to_org_id : r.from_org_id)));
  const reqIds = reqs.map((r) => r.id);
  const stake = reqIds.length ? await q(ctx.db.from("stakeholder").select("person_id, role, requirement_id, person:person_id(full_name)").eq("workspace_id", ws).in("requirement_id", reqIds).is("archived_at", null)) : [];
  const t = today();
  const isCur = (e: Row) => !!e.is_current && (!e.end_date || e.end_date >= t);
  const currentPeople = new Set(emps.filter(isCur).map((e) => e.person_id));
  const DM = new Set(["decision_maker", "economic_buyer", "approver", "sponsor"]);
  const dms = stake.filter((s) => DM.has(s.role));
  const orgInts = await interactionsFor(ctx, "organisation", [orgId]);
  const personInts = await interactionsFor(ctx, "person", [...currentPeople], 300);
  const by = new Map<string, Row>(); for (const i of [...orgInts, ...personInts]) if (!by.has(i.id)) by.set(i.id, i);
  const ints = [...by.values()].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
  const reqTitle = new Map(reqs.map((r) => [r.id, r.title]));
  const unresolved = [
    ...reqs.filter((r) => !CLOSED_REQ.has(r.status)).flatMap((r) => missingQuestions(r as RequirementRow).filter((m) => m.priority === "mandatory").slice(0, 4).map((m) => ({ text: `${r.title}: ${m.question}`, href: hrefFor("requirement", r.id) }))),
    ...tasks.map((x) => ({ text: x.title, href: "/tasks" })),
  ];
  const unknowns: string[] = [];
  if (!org.sector) unknowns.push("Industry");
  if (!leases.length) unknowns.push("Current occupancy (no leases recorded)");
  if (!dms.length) unknowns.push("Real-estate decision-maker");
  if (!ints.length) unknowns.push("Any conversation history");
  return {
    org,
    relatedOrgs: rels.map((r) => ({ id: r.from_org_id === orgId ? r.to_org_id : r.from_org_id, name: relNames.get(r.from_org_id === orgId ? r.to_org_id : r.from_org_id) ?? "Company", relation: r.relation_type, direction: r.from_org_id === orgId ? "from" as const : "to" as const, current: !r.valid_to || r.valid_to >= t })),
    locations: leases.map((l) => ({ leaseId: l.id, assetId: l.asset_id, name: l.asset?.name ?? "Unknown building", areaSf: l.area_sf, expiry: l.contractual_expiry, current: !(l.contractual_expiry && l.contractual_expiry < t) && !["expired", "terminated", "surrendered"].includes(l.status) })),
    currentRequirements: reqs.filter((r) => !CLOSED_REQ.has(r.status)),
    historicalRequirements: reqs.filter((r) => CLOSED_REQ.has(r.status)),
    people: emps.map((e) => ({ personId: e.person_id, name: e.person?.full_name ?? "Contact", title: e.title, current: isCur(e), decisionMaker: dms.some((d) => d.person_id === e.person_id), verification: verificationOf(e.fact_status) })),
    decisionMakers: dms.map((d) => ({ personId: d.person_id, name: d.person?.full_name ?? "Contact", role: d.role, requirementTitle: reqTitle.get(d.requirement_id) ?? null })),
    rentHistory: leases.map((l) => item({ entityId: orgId, entityType: "organisation", category: "occupancy", label: l.asset?.name ?? "Lease", value: { areaSf: l.area_sf, start: l.start_date, expiry: l.contractual_expiry },
      display: `${l.asset?.name ?? "Unknown building"}: ${l.area_sf ?? "area unknown"} SF, ${l.start_date ?? "start unknown"} → ${l.contractual_expiry ?? "expiry unknown"}`,
      sourceRef: { type: "lease", id: l.id, label: "Lease record", href: "/leases" }, observedAt: l.created_at, verification: verificationOf(l.fact_status),
      related: l.asset_id ? [{ type: "asset", id: l.asset_id }] : [], status: l.contractual_expiry && l.contractual_expiry < t ? "historical" : "current" })),
    transactions: txns,
    activeOpportunities: opps.filter((o) => !o.outcome || o.outcome === "open"),
    previousOpportunities: opps.filter((o) => !!o.outcome && o.outcome !== "open"),
    interactions: ints, commitments: commitmentsFrom(ints), objections: objectionsFrom(ints),
    developments: signals, unresolvedQuestions: unresolved, unknowns,
  };
}
