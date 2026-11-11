import "server-only";
/** Person memory (spec §3.1). Employment history is preserved; opportunities stay with their company (§10). */
import { commitmentsFrom, interactionsFor, interactionSource, labels, objectionsFrom, q, today, type Commitment, type Objection } from "../data";
import { assessRelationship } from "../relationship/service";
import type { RelationshipAssessment } from "../relationship/strength";
import { hrefFor, item, verificationOf, type MemCtx, type MemoryItem, type Row } from "../types";

export interface PersonContext {
  person: { id: string; name: string; aliases: string[]; preferredChannel: string | null; preferredLanguage: string | null; doNotContact: boolean; restrictions: string | null };
  currentEmployment: MemoryItem[];
  previousEmployment: MemoryItem[];
  designations: MemoryItem[];
  seniority: string | null;
  department: string | null;
  decisionRoles: MemoryItem[];
  preferences: MemoryItem[];
  interactions: Row[];
  commitments: Commitment[];
  objections: Objection[];
  lastInteractionAt: string | null;
  nextInteraction: { at: string; title: string; href: string | null } | null;
  relationship: RelationshipAssessment;
  /** Opportunities linked through requirements at the person's CURRENT employer. */
  opportunities: Row[];
  /** Opportunities at former employers — they stay with that company; shown for history only. */
  formerEmployerOpportunities: Row[];
  connections: Row[];
  unknowns: string[];
}

