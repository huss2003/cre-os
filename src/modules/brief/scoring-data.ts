import "server-only";
import type { Db } from "@/lib/supabase/server";
import { stableHash } from "@/lib/util/crypto";
import { addDays } from "./dates";
import { fetchAll } from "./db";
import type { RadarItem } from "./lease-radar";
import { scoreLead, SCORE_VERSION, type EngagementInput, type RelationshipInput, type RequirementInput, type ScoreInput, type ScoreResult, type SignalInput } from "./scoring";
import type { BriefSettings } from "./settings";

const DECISION_MAKER = /\b(chief|c[efotx]o|cxo|vp|vice[- ]president|director|head|president|founder|partner|managing|gm|general manager)\b/i;
const SUPPRESS = /(do not contact|dnc|suppress|opt[- ]?out|no contact|unsubscribe)/i;
const TRACKING = /\b(opened|email open|tracking pixel|read receipt|link click(ed)?)\b/i;

export interface OrgScore { orgId: string; name: string; classification: string; ownerUserId: string | null; input: ScoreInput; result: ScoreResult }

function chunk<T>(a: T[], n = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

/** Gather evidence per organisation and score every organisation that has any scoring evidence (admin client). */
export async function computeScores(db: Db, workspaceId: string, today: string, settings: BriefSettings, radar: RadarItem[]): Promise<OrgScore[]> {
  const ws = (q: any) => q.eq("workspace_id", workspaceId).is("archived_at", null);
  const [orgs, reqs, signals, emps, edges, opps] = await Promise.all([
    fetchAll((f, t) => ws(db.from("organisation").select("id, display_name, contact_restrictions, classification, owner_user_id")).order("id").range(f, t)),
    fetchAll((f, t) => ws(db.from("requirement").select("id, org_id, status, area_min_sf, area_target_sf, area_max_sf, preferred_geography_ids, decision_date, occupation_date, budget_min, budget_max, confirmed_at, updated_at")).order("id").range(f, t)),
    fetchAll((f, t) => ws(db.from("signal_claim").select("subject_id, claim_type, status, evidence_tier, observed_on, published_on, expires_on, evidence_excerpt, source_url").eq("subject_type", "organisation")).order("id").range(f, t)),
    fetchAll((f, t) => ws(db.from("employment").select("person_id, org_id, title, seniority").eq("is_current", true)).order("id").range(f, t)),
    fetchAll((f, t) => ws(db.from("relationship_edge").select("to_person_id, from_user_id, from_person_id, warmth, intro_permission, last_meaningful_contact")).order("id").range(f, t)),
    fetchAll((f, t) => ws(db.from("opportunity").select("id, org_id, outcome, outcome_reason, stage, next_action, next_action_due, updated_at")).order("id").range(f, t)),
  ]);
  const since = addDays(today, -400);
  const interactions = await fetchAll((f, t) => ws(db.from("interaction").select("id, occurred_at, channel, direction, subject, summary, promises, is_meaningful, opportunity_id, source_message_id"))
    .gte("occurred_at", `${since}T00:00:00Z`).order("id").range(f, t));
  const links = interactions.length
    ? (await Promise.all(chunk(interactions.map((i) => i.id)).map(async (part) => {
        const { data } = await db.from("interaction_link").select("interaction_id, entity_type, entity_id").eq("workspace_id", workspaceId).in("interaction_id", part).in("entity_type", ["organisation", "person"]);
        return data ?? [];
      }))).flat()
    : [];
  const reqIds = reqs.map((r) => r.id);
  const stakeholders = reqIds.length
    ? (await Promise.all(chunk(reqIds).map(async (part) => {
        const { data } = await db.from("stakeholder").select("requirement_id, person_id, role").eq("workspace_id", workspaceId).is("archived_at", null).in("requirement_id", part);
        return data ?? [];
      }))).flat()
    : [];
  const personIds = [...new Set(emps.map((e) => e.person_id))];
  const [contacts, consents, persons] = personIds.length
    ? await Promise.all([
        Promise.all(chunk(personIds).map(async (p) => (await db.from("contact_method").select("person_id, suppressed").eq("workspace_id", workspaceId).is("archived_at", null).in("person_id", p)).data ?? [])).then((x) => x.flat()),
        Promise.all(chunk(personIds).map(async (p) => (await db.from("consent_permission").select("person_id, suppressed, revoked_at").eq("workspace_id", workspaceId).is("archived_at", null).in("person_id", p)).data ?? [])).then((x) => x.flat()),
        Promise.all(chunk(personIds).map(async (p) => (await db.from("person").select("id, full_name").eq("workspace_id", workspaceId).in("id", p)).data ?? [])).then((x) => x.flat()),
      ])
    : [[], [], []];

  // ---- indexes
  const group = <T, K>(rows: T[], key: (r: T) => K) => {
    const m = new Map<K, T[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return m;
  };
  const radarByOrg = group(radar.filter((r) => r.tenantOrgId), (r) => r.tenantOrgId!);
  const reqByOrg = group(reqs, (r) => r.org_id);
  const sigByOrg = group(signals, (s) => s.subject_id);
  const empByOrg = group(emps, (e) => e.org_id);
  const orgsByPerson = group(emps, (e) => e.person_id);
  const edgesByPerson = group(edges, (e) => e.to_person_id);
  const oppByOrg = group(opps, (o) => o.org_id);
  const stakeByReq = group(stakeholders, (s) => s.requirement_id);
  const contactsByPerson = group(contacts as any[], (c) => c.person_id);
  const consentByPerson = group(consents as any[], (c) => c.person_id);
  const personName = new Map((persons as any[]).map((p) => [p.id, p.full_name as string]));
  const oppById = new Map(opps.map((o) => [o.id, o]));

  const interById = new Map(interactions.map((i) => [i.id, i]));
  const interByOrg = new Map<string, Set<string>>();
  const addInter = (org: string, id: string) => interByOrg.set(org, (interByOrg.get(org) ?? new Set()).add(id));
  for (const l of links) {
    if (l.entity_type === "organisation") addInter(l.entity_id, l.interaction_id);
    else for (const e of orgsByPerson.get(l.entity_id) ?? []) addInter(e.org_id, l.interaction_id);
  }
  for (const i of interactions) {
    const o = i.opportunity_id ? oppById.get(i.opportunity_id) : null;
    if (o) addInter(o.org_id, i.id);
  }

  const out: OrgScore[] = [];
  for (const org of orgs) {
    const id = org.id as string;
    const orgRadar = radarByOrg.get(id) ?? [];
    const orgReqs = (reqByOrg.get(id) ?? []).filter((r) => r.status !== "closed")
      .sort((a, b) => Number(b.status === "client_confirmed") - Number(a.status === "client_confirmed") || (a.updated_at < b.updated_at ? 1 : -1));
    const orgSignals = sigByOrg.get(id) ?? [];
    const orgEmps = empByOrg.get(id) ?? [];
    const orgOpps = oppByOrg.get(id) ?? [];
    const orgInter = [...(interByOrg.get(id) ?? [])].map((x) => interById.get(x)!).filter(Boolean);
    if (!orgRadar.length && !orgReqs.length && !orgSignals.length && !orgEmps.length && !orgOpps.length && !orgInter.length) continue;

    const rq = orgReqs[0];
    const requirement: RequirementInput | null = rq ? {
      status: rq.status, hasArea: rq.area_min_sf != null || rq.area_target_sf != null || rq.area_max_sf != null,
      hasLocation: (rq.preferred_geography_ids ?? []).length > 0, decisionDate: rq.decision_date, occupationDate: rq.occupation_date,
      budgetSet: rq.budget_min != null || rq.budget_max != null, confirmedAt: rq.confirmed_at,
    } : null;
    const roles = new Set((rq ? stakeByReq.get(rq.id) ?? [] : []).map((s) => s.role as string));
    const decisionPath: ScoreInput["decisionPath"] = roles.has("approver") && (roles.has("finance") || roles.has("procurement"))
      ? "confirmed" : roles.has("approver") || roles.has("finance") || roles.has("procurement") ? "partial" : "unknown";
    const sponsorPersons = new Set((rq ? stakeByReq.get(rq.id) ?? [] : []).filter((s) => ["sponsor", "approver", "finance"].includes(s.role)).map((s) => s.person_id));

    const relationships: RelationshipInput[] = [];
    let knownContacts = 0;
    let suppressedPersons = 0;
    for (const e of orgEmps) {
      const pc = contactsByPerson.get(e.person_id) ?? [];
      const cons = consentByPerson.get(e.person_id) ?? [];
      const personSuppressed = cons.some((c: any) => c.suppressed || c.revoked_at) || (pc.length > 0 && pc.every((c: any) => c.suppressed));
      if (personSuppressed) { suppressedPersons++; continue; }
      knownContacts++;
      for (const edge of edgesByPerson.get(e.person_id) ?? []) {
        relationships.push({
          personName: personName.get(e.person_id) ?? null, warmth: edge.warmth,
          decisionMaker: sponsorPersons.has(e.person_id) || DECISION_MAKER.test(`${e.title ?? ""} ${e.seniority ?? ""}`),
          introPermission: !!edge.intro_permission, viaIntroducer: !edge.from_user_id && !!edge.from_person_id,
          lastMeaningfulContact: edge.last_meaningful_contact,
        });
      }
    }

    const engagements: EngagementInput[] = orgInter.map((i) => {
      const text = `${i.subject ?? ""} ${i.summary ?? ""}`;
      const tracking = TRACKING.test(text) || String(i.source_message_id ?? "").startsWith("tracking:");
      const opp = i.opportunity_id ? oppById.get(i.opportunity_id) : null;
      const nextStep = (Array.isArray(i.promises) && i.promises.length > 0) || (!!opp?.next_action_due && opp.next_action_due >= i.occurred_at.slice(0, 10));
      const kind: EngagementInput["kind"] = tracking ? "tracking_open"
        : i.direction === "inbound" && (i.channel === "email" || i.channel === "whatsapp" || i.channel === "linkedin") ? "reply"
        : ["call", "meeting", "visit", "whatsapp", "linkedin"].includes(i.channel) ? "conversation" : "other";
      return { at: i.occurred_at, kind, meaningful: !!i.is_meaningful && !tracking, hasNextStep: nextStep, summary: i.subject ?? null };
    });

    const disq = orgOpps.filter((o) => o.outcome === "disqualified").sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
    const restriction = org.contact_restrictions && SUPPRESS.test(org.contact_restrictions) ? org.contact_restrictions : null;
    const allSuppressed = orgEmps.length > 0 && suppressedPersons === orgEmps.length ? "all known contacts suppressed or consent revoked" : null;
    const activeLeaseArea = orgRadar.filter((r) => r.status === "active" && r.areaSf != null).map((r) => r.areaSf!);

    const input: ScoreInput = {
      subjectId: id, subjectName: org.display_name, today, radar: orgRadar, requirement,
      leaseAreaSf: activeLeaseArea.length ? Math.max(...activeLeaseArea) : null, fitBand: settings.fitBand,
      signals: orgSignals.map((s): SignalInput => ({
        claimType: s.claim_type, status: s.status, evidenceTier: s.evidence_tier, observedOn: s.observed_on, publishedOn: s.published_on,
        expiresOn: s.expires_on, excerpt: s.evidence_excerpt, sourceUrl: s.source_url,
      })),
      relationships, knownContacts, engagements, decisionPath,
      disqualified: disq ? disq.outcome_reason || "opportunity disqualified" : null,
      suppressed: restriction ?? allSuppressed,
    };
    out.push({ orgId: id, name: org.display_name, classification: org.classification, ownerUserId: org.owner_user_id, input, result: scoreLead(input) });
  }
  return out;
}

function scoreHash(r: ScoreResult): string {
  return stableHash({ t: r.total, tier: r.tier, o: r.overrides, c: r.components, e: r.evidenceConfidence, w: r.warmth });
}

/** Write lead_score rows: new current row only when the score changed; previous row keeps history (is_current=false). */
export async function persistScores(db: Db, workspaceId: string, scores: OrgScore[]): Promise<{ written: number; unchanged: number }> {
  const current = await fetchAll((f, t) => db.from("lead_score").select("id, subject_id, components, total, tier, overrides, evidence_confidence, warmth")
    .eq("workspace_id", workspaceId).eq("subject_type", "organisation").eq("is_current", true).eq("score_version", SCORE_VERSION).order("id").range(f, t));
  const bySubject = new Map(current.map((c) => [c.subject_id, c]));
  const changed: OrgScore[] = [];
  let unchanged = 0;
  for (const s of scores) {
    const c = bySubject.get(s.orgId);
    if (c && stableHash({ t: Number(c.total), tier: c.tier, o: c.overrides, c: c.components, e: c.evidence_confidence, w: c.warmth }) === scoreHash(s.result)) unchanged++;
    else changed.push(s);
  }
  for (const part of chunk(changed, 200)) {
    const oldIds = part.map((s) => bySubject.get(s.orgId)?.id).filter(Boolean) as string[];
    if (oldIds.length) {
      const { error } = await db.from("lead_score").update({ is_current: false }).eq("workspace_id", workspaceId).in("id", oldIds);
      if (error) throw error;
    }
    const { error } = await db.from("lead_score").insert(part.map((s) => ({
      workspace_id: workspaceId, subject_type: "organisation", subject_id: s.orgId, score_version: SCORE_VERSION,
      total: s.result.total, components: s.result.components, evidence_confidence: s.result.evidenceConfidence, warmth: s.result.warmth,
      tier: s.result.tier, overrides: s.result.overrides, is_current: true, classification: s.classification, owner_user_id: s.ownerUserId,
    })));
    if (error) throw error;
  }
  return { written: changed.length, unchanged };
}
