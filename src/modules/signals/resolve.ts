/**
 * Entity resolution (spec §6), deterministic. Order: approved external IDs → exact approved alias / exact name within the
 * workspace → multiple consistent identifiers → fuzzy suggestions (never auto-linked). Names alone never merge people;
 * similar company names never merge companies. Unresolved results carry candidates with reasons for the user to pick.
 */
import type { Db } from "@/lib/supabase/server";
import { normName } from "./engine";

type Row = Record<string, any>;
export type OrgMethod = "external_id" | "alias" | "exact_name" | "multiple_identifiers" | "ambiguous" | "none";
export interface Candidate { id: string; name: string; reasons: string[] }
export interface OrgResolution { orgId: string | null; method: OrgMethod; candidates: Candidate[]; reasons: string[]; rawName: string | null }

export interface OrgHints { name?: string | null; cin?: string | null; gstin?: string | null; crmExternalId?: string | null; domain?: string | null; url?: string | null }

const hostOf = (u?: string | null) => { try { return u ? new URL(u).hostname.replace(/^www\./, "").toLowerCase() : null; } catch { return null; } };
const NEWS_HOSTS = /(economictimes|livemint|moneycontrol|business-standard|thehindu|timesofindia|hindustantimes|reuters|bloomberg|news|example)\./i;
const qname = (s: string) => `"${s.replace(/["\\]/g, "")}"`;
const tokens = (s: string) => normName(s).split(" ").filter((t) => t.length >= 3);
/** Words shared by many company names: a match on these alone is weak evidence. */
export const GENERIC_TOKENS = new Set(["technologies", "technology", "tech", "systems", "system", "solutions", "solution", "services", "service", "pvt", "private", "ltd", "limited",
  "llp", "inc", "corp", "corporation", "company", "india", "indian", "global", "international", "group", "holdings", "software", "consulting", "consultants",
  "enterprises", "industries", "labs", "the", "and", "infotech", "digital", "networks", "ventures", "partners"]);
/** Shared-name score: a distinctive word counts 3, a generic word 1. */
export const tokenScore = (shared: string[]) => shared.reduce((n, t) => n + (GENERIC_TOKENS.has(t) ? 1 : 3), 0);

export async function resolveOrganisation(db: Db, ws: string, h: OrgHints): Promise<OrgResolution> {
  const raw = h.name?.trim() || null;
  const base = (from: Partial<OrgResolution>): OrgResolution => ({ orgId: null, method: "none", candidates: [], reasons: [], rawName: raw, ...from });
  const sel = "id, display_name, legal_name, domain, cin, gstin, crm_external_id";
  // 1. Approved external identifiers.
  for (const [col, v] of [["cin", h.cin], ["gstin", h.gstin], ["crm_external_id", h.crmExternalId]] as const) {
    if (!v) continue;
    const { data } = await db.from("organisation").select(sel).eq("workspace_id", ws).is("archived_at", null).eq(col, v.trim()).limit(2);
    if (data?.length === 1) return base({ orgId: data[0].id, method: "external_id", reasons: [`${col.toUpperCase()} ${v} matches ${data[0].display_name}.`] });
    if ((data?.length ?? 0) > 1) return base({ method: "ambiguous", candidates: data!.map((r: Row) => ({ id: r.id, name: r.display_name, reasons: [`Shares ${col} ${v}`] })), reasons: [`${data!.length} records share ${col} ${v} — choose one.`] });
  }
  // Company domain from hints or the source URL (news sites are not company domains).
  const dom = (h.domain?.toLowerCase().replace(/^www\./, "") || (hostOf(h.url) && !NEWS_HOSTS.test(hostOf(h.url)!) ? hostOf(h.url) : null)) ?? null;
  const domRows: Row[] = dom ? ((await db.from("organisation").select(sel).eq("workspace_id", ws).is("archived_at", null).eq("domain", dom).limit(3)).data ?? []) : [];
  if (!raw) {
    if (domRows.length === 1) return base({ orgId: domRows[0].id, method: "external_id", reasons: [`Company domain ${dom} matches ${domRows[0].display_name}.`] });
    return base({ reasons: ["No company name or identifier in the source."] });
  }
  // 2. Exact approved alias / exact record name within this workspace.
  const exact = (await db.from("organisation").select(sel).eq("workspace_id", ws).is("archived_at", null)
    .or(`display_name.ilike.${qname(raw)},legal_name.ilike.${qname(raw)}`).limit(3)).data ?? [];
  if (exact.length === 1) return base({ orgId: exact[0].id, method: "exact_name", reasons: [`Exact name match: ${exact[0].display_name}.`] });
  if (exact.length > 1) {
    // 3. Multiple consistent identifiers can break the tie (name + domain).
    const both = exact.filter((r: Row) => dom && r.domain === dom);
    if (both.length === 1) return base({ orgId: both[0].id, method: "multiple_identifiers", reasons: [`Name and domain ${dom} both match ${both[0].display_name}.`] });
    return base({ method: "ambiguous", candidates: exact.map((r: Row) => ({ id: r.id, name: r.display_name, reasons: ["Same name as another record — needs a second identifier."] })), reasons: [`${exact.length} companies have this exact name.`] });
  }
  const alias = (await db.from("entity_alias").select("entity_id").eq("workspace_id", ws).eq("entity_type", "organisation").eq("canonical_alias", normName(raw)).is("archived_at", null).limit(5)).data ?? [];
  const aliasIds = [...new Set(alias.map((a: Row) => a.entity_id))];
  if (aliasIds.length === 1) return base({ orgId: aliasIds[0], method: "alias", reasons: [`Approved alias “${raw}”.`] });
  if (domRows.length === 1 && tokens(raw).some((t) => normName(domRows[0].display_name).includes(t))) {
    return base({ orgId: domRows[0].id, method: "multiple_identifiers", reasons: [`Domain ${dom} and name token match ${domRows[0].display_name}.`] });
  }
  // 4. Fuzzy suggestions only.
  const cands = new Map<string, Candidate>();
  for (const r of domRows) cands.set(r.id, { id: r.id, name: r.display_name, reasons: [`Domain ${dom} matches, but the name differs.`] });
  for (const id of aliasIds) cands.set(id, { id, name: "(alias match)", reasons: ["One of several records using this alias."] });
  const toks = tokens(raw).sort((a, b) => Number(GENERIC_TOKENS.has(a)) - Number(GENERIC_TOKENS.has(b)));
  if (toks.length) {
    // One capped query per token (not one OR query): a generic word ("Technologies") matching hundreds of rows
    // must not crowd the distinctive word's matches out of a shared row cap.
    const seenIds = new Set<string>(); const pool: Row[] = [];
    for (const t of toks.slice(0, 4)) {
      const { data } = await db.from("organisation").select(sel).eq("workspace_id", ws).is("archived_at", null).ilike("display_name", `%${t.replace(/[%_,()]/g, "")}%`).order("display_name").order("id").limit(100);
      for (const r of (data ?? []) as Row[]) if (!seenIds.has(r.id)) { seenIds.add(r.id); pool.push(r); }
    }
    const fuzzy = pool
      .map((r: Row) => ({ r, n: tokenScore(toks.filter((t) => normName(r.display_name).split(" ").includes(t))) })).sort((a, b) => b.n - a.n).slice(0, 8).map((x) => x.r);
    for (const r of fuzzy) {
      const shared = toks.filter((t) => normName(r.display_name).split(" ").includes(t));
      if (!shared.length) continue;
      const c: Candidate = cands.get(r.id) ?? { id: r.id, name: r.display_name, reasons: [] };
      c.name = r.display_name;
      c.reasons.push(shared.every((t) => GENERIC_TOKENS.has(t))
        ? `Only shares the common word${shared.length > 1 ? "s" : ""} “${shared.join(", ")}” — weak match.`
        : `Shares name word${shared.length > 1 ? "s" : ""} “${shared.join(", ")}” — similar names are not merged automatically.`);
      (c as Candidate & { score?: number }).score = tokenScore(shared);
      cands.set(r.id, c);
    }
  }
  const list = [...cands.values()].sort((a, b) => ((b as { score?: number }).score ?? 99) - ((a as { score?: number }).score ?? 99)).slice(0, 6).map(({ id, name, reasons }) => ({ id, name, reasons }));
  return base({ method: aliasIds.length > 1 ? "ambiguous" : "none", candidates: list,
    reasons: [list.length ? `No exact match for “${raw}”; ${list.length} possible match(es) need your choice.` : `No company record matches “${raw}”.`] });
}