export async function getPersonContext(ctx: MemCtx, personId: string): Promise<PersonContext | null> {
  const ws = ctx.workspaceId;
  const { data: p } = await ctx.db.from("person").select("id, full_name, aliases, preferred_channel, preferred_language, do_not_contact, contact_restrictions").eq("workspace_id", ws).eq("id", personId).maybeSingle();
  if (!p) return null;
  const [emps, ints, roles, stake, mems, nextMtg, edges] = await Promise.all([
    q(ctx.db.from("employment").select("id, org_id, title, function, seniority, start_date, end_date, is_current, fact_status, source_object_id, created_at, updated_at").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null).order("start_date", { ascending: false, nullsFirst: false })),
    interactionsFor(ctx, "person", [personId]),
    q(ctx.db.from("contact_role_assessment").select("id, org_id, role_class, department, cre_relevance, reason, source, created_at").eq("workspace_id", ws).eq("person_id", personId).eq("active", true).is("archived_at", null)),
    q(ctx.db.from("stakeholder").select("id, role, influence_basis, requirement:requirement_id(id, title, org_id, status)").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null)),
    q(ctx.db.from("assistant_memory").select("id, category, content, source, stated, confidence, status, captured_at, last_verified_at, org_context_id").eq("workspace_id", ws).eq("entity_type", "person").eq("entity_id", personId).in("status", ["active", "outdated"]).is("archived_at", null).order("captured_at", { ascending: false }).limit(50)),
    q(ctx.db.from("meeting_visit").select("id, title, start_at").eq("workspace_id", ws).eq("linked_entity_type", "person").eq("linked_entity_id", personId).gte("start_at", new Date().toISOString()).neq("status", "cancelled").is("archived_at", null).order("start_at").limit(1)),
    q(ctx.db.from("relationship_edge").select("id, from_person_id, to_person_id, from_user_id, edge_type, warmth, strength_basis").eq("workspace_id", ws).is("archived_at", null).or(`from_person_id.eq.${personId},to_person_id.eq.${personId}`).limit(50)),
  ]);
  const orgNames = await labels(ctx, "organisation", [...emps.map((e) => e.org_id), ...stake.map((s) => s.requirement?.org_id)]);
  const isCurrent = (e: Row) => !!e.is_current && (!e.end_date || e.end_date >= today());
  const current = emps.filter(isCurrent), previous = emps.filter((e) => !isCurrent(e));
  const currentOrgs = new Set(current.map((e) => e.org_id));
  const emp = (e: Row): MemoryItem => item({
    entityId: personId, entityType: "person", category: "employment", label: orgNames.get(e.org_id) || "Company",
    value: { orgId: e.org_id, title: e.title, from: e.start_date, to: e.end_date },
    display: `${e.title ?? "Role unknown"} at ${orgNames.get(e.org_id) || "company"} (${e.start_date ?? "start unknown"} – ${isCurrent(e) ? "now" : e.end_date ?? "end unknown"})`,
    sourceRef: e.source_object_id ? { type: "source_object", id: e.source_object_id, label: "Source document", href: null } : { type: "employment", id: e.id, label: "Employment record", href: hrefFor("organisation", e.org_id) },
    observedAt: e.created_at, lastVerifiedAt: e.fact_status === "currently_confirmed" ? e.updated_at : null,
    verification: verificationOf(e.fact_status), related: [{ type: "organisation", id: e.org_id, label: orgNames.get(e.org_id) }],
    status: isCurrent(e) ? (e.fact_status === "ai_inference" ? "unverified" : "current") : "historical",
  });
  const designations = emps.filter((e) => e.title).map((e) => ({ ...emp(e), category: "designation", label: e.title, value: e.title, display: `${e.title} — ${orgNames.get(e.org_id) || "company"}` }));
  const decisionRoles: MemoryItem[] = [
    ...stake.map((s) => item({ entityId: personId, entityType: "person", category: "decision_role", label: s.role, value: s.role,
      display: `${s.role.replace(/_/g, " ")} on “${s.requirement?.title ?? "requirement"}”${s.influence_basis ? ` (${s.influence_basis})` : ""}`,
      sourceRef: { type: "stakeholder", id: s.id, label: "Buying-group record", href: s.requirement ? hrefFor("requirement", s.requirement.id) : null },
      observedAt: null, verification: s.influence_basis ? "reported" : "unverified", related: s.requirement ? [{ type: "requirement", id: s.requirement.id }] : [],
      status: s.requirement && currentOrgs.has(s.requirement.org_id) ? "current" : "historical" })),
    ...roles.map((r) => item({ entityId: personId, entityType: "person", category: "role_assessment", label: r.role_class ?? "role", value: r.role_class,
      display: `${(r.role_class ?? "unknown").replace(/_/g, " ")}${r.department ? `, ${r.department}` : ""}${r.reason ? ` — ${r.reason}` : ""}`,
      sourceRef: { type: "contact_role_assessment", id: r.id, label: r.source ?? "Role assessment", href: null }, observedAt: r.created_at,
      verification: r.source === "user" ? "reported" : "inferred", status: r.org_id && !currentOrgs.has(r.org_id) ? "historical" : "current" })),
  ];
  const preferences = mems.map((m) => item({ entityId: personId, entityType: "person", category: `memory.${m.category}`, label: m.category, value: m.content,
    sourceRef: { type: "assistant_memory", id: m.id, label: m.source, href: "/assistant/memory" }, observedAt: m.captured_at, lastVerifiedAt: m.last_verified_at,
    verification: m.stated ? "reported" : "inferred", confidence: Number(m.confidence),
    status: m.status === "outdated" ? "superseded" : m.org_context_id && !currentOrgs.has(m.org_context_id) ? "historical" : m.stated ? "current" : "unverified" }));

  const reqIds = [...new Set(stake.map((s) => s.requirement?.id).filter(Boolean))] as string[];
  const opps: Row[] = reqIds.length ? await q(ctx.db.from("opportunity").select("id, name, stage, outcome, org_id, requirement_id, updated_at").eq("workspace_id", ws).in("requirement_id", reqIds).is("archived_at", null)) : [];
  const withName: Row[] = opps.map((o) => ({ ...o, org_name: orgNames.get(o.org_id) ?? null }));
  const cur = current[0];
  const unknowns: string[] = [];
  if (!current.length) unknowns.push("Current employer");
  if (!cur?.title) unknowns.push("Current designation");
  if (!cur?.seniority) unknowns.push("Seniority");
  if (!decisionRoles.some((d) => d.status === "current")) unknowns.push("Decision-making role");
  if (!p.preferred_channel) unknowns.push("Preferred way to communicate");
  if (!ints.length) unknowns.push("Any interaction history");
  return {
    person: { id: p.id, name: p.full_name, aliases: p.aliases ?? [], preferredChannel: p.preferred_channel, preferredLanguage: p.preferred_language, doNotContact: !!p.do_not_contact, restrictions: p.contact_restrictions },
    currentEmployment: current.map(emp), previousEmployment: previous.map(emp), designations,
    seniority: cur?.seniority ?? null, department: cur?.function ?? roles[0]?.department ?? null, decisionRoles, preferences,
    interactions: ints, commitments: commitmentsFrom(ints), objections: objectionsFrom(ints),
    lastInteractionAt: ints[0]?.occurred_at ?? null,
    nextInteraction: nextMtg[0] ? { at: nextMtg[0].start_at, title: nextMtg[0].title ?? "Meeting", href: `/meetings/${nextMtg[0].id}` } : null,
    relationship: await assessRelationship(ctx, personId, ints),
    opportunities: withName.filter((o) => currentOrgs.has(o.org_id)),
    formerEmployerOpportunities: withName.filter((o) => !currentOrgs.has(o.org_id)),
    connections: edges, unknowns,
  };
}

export { interactionSource };
