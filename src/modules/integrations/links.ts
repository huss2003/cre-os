import "server-only";
import type { Db } from "@/lib/supabase/server";

/**
 * Link an email to organisations and open opportunities ONLY when evidence supports it (workflow 04).
 * Strong evidence: the matched contact's single current employment; a sender domain owned by exactly one organisation;
 * the contact being a stakeholder of exactly one open opportunity; an organisation with exactly one open opportunity.
 * Anything ambiguous (two orgs, employment vs domain disagreement, several open opportunities) is NOT linked —
 * it is returned as a suggestion for the user to confirm.
 */
export interface LinkEvidence { entity_type: "organisation" | "opportunity"; entity_id: string; basis: string; evidence: string }
export interface LinkSuggestion { entity_type: "organisation" | "opportunity"; entity_id: string; label: string; reason: string }
export interface LinkResult { orgIds: string[]; opportunityIds: string[]; evidence: LinkEvidence[]; suggestions: LinkSuggestion[] }

/** Free / ISP mailbox domains never identify an organisation. */
export const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "rediffmail.com", "zoho.com", "zohomail.in", "gmx.com",
  "mail.com", "yandex.com", "hey.com",
]);

export function senderDomain(address: string | null | undefined): string | null {
  const d = (address ?? "").trim().toLowerCase().split("@")[1];
  if (!d || !d.includes(".")) return null;
  return PUBLIC_MAIL_DOMAINS.has(d) ? null : d;
}

export interface OrgCandidate { id: string; name: string; via: "employment" | "email_domain"; detail: string }
export interface OppCandidate { id: string; name: string; org_id: string | null; via: "stakeholder" | "organisation"; detail: string }

/** Pure decision rule (unit-tested). */
export function decideLinks(orgs: OrgCandidate[], oppsFor: (orgIds: string[]) => OppCandidate[]): LinkResult {
  const out: LinkResult = { orgIds: [], opportunityIds: [], evidence: [], suggestions: [] };
  const byVia = (v: OrgCandidate["via"]) => [...new Map(orgs.filter((o) => o.via === v).map((o) => [o.id, o])).values()];
  const emp = byVia("employment");
  const dom = byVia("email_domain");
  let linked: OrgCandidate[] = [];
  if (emp.length === 1 && (dom.length === 0 || dom.some((d) => d.id === emp[0].id))) linked = [emp[0]];
  else if (emp.length === 0 && dom.length === 1) linked = [dom[0]];
  for (const o of linked) {
    out.orgIds.push(o.id);
    for (const c of orgs.filter((x) => x.id === o.id)) out.evidence.push({ entity_type: "organisation", entity_id: o.id, basis: c.via, evidence: c.detail });
  }
  if (!linked.length) {
    const all = [...new Map(orgs.map((o) => [o.id, o])).values()];
    const why = emp.length > 1 ? "contact has several current employers" : emp.length && dom.length ? "contact's employer and sender domain disagree" : "several organisations share this domain";
    if (all.length) for (const o of all) out.suggestions.push({ entity_type: "organisation", entity_id: o.id, label: o.name, reason: `${o.detail} — not linked: ${why}` });
  }
  const opps = oppsFor(out.orgIds);
  const uniq = (v: OppCandidate["via"]) => [...new Map(opps.filter((o) => o.via === v).map((o) => [o.id, o])).values()];
  const st = uniq("stakeholder");
  const org = uniq("organisation");
  const pick = st.length === 1 ? st[0] : st.length === 0 && org.length === 1 ? org[0] : null;
  if (pick) {
    out.opportunityIds.push(pick.id);
    out.evidence.push({ entity_type: "opportunity", entity_id: pick.id, basis: pick.via, evidence: pick.detail });
  } else {
    const all = [...new Map((st.length ? st : org).map((o) => [o.id, o])).values()];
    for (const o of all) out.suggestions.push({ entity_type: "opportunity", entity_id: o.id, label: o.name, reason: `${o.detail} — not linked: ${all.length} open opportunities match` });
  }
  return out;
}

export async function resolveLinks(db: Db, ws: string, p: { fromAddress: string | null; personIds: string[] }): Promise<LinkResult> {
  const orgs: OrgCandidate[] = [];
  if (p.personIds.length) {
    const { data } = await db.from("employment").select("person_id, org_id, title, organisation(display_name, legal_name)").eq("workspace_id", ws)
      .in("person_id", p.personIds).eq("is_current", true).is("archived_at", null);
    for (const e of data ?? []) {
      const o = e.organisation as unknown as { display_name: string | null; legal_name: string | null } | null;
      const name = o?.display_name ?? o?.legal_name ?? "organisation";
      orgs.push({ id: e.org_id, name, via: "employment", detail: `matched contact's current employment at ${name}${e.title ? ` (${e.title})` : ""}` });
    }
  }
  const domain = senderDomain(p.fromAddress);
  if (domain) {
    const { data } = await db.from("organisation").select("id, display_name, legal_name").eq("workspace_id", ws).eq("domain", domain).is("archived_at", null).limit(5);
    for (const o of data ?? []) orgs.push({ id: o.id, name: o.display_name ?? o.legal_name ?? domain, via: "email_domain", detail: `sender domain ${domain} is the organisation's domain` });
  }
  const opps: OppCandidate[] = [];
  if (p.personIds.length) {
    const { data: st } = await db.from("stakeholder").select("requirement_id").eq("workspace_id", ws).in("person_id", p.personIds).is("archived_at", null);
    const reqIds = [...new Set((st ?? []).map((s) => s.requirement_id as string).filter(Boolean))];
    if (reqIds.length) {
      const { data } = await db.from("opportunity").select("id, name, org_id").eq("workspace_id", ws).in("requirement_id", reqIds).eq("outcome", "open").is("archived_at", null);
      for (const o of data ?? []) opps.push({ id: o.id, name: o.name, org_id: o.org_id, via: "stakeholder", detail: `contact is a stakeholder on "${o.name}"` });
    }
  }
  const orgOpps = async (orgIds: string[]) => {
    if (!orgIds.length) return [] as OppCandidate[];
    const { data } = await db.from("opportunity").select("id, name, org_id").eq("workspace_id", ws).in("org_id", orgIds).eq("outcome", "open").is("archived_at", null).limit(20);
    return (data ?? []).map((o) => ({ id: o.id as string, name: o.name as string, org_id: o.org_id as string, via: "organisation" as const, detail: `open opportunity "${o.name}" of the linked organisation` }));
  };
  // decideLinks is synchronous: prefetch org opportunities for the org that would be linked
  const provisional = decideLinks(orgs, () => []);
  const extra = await orgOpps(provisional.orgIds);
  return decideLinks(orgs, () => [...opps, ...extra]);
}

/** Idempotent interaction_link insert (no unique index exists on the core table, so check first). */
export async function ensureInteractionLink(db: Db, ws: string, l: { interactionId: string; entityType: string; entityId: string; role: string; ownerUserId: string | null }) {
  const { data } = await db.from("interaction_link").select("id").eq("workspace_id", ws).eq("interaction_id", l.interactionId).eq("entity_type", l.entityType).eq("entity_id", l.entityId).limit(1);
  if (data?.[0]) return data[0].id as string;
  const { data: ins, error } = await db.from("interaction_link").insert({ workspace_id: ws, interaction_id: l.interactionId, entity_type: l.entityType, entity_id: l.entityId, role: l.role, owner_user_id: l.ownerUserId })
    .select("id").single();
  if (error) throw error;
  return ins.id as string;
}