// ---------------------------------------------------------------- people

export type PersonMethod = "contact_method" | "name_and_employer" | "none" | "ambiguous";
export interface PersonResolution { personId: string | null; method: PersonMethod; candidates: Candidate[]; reasons: string[] }

/** A person's name alone NEVER resolves. Needs an exact email/phone on record, or exact name + current employer match. */
export async function resolvePerson(db: Db, ws: string, h: { name: string; email?: string | null; phone?: string | null; orgId?: string | null }): Promise<PersonResolution> {
  for (const v of [h.email, h.phone].filter(Boolean) as string[]) {
    const { data } = await db.from("contact_method").select("person_id").eq("workspace_id", ws).ilike("value", v.trim()).is("archived_at", null).limit(3);
    const ids = [...new Set((data ?? []).map((r: Row) => r.person_id))];
    if (ids.length === 1) return { personId: ids[0], method: "contact_method", candidates: [], reasons: [`Contact detail ${v} is on record for this person.`] };
  }
  const people = (await db.from("person").select("id, full_name").eq("workspace_id", ws).is("archived_at", null).ilike("full_name", h.name.trim().replace(/[%_]/g, "")).limit(5)).data ?? [];
  if (!people.length) return { personId: null, method: "none", candidates: [], reasons: [`No person named “${h.name}” on record.`] };
  const ids = people.map((p: Row) => p.id);
  const emps = (await db.from("employment").select("person_id, org_id, title, is_current, org:org_id(display_name)").eq("workspace_id", ws).in("person_id", ids).is("archived_at", null)).data ?? [];
  if (h.orgId) {
    const both = people.filter((p: Row) => emps.some((e: Row) => e.person_id === p.id && e.org_id === h.orgId));
    if (both.length === 1) return { personId: both[0].id, method: "name_and_employer", candidates: [], reasons: ["Exact name and an employment record at the same company."] };
  }
  return {
    personId: null, method: people.length > 1 ? "ambiguous" : "none",
    candidates: people.map((p: Row) => ({ id: p.id, name: p.full_name, reasons: [
      "Same name — a name alone never confirms identity.",
      ...emps.filter((e: Row) => e.person_id === p.id).slice(0, 2).map((e: Row) => `${e.is_current ? "Works" : "Worked"} at ${e.org?.display_name ?? "a company"}${e.title ? ` as ${e.title}` : ""}.`),
    ] })),
    reasons: ["Name match only; confirm with an email, phone or employer before linking."],
  };
}
