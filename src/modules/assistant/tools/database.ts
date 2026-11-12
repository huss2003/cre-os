/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { z } from "zod";
import { searchEntities } from "@/modules/admin/search";
import { getCompany, getPerson, getBuilding } from "@/modules/admin/entities";
import { getOpportunityDetail } from "@/modules/deals/pipeline/service";
import { missingQuestions, requirementCompleteness, type RequirementRow } from "@/modules/deals/requirements/contract";
import { edate } from "@/lib/util/time";
import { orgIdsWithLocationIn } from "../data/locations";
import type { Block, SourceRef, ToolContext, ToolResult } from "../types";
import {
  HREF, NOT_FOUND, clampLimit, daysBetween, db, defineTool, denied, factToStatus, fmt, getOne, ilikeSafe, isUuid,
  missingBlock, namesById, ref, sourcesBlock, today, ws, type Row,
  areaSf, factLabel,
} from "./shared";

const id = (what: string) => z.string().describe(`${what} id (uuid) from a previous search result`);
const limit = z.number().int().min(1).max(25).optional().describe("Max rows to return (1–25, default 10)");
const offset = z.number().int().min(0).optional().describe("Rows to skip, for paging (default 0)");

// ---------------------------------------------------------------------------------------------------- geography
/** All workspace geographies; resolve a free-text place to ids incl. descendants (micro-market, city, MIDC…). */
async function loadGeo(t: ToolContext) {
  const { data } = await db(t).from("geography").select("id, name, level, parent_id, aliases, lat, lon").eq("workspace_id", ws(t)).is("archived_at", null).limit(5000);
  const rows = (data ?? []) as Row[];
  const byId = new Map(rows.map((g) => [g.id, g]));
  const path = (gid: string | null | undefined): string[] => {
    const out: string[] = []; let cur = gid ? byId.get(gid) : null; let guard = 0;
    while (cur && guard++ < 10) { out.push(cur.name, ...((cur.aliases ?? []) as string[])); cur = cur.parent_id ? byId.get(cur.parent_id) : null; }
    return out;
  };
  const resolve = (text: string): Set<string> => {
    const q = text.trim().toLowerCase();
    const hits = rows.filter((g) => g.name.toLowerCase().includes(q) || ((g.aliases ?? []) as string[]).some((a) => a.toLowerCase().includes(q)));
    const ids = new Set<string>(hits.map((h) => h.id));
    let grew = true;
    while (grew) { grew = false; for (const g of rows) if (g.parent_id && ids.has(g.parent_id) && !ids.has(g.id)) { ids.add(g.id); grew = true; } }
    return ids;
  };
  return { byId, path, resolve };
}

// ---------------------------------------------------------------------------------------------------- companies
const searchCompanies = defineTool({
  id: "search_companies", module: "database", category: "A",
  description: "Find companies (organisations) in the CRM by name/alias/domain text, optionally filtered by sector or GCC flag. Returns ids, names, sector and links. Use before get_company_profile when you only have a name.",
  input: z.object({
    query: z.string().max(200).optional().describe("Name, alias or domain text. Omit to list companies matching the filters."),
    sector: z.string().max(100).optional().describe("Sector contains this text, e.g. 'IT services'"),
    isGcc: z.boolean().optional().describe("Only Global Capability Centres (true) or only non-GCC (false)"),
    limit, offset,
  }),
  async run(i, t) {
    const lim = clampLimit(i.limit); const off = i.offset ?? 0;
    let rows: Row[] = [];
    if (i.query?.trim()) {
      const hits = await searchEntities(db(t), ws(t), { q: i.query, types: ["organisation"], limit: 200 });
      const ids = hits.map((h) => h.id);
      if (ids.length) {
        const { data } = await db(t).from("organisation").select("id, display_name, legal_name, sector, domain, is_gcc, headcount_min, headcount_max").eq("workspace_id", ws(t)).in("id", ids);
        const order = new Map(ids.map((x, n) => [x, n]));
        rows = ((data ?? []) as Row[]).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      }
    } else {
      const { data } = await db(t).from("organisation").select("id, display_name, legal_name, sector, domain, is_gcc, headcount_min, headcount_max").eq("workspace_id", ws(t)).is("archived_at", null).order("display_name").limit(2000);
      rows = (data ?? []) as Row[];
    }
    if (i.sector) rows = rows.filter((r) => String(r.sector ?? "").toLowerCase().includes(i.sector!.toLowerCase()));
    if (i.isGcc !== undefined) rows = rows.filter((r) => r.is_gcc === i.isGcc);
    const total = rows.length; const page = rows.slice(off, off + lim);
    const entities = page.map((r) => ref("company", r.id, r.display_name, HREF.company(r.id)));
    return {
      ok: true, summary: `${total} compan${total === 1 ? "y" : "ies"} found`,
      data: { total, offset: off, items: page.map((r) => ({ id: r.id, name: r.display_name, sector: r.sector, domain: r.domain, isGcc: r.is_gcc, href: HREF.company(r.id) })) },
      entities,
      blocks: page.length ? [{ kind: "table", title: "Companies", columns: ["Company", "Sector", "Domain", "GCC"], rows: page.map((r) => [r.display_name, r.sector ?? null, r.domain ?? null, r.is_gcc === null ? null : r.is_gcc ? "Yes" : "No"]) }] : [],
      coverage: { checked: total, withData: total },
    };
  },
});

const getCompanyProfile = defineTool({
  id: "get_company_profile", module: "database", category: "A",
  description: "Full profile of one company: facts, office locations (from leases), contacts with roles, signals, recent interactions, requirements, opportunities, documents/analyses, and what is missing. Every fact carries its status (verified/reported/inferred).",
  input: z.object({ companyId: id("Company (organisation)") }),
  async run(i, t) {
    if (!isUuid(i.companyId)) return denied(t, "get_company_profile", { entity: "organisation", id: i.companyId });
    const c = await getCompany(db(t), ws(t), i.companyId);
    if (!c) return denied(t, "get_company_profile", { entity: "organisation", id: i.companyId });
    const o = c.org;
    const [{ data: roles }, { data: docs }, { data: analyses }, { data: scores }] = await Promise.all([
      db(t).from("contact_role_assessment").select("person_id, role_class, department, reason, source").eq("workspace_id", ws(t)).eq("org_id", o.id).eq("active", true),
      db(t).from("legal_document").select("id, title, doc_kind, status, updated_at").eq("workspace_id", ws(t)).eq("org_id", o.id).is("archived_at", null).limit(20),
      db(t).from("deal_analysis").select("id, kind, title, status, updated_at").eq("workspace_id", ws(t)).eq("org_id", o.id).is("archived_at", null).limit(20),
      db(t).from("score_result").select("model_key, score, band, confidence, recommended_action, calculated_at").eq("workspace_id", ws(t)).eq("entity_id", o.id).eq("is_current", true),
    ]);
    const roleBy = new Map(((roles ?? []) as Row[]).map((r) => [r.person_id, r]));
    const assetIds = c.leases.map((l: Row) => l.asset_id).filter(Boolean);
    const { data: assets } = assetIds.length ? await db(t).from("asset").select("id, name, address, locality_id, micro_market_id").eq("workspace_id", ws(t)).in("id", assetIds) : { data: [] };
    const geoNames = await namesById(t, "geography", ((assets ?? []) as Row[]).flatMap((a) => [a.locality_id, a.micro_market_id]));
    const locations = ((assets ?? []) as Row[]).map((a) => ({ assetId: a.id, building: a.name, address: a.address ?? null, area: [geoNames.get(a.micro_market_id), geoNames.get(a.locality_id)].filter(Boolean).join(", ") || null }));
    const contacts = c.people.filter((p: Row) => p.is_current).map((p: Row) => ({ personId: p.person_id, name: p.person_name, title: p.title, roleClass: roleBy.get(p.person_id)?.role_class ?? "unknown", status: factToStatus(p.fact_status) }));
    const missing: string[] = [];
    if (!o.sector) missing.push("Sector unknown");
    if (!o.domain) missing.push("Website/domain unknown");
    if (o.headcount_min == null && o.headcount_max == null) missing.push("Headcount unknown");
    if (!c.leases.length) missing.push("No lease on record (office location and expiry unknown)");
    else if (!c.leases.some((l: Row) => l.contractual_expiry)) missing.push("Lease expiry date unknown");
    if (!contacts.length) missing.push("No current contacts on record");
    if (!contacts.some((x: Row) => x.roleClass === "decision_maker")) missing.push("No identified decision-maker");
    if (!c.trail.some((x: Row) => x.kind === "interaction")) missing.push("No interactions logged");
    const interactions = c.trail.filter((x: Row) => x.kind === "interaction").slice(0, 8).map((x: Row) => ({ at: x.at, title: x.title, summary: x.detail ? String(x.detail).slice(0, 200) : null }));
    const signals = c.signals.slice(0, 8).map((s: Row) => ({ type: s.claim_type, predicate: s.predicate, status: factToStatus(s.status), observed: s.observed_on ?? s.published_on ?? null, source: s.source_url ?? null }));
    const sources: SourceRef[] = [
      { label: "Company record", href: HREF.company(o.id), observedAt: o.updated_at ?? null, status: factToStatus(o.source_confidence) },
      ...c.leases.slice(0, 5).map((l: Row) => ({ label: `Lease ${l.asset_name ?? ""}`.trim(), href: HREF.leases(), observedAt: l.updated_at ?? null, status: factToStatus(l.fact_status) })),
      ...signals.filter((s: Row) => s.source).slice(0, 5).map((s: Row) => ({ label: s.type, href: s.source, observedAt: s.observed, status: s.status })),
    ];
    const entity = ref("company", o.id, o.display_name, HREF.company(o.id));
    const blocks: Block[] = [
      { kind: "entity_card", entity, fields: [
        { label: "Legal name", value: fmt(o.legal_name) }, { label: "Sector", value: fmt(o.sector) }, { label: "Domain", value: fmt(o.domain) },
        { label: "Headcount", value: o.headcount_min || o.headcount_max ? `${o.headcount_min ?? "?"}–${o.headcount_max ?? "?"}` : null },
        { label: "GCC", value: o.is_gcc == null ? null : o.is_gcc ? "Yes" : "No" },
        { label: "Next action", value: c.nextAction ? `${c.nextAction.next_action}${c.nextAction.next_action_due ? ` (due ${c.nextAction.next_action_due})` : ""}` : null },
      ], sources: sources.slice(0, 1) },
    ];
    if (locations.length) blocks.push({ kind: "table", title: "Locations (from leases)", columns: ["Building", "Area", "Address"], rows: locations.map((l) => [l.building, l.area, l.address]) });
    if (c.leases.length) blocks.push({ kind: "table", title: "Leases", columns: ["Building", "Area (SF)", "Expiry", "Status"], rows: c.leases.map((l: Row) => [l.asset_name ?? l.tenant_name_raw ?? null, l.area_sf ?? null, l.contractual_expiry ?? null, l.fact_status ?? null]) });
    if (contacts.length) blocks.push({ kind: "table", title: "Contacts", columns: ["Name", "Title", "Role"], rows: contacts.map((x: Row) => [x.name, x.title ?? null, x.roleClass]) });
    blocks.push(...missingBlock(missing), ...sourcesBlock(sources));
    return {
      ok: true, summary: `Profile of ${o.display_name}`, entities: [entity], sources, missing, blocks,
      data: {
        id: o.id, name: o.display_name, legalName: o.legal_name, sector: o.sector, domain: o.domain, isGcc: o.is_gcc,
        headcount: { min: o.headcount_min, max: o.headcount_max }, accountNote: o.account_owner_note ?? null, contactRestrictions: o.contact_restrictions ?? null,
        locations, leases: c.leases.map((l: Row) => ({ id: l.id, building: l.asset_name, areaSf: l.area_sf, rentPerSf: l.rent_per_sf, start: l.start_date, expiry: l.contractual_expiry, status: l.fact_status })),
        contacts, signals, interactions,
        requirements: c.requirements.map((r: Row) => ({ id: r.id, title: r.title, status: r.status, href: HREF.requirement(r.id) })),
        opportunities: c.opportunities.map((p: Row) => ({ id: p.id, name: p.name, stage: p.stage, nextAction: p.next_action, nextActionDue: p.next_action_due, href: HREF.opportunity(p.id) })),
        documents: [...((docs ?? []) as Row[]).map((d) => ({ id: d.id, type: "legal_document", title: d.title, kind: d.doc_kind, href: HREF.legal(d.id) })), ...((analyses ?? []) as Row[]).map((a) => ({ id: a.id, type: "analysis", title: a.title, kind: a.kind, href: HREF.analysis(a.kind, a.id) }))],
        scores: (scores ?? []) as Row[], openTasks: c.tasks.filter((x: Row) => x.status === "open").slice(0, 10).map((x: Row) => ({ title: x.title, due: x.due_at })),
        href: HREF.company(o.id),
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------------- contacts
const searchContacts = defineTool({
  id: "search_contacts", module: "contacts", category: "A",
  description: "Find people/contacts by name or alias, optionally only those currently at a given company. Returns current employer and title.",
  input: z.object({
    query: z.string().max(200).optional().describe("Person name or alias text"),
    companyId: z.string().optional().describe("Only people currently employed at this company id"),
    limit, offset,
  }),
  async run(i, t) {
    const lim = clampLimit(i.limit); const off = i.offset ?? 0;
    let personIds: string[] | null = null;
    if (i.query?.trim()) personIds = (await searchEntities(db(t), ws(t), { q: i.query, types: ["person"], limit: 200 })).map((h) => h.id);
    if (i.companyId) {
      if (!isUuid(i.companyId) || !(await getOne(t, "organisation", i.companyId, "id"))) return denied(t, "search_contacts", { entity: "organisation", id: i.companyId });
      const { data } = await db(t).from("employment").select("person_id").eq("workspace_id", ws(t)).eq("org_id", i.companyId).eq("is_current", true).is("archived_at", null);
      const at = new Set(((data ?? []) as Row[]).map((e) => e.person_id));
      personIds = personIds ? personIds.filter((p) => at.has(p)) : [...at];
    }
    let people: Row[];
    if (personIds) {
      if (!personIds.length) people = [];
      else people = ((await db(t).from("person").select("id, full_name, do_not_contact").eq("workspace_id", ws(t)).in("id", personIds.slice(0, 500))).data ?? []) as Row[];
    } else {
      people = ((await db(t).from("person").select("id, full_name, do_not_contact").eq("workspace_id", ws(t)).is("archived_at", null).order("full_name").limit(500)).data ?? []) as Row[];
    }
    const total = people.length; const page = people.slice(off, off + lim);
    const { data: emp } = page.length ? await db(t).from("employment").select("person_id, org_id, title, fact_status").eq("workspace_id", ws(t)).eq("is_current", true).in("person_id", page.map((p) => p.id)) : { data: [] };
    const orgNames = await namesById(t, "organisation", ((emp ?? []) as Row[]).map((e) => e.org_id));
    const empBy = new Map(((emp ?? []) as Row[]).map((e) => [e.person_id, e]));
    const items = page.map((p) => { const e = empBy.get(p.id); return { id: p.id, name: p.full_name, title: e?.title ?? null, companyId: e?.org_id ?? null, company: e ? orgNames.get(e.org_id) ?? null : null, doNotContact: !!p.do_not_contact, href: HREF.person(p.id) }; });
    return {
      ok: true, summary: `${total} contact${total === 1 ? "" : "s"} found`, data: { total, offset: off, items },
      entities: items.map((x) => ref("person", x.id, x.name, x.href)),
      blocks: items.length ? [{ kind: "table", title: "Contacts", columns: ["Name", "Title", "Company", "Do not contact"], rows: items.map((x) => [x.name, x.title, x.company, x.doNotContact ? "Yes" : null]) }] : [],
      coverage: { checked: total, withData: items.filter((x) => x.companyId).length, note: "withData = people with a current employer on record (this page)" },
    };
  },
});

const getContactProfile = defineTool({
  id: "get_contact_profile", module: "contacts", category: "A",
  description: "Full profile of one person: employment history, contact channels (with verification + suppression), relationships/intro paths, stakeholder roles, signals and interactions.",
  input: z.object({ personId: id("Person") }),
  async run(i, t) {
    if (!isUuid(i.personId)) return denied(t, "get_contact_profile", { entity: "person", id: i.personId });
    const p = await getPerson(db(t), ws(t), i.personId);
    if (!p) return denied(t, "get_contact_profile", { entity: "person", id: i.personId });
    const pr = p.person as Row; const pp = p as Row;
    const { data: role } = await db(t).from("contact_role_assessment").select("role_class, department, reason, source").eq("workspace_id", ws(t)).eq("person_id", pr.id).eq("active", true).limit(3);
    const { data: methods } = await db(t).from("contact_method").select("method_type, value, verify_status, suppressed, preferred, observed_on").eq("workspace_id", ws(t)).eq("person_id", pr.id).is("archived_at", null);
    const employment = (pp.employment as Row[]).map((e) => ({ company: e.org_name, companyId: e.org_id, title: e.title, current: e.is_current, start: e.start_date, end: e.end_date, status: factToStatus(e.fact_status) }));
    const channels = ((methods ?? []) as Row[]).map((m) => ({ type: m.method_type, value: m.suppressed ? "(suppressed)" : m.value, verify: m.verify_status ?? "unverified", preferred: m.preferred, suppressed: m.suppressed }));
    const missing: string[] = [];
    if (!employment.some((e) => e.current)) missing.push("Current employer unknown");
    if (!channels.some((c) => !c.suppressed)) missing.push("No usable contact channel");
    if (!(role ?? []).length) missing.push("Role in office decisions not assessed");
    const entity = ref("person", pr.id, pr.full_name, HREF.person(pr.id));
    const cur = employment.find((e) => e.current);
    const interactions = ((pp.interactions ?? []) as Row[]).slice(0, 8).map((x) => ({ at: x.occurred_at, channel: x.channel, subject: x.subject, summary: x.summary ? String(x.summary).slice(0, 200) : null }));
    return {
      ok: true, summary: `Profile of ${pr.full_name}`, entities: [entity], missing,
      data: {
        id: pr.id, name: pr.full_name, doNotContact: !!pr.do_not_contact, preferredChannel: pr.preferred_channel, preferredLanguage: pr.preferred_language,
        restrictions: pr.contact_restrictions, employment, channels, roles: role ?? [],
        stakeholderRoles: ((pp.stakeholderRoles ?? []) as Row[]).map((s) => ({ requirement: s.requirement_title, role: s.role, company: s.org_name })),
        relationships: ((pp.relationships ?? []) as Row[]).map((r) => ({ counterpart: r.counterpart, warmth: r.warmth, type: r.edge_type, direction: r.direction })),
        introPaths: ((pp.introPaths ?? []) as Row[]).length, interactions, href: HREF.person(pr.id),
      },
      blocks: [
        { kind: "entity_card", entity, fields: [
          { label: "Current role", value: cur ? `${cur.title ?? "Title unknown"} at ${cur.company ?? "?"}` : null, status: cur?.status },
          { label: "Role class", value: (role ?? [])[0]?.role_class ?? null },
          { label: "Do not contact", value: pr.do_not_contact ? "Yes" : "No" },
          { label: "Channels", value: channels.map((c) => `${c.type} (${c.verify}${c.suppressed ? ", suppressed" : ""})`).join("; ") || null },
        ] },
        ...missingBlock(missing),
      ],
      sources: [{ label: "Person record", href: HREF.person(pr.id), observedAt: pr.updated_at ?? null, status: "verified" }],
    };
  },
});

// ---------------------------------------------------------------------------------------------------- properties
const searchProperties = defineTool({
  id: "search_properties", module: "database", category: "A",
  description: "Search spaces in buildings with their latest availability snapshot. Filters: place (micro-market/locality/city name, includes sub-areas), area range in SF, asking rent range (₹/SF/month), availability status. Rent and vacancy are only what was recorded — unknown rent is never treated as matching a rent filter (see coverage).",
  input: z.object({
    place: z.string().max(100).optional().describe("Micro-market, locality or city name, e.g. 'Kharadi', 'Baner', 'Pune'"),
    minAreaSf: z.number().optional().describe("Minimum space area in SF (chargeable, else carpet)"),
    maxAreaSf: z.number().optional().describe("Maximum space area in SF"),
    minRent: z.number().optional().describe("Minimum asking rent ₹/SF/month"),
    maxRent: z.number().optional().describe("Maximum asking rent ₹/SF/month"),
    status: z.enum(["available", "under_offer", "leased", "any"]).optional().describe("Latest availability status (default available)"),
    buildingQuery: z.string().max(100).optional().describe("Building name contains"),
    limit, offset,
  }),
  async run(i, t) {
    const lim = clampLimit(i.limit); const off = i.offset ?? 0; const status = i.status ?? "available";
    const geo = await loadGeo(t);
    let q = db(t).from("asset").select("id, name, address, grade, locality_id, micro_market_id, lat, lon").eq("workspace_id", ws(t)).is("archived_at", null).limit(2000);
    if (i.buildingQuery) q = q.ilike("name", `%${ilikeSafe(i.buildingQuery)}%`);
    let assets = ((await q).data ?? []) as Row[];
    const missing: string[] = [];
    if (i.place) {
      const ids = geo.resolve(i.place);
      if (!ids.size) missing.push(`No geography named like "${i.place}" in this workspace; matched on building address only`);
      const needle = i.place.toLowerCase();
      assets = assets.filter((a) => ids.has(a.micro_market_id) || ids.has(a.locality_id) || String(a.address ?? "").toLowerCase().includes(needle));
    }
    const assetBy = new Map(assets.map((a) => [a.id, a]));
    const spaces: Row[] = [];
    const aids = [...assetBy.keys()];
    for (let k = 0; k < aids.length; k += 150) {
      const { data } = await db(t).from("space").select("id, asset_id, floor_text, unit, carpet_sf, chargeable_sf, seats").eq("workspace_id", ws(t)).is("archived_at", null).in("asset_id", aids.slice(k, k + 150));
      spaces.push(...((data ?? []) as Row[]));
    }
    const area = (s: Row) => (s.chargeable_sf ?? s.carpet_sf) as number | null;
    let cands = spaces.filter((s) => {
      const a = area(s) === null ? null : Number(area(s));
      if (i.minAreaSf !== undefined && (a === null || a < i.minAreaSf)) return false;
      if (i.maxAreaSf !== undefined && (a === null || a > i.maxAreaSf)) return false;
      return true;
    });
    const areaUnknown = (i.minAreaSf !== undefined || i.maxAreaSf !== undefined) ? spaces.filter((s) => area(s) === null).length : 0;
    const latest = new Map<string, Row>();
    const sids = cands.map((s) => s.id);
    for (let k = 0; k < sids.length; k += 150) {
      const { data } = await db(t).from("availability").select("id, space_id, as_of, status, available_from, asking_rent_min, asking_rent_max, rent_basis, fact_status, valid_until").eq("workspace_id", ws(t)).is("archived_at", null).in("space_id", sids.slice(k, k + 150)).order("as_of", { ascending: false });
      for (const r of (data ?? []) as Row[]) if (!latest.has(r.space_id)) latest.set(r.space_id, r);
    }
    const checked = cands.length;
    if (status !== "any") cands = cands.filter((s) => latest.get(s.id)?.status === status);
    const rentFilter = i.minRent !== undefined || i.maxRent !== undefined;
    let rentUnknown = 0;
    if (rentFilter) {
      cands = cands.filter((s) => {
        const av = latest.get(s.id);
        const lo = av?.asking_rent_min ?? av?.asking_rent_max; const hi = av?.asking_rent_max ?? av?.asking_rent_min;
        if (lo == null || hi == null) { rentUnknown++; return false; }
        if (i.minRent !== undefined && Number(hi) < i.minRent) return false;
        if (i.maxRent !== undefined && Number(lo) > i.maxRent) return false;
        return true;
      });
    }
    const noAvail = spaces.length ? [...sids].filter((x) => !latest.has(x)).length : 0;
    if (noAvail) missing.push(`${noAvail} matching space(s) have no availability snapshot (vacancy unknown)`);
    if (rentUnknown) missing.push(`${rentUnknown} space(s) excluded because asking rent is unknown`);
    if (areaUnknown) missing.push(`${areaUnknown} space(s) excluded because area is unknown`);
    const total = cands.length; const page = cands.slice(off, off + lim);
    const items = page.map((s) => {
      const a = assetBy.get(s.asset_id)!; const av = latest.get(s.id);
      const stale = av?.valid_until ? av.valid_until < today() : av ? daysBetween(av.as_of, today()) > 45 : true;
      return {
        spaceId: s.id, assetId: a.id, building: a.name, floor: s.floor_text, unit: s.unit, areaSf: area(s), areaBasis: s.chargeable_sf != null ? "chargeable" : s.carpet_sf != null ? "carpet" : null, seats: s.seats,
        microMarket: geo.byId.get(a.micro_market_id)?.name ?? geo.byId.get(a.locality_id)?.name ?? null,
        availability: av ? { status: av.status, asOf: av.as_of, availableFrom: av.available_from, rentMin: av.asking_rent_min, rentMax: av.asking_rent_max, rentBasis: av.rent_basis, factStatus: av.fact_status, stale } : null,
        href: HREF.asset(a.id),
      };
    });
    const sources: SourceRef[] = items.filter((x) => x.availability).slice(0, 10).map((x) => ({ label: `Availability ${x.building}`, href: x.href, observedAt: x.availability!.asOf, status: x.availability!.stale ? "unknown" : factToStatus(x.availability!.factStatus) }));
    return {
      ok: true, summary: `${total} space${total === 1 ? "" : "s"} match`, data: { total, offset: off, items }, sources, missing,
      entities: [...new Map(items.map((x) => [x.assetId, ref("asset", x.assetId, x.building, x.href)])).values()],
      coverage: { checked, withData: total, note: missing.join("; ") || undefined },
      blocks: [
        ...(items.length ? [{ kind: "table" as const, title: "Spaces", columns: ["Building", "Micro-market", "Floor", "Area (SF)", "Rent ₹/SF/mo", "Status", "As of"], rows: items.map((x) => [x.building, x.microMarket, x.floor ?? null, x.areaSf ?? null, x.availability?.rentMin != null || x.availability?.rentMax != null ? `${x.availability?.rentMin ?? "?"}–${x.availability?.rentMax ?? "?"}` : null, x.availability?.status ?? "unknown", x.availability?.asOf ?? null]), note: "Rent and status as last recorded; stale snapshots are not verified vacancy." }] : []),
        ...missingBlock(missing), ...sourcesBlock(sources),
      ],
    };
  },
});

const getPropertyDetails = defineTool({
  id: "get_property_details", module: "database", category: "A",
  description: "Details of one building (asset) or the building of a space: spaces with latest availability and its verification, leases/tenants, transactions, locality and coordinates.",
  input: z.object({ assetId: z.string().optional().describe("Building (asset) id"), spaceId: z.string().optional().describe("Space id (its building is returned)") }).refine((v) => v.assetId || v.spaceId, "assetId or spaceId is required"),
  async run(i, t) {
    let assetId = i.assetId ?? null;
    if (!assetId && i.spaceId) { const s = isUuid(i.spaceId) ? await getOne(t, "space", i.spaceId, "asset_id") : null; assetId = s?.asset_id ?? null; }
    if (!assetId || !isUuid(assetId)) return denied(t, "get_property_details", { entity: "asset", id: i.assetId ?? i.spaceId });
    const b = await getBuilding(db(t), ws(t), assetId);
    if (!b) return denied(t, "get_property_details", { entity: "asset", id: assetId });
    const a = b.asset;
    const entity = ref("asset", a.id, a.name, HREF.asset(a.id));
    const spaces = (b.spaces as Row[]).map((s) => ({ id: s.id, floor: s.floor_text, unit: s.unit, carpetSf: s.carpet_sf, chargeableSf: s.chargeable_sf, seats: s.seats, state: s.state, latest: s.latest ? { status: s.latest.status, asOf: s.latest.as_of, rentMin: s.latest.asking_rent_min, rentMax: s.latest.asking_rent_max, factStatus: s.latest.fact_status } : null }));
    const missing: string[] = [];
    if (a.lat == null || a.lon == null) missing.push("Coordinates not recorded (distance unknown)");
    if (!spaces.length) missing.push("No spaces recorded");
    if (spaces.length && !spaces.some((s) => s.latest)) missing.push("No availability evidence");
    return {
      ok: true, summary: `Building ${a.name}`, entities: [entity], missing,
      data: { id: a.id, name: a.name, address: a.address, grade: a.grade, locality: b.locality, totalAreaSf: a.total_area_sf, floors: a.floors, lat: a.lat, lon: a.lon, certifications: a.certifications, spaces, leases: (b.leases as Row[]).map((l) => ({ tenant: l.tenant_name, expiry: l.contractual_expiry, areaSf: l.area_sf, status: l.fact_status })), href: HREF.asset(a.id) },
      blocks: [
        { kind: "entity_card", entity, fields: [{ label: "Locality", value: fmt(b.locality) }, { label: "Grade", value: fmt(a.grade) }, { label: "Address", value: fmt(a.address) }, { label: "Total area (SF)", value: fmt(a.total_area_sf) }] },
        ...(spaces.length ? [{ kind: "table" as const, title: "Spaces", columns: ["Floor", "Chargeable SF", "Status", "Rent ₹/SF/mo", "As of"], rows: spaces.map((s) => [s.floor ?? null, s.chargeableSf ?? null, s.state ?? null, s.latest ? `${s.latest.rentMin ?? "?"}–${s.latest.rentMax ?? "?"}` : null, s.latest?.asOf ?? null]) }] : []),
        ...missingBlock(missing),
      ],
      sources: [{ label: "Building record", href: HREF.asset(a.id), observedAt: a.updated_at ?? null, status: "verified" }],
    };
  },
});

// ---------------------------------------------------------------------------------------------------- requirements
const searchRequirements = defineTool({
  id: "search_requirements", module: "database", category: "A",
  description: "List occupier requirements, filtered by text in the title, company or status.",
  input: z.object({
    query: z.string().max(200).optional().describe("Text in the requirement title"),
    companyId: z.string().optional().describe("Only requirements of this company"),
    status: z.string().max(40).optional().describe("Requirement status, e.g. draft, estimated, client_confirmed, closed"),
    includeClosed: z.boolean().optional().describe("Include closed requirements (default false)"),
    limit, offset,
  }),
  async run(i, t) {
    const lim = clampLimit(i.limit); const off = i.offset ?? 0;
    let q = db(t).from("requirement").select("id, title, status, org_id, seats_target, area_target_sf, area_min_sf, area_max_sf, budget_max, budget_basis, occupation_date, updated_at", { count: "exact" }).eq("workspace_id", ws(t)).is("archived_at", null);
    if (i.query) q = q.ilike("title", `%${ilikeSafe(i.query)}%`);
    if (i.companyId) q = q.eq("org_id", i.companyId);
    if (i.status) q = q.eq("status", i.status); else if (!i.includeClosed) q = q.neq("status", "closed");
    const { data, count } = await q.order("updated_at", { ascending: false }).range(off, off + lim - 1);
    const rows = (data ?? []) as Row[];
    const orgs = await namesById(t, "organisation", rows.map((r) => r.org_id));
    const items = rows.map((r) => ({ id: r.id, title: r.title, company: orgs.get(r.org_id) ?? null, status: r.status, seats: r.seats_target, areaSf: r.area_target_sf ?? (r.area_min_sf || r.area_max_sf ? `${r.area_min_sf ?? "?"}–${r.area_max_sf ?? "?"}` : null), budgetMax: r.budget_max, budgetBasis: r.budget_basis, occupation: r.occupation_date, href: HREF.requirement(r.id) }));
    return {
      ok: true, summary: `${count ?? items.length} requirement(s)`, data: { total: count ?? items.length, offset: off, items },
      entities: items.map((x) => ref("requirement", x.id, x.title, x.href)),
      coverage: { checked: count ?? items.length, withData: count ?? items.length },
      blocks: items.length ? [{ kind: "table", title: "Requirements", columns: ["Requirement", "Company", "Status", "Seats", "Area SF", "Move-in"], rows: items.map((x) => [x.title, x.company, x.status, x.seats ?? null, x.areaSf ?? null, x.occupation ?? null]) }] : [],
    };
  },
});

const getRequirementDetails = defineTool({
  id: "get_requirement_details", module: "database", category: "A",
  description: "Everything about one requirement: fields with their status (client-confirmed/reported/estimated/unknown), completeness, missing questions, stakeholders, shortlist options incl. REJECTED options with their reasons (disqualifiers, client feedback from meetings), change history and open tasks.",
  input: z.object({ requirementId: id("Requirement") }),
  async run(i, t) {
    const r = isUuid(i.requirementId) ? await getOne(t, "requirement", i.requirementId) : null;
    if (!r) return denied(t, "get_requirement_details", { entity: "requirement", id: i.requirementId });
    const [{ data: st }, { data: opts }, { data: hist }, { data: tasks }, { data: preps }] = await Promise.all([
      db(t).from("stakeholder").select("person_id, role, access_status, influence_basis").eq("workspace_id", ws(t)).eq("requirement_id", r.id).is("archived_at", null),
      db(t).from("shortlist_option").select("id, asset_id, space_id, version, eligible, disqualifiers, fit_score, option_status, updated_at").eq("workspace_id", ws(t)).eq("requirement_id", r.id).is("archived_at", null).order("version", { ascending: false }).limit(200),
      db(t).from("requirement_version").select("version, change_reason, created_at, change_proposal_id").eq("workspace_id", ws(t)).eq("requirement_id", r.id).order("version", { ascending: false }).limit(15),
      db(t).from("task").select("title, due_at, status").eq("workspace_id", ws(t)).eq("linked_entity_type", "requirement").eq("linked_entity_id", r.id).in("status", ["open", "snoozed"]).limit(20),
      db(t).from("meeting_prep").select("id").eq("workspace_id", ws(t)).eq("requirement_id", r.id).limit(50),
    ]);
    const prepIds = ((preps ?? []) as Row[]).map((p) => p.id);
    const { data: fb } = prepIds.length ? await db(t).from("meeting_property_feedback").select("asset_id, fields, updated_at, prep_id").eq("workspace_id", ws(t)).in("prep_id", prepIds) : { data: [] };
    const optRows = (opts ?? []) as Row[];
    const latestV = optRows.length ? Math.max(...optRows.map((o) => o.version ?? 0)) : null;
    const assetNames = await namesById(t, "asset", [...optRows.map((o) => o.asset_id), ...((fb ?? []) as Row[]).map((f) => f.asset_id)]);
    const people = await namesById(t, "person", ((st ?? []) as Row[]).map((s) => s.person_id));
    const orgName = (await namesById(t, "organisation", [r.org_id])).get(r.org_id) ?? null;
    const feedback = ((fb ?? []) as Row[]).map((f) => ({ building: assetNames.get(f.asset_id) ?? null, interest: f.fields?.interest ?? null, explicitRejection: !!f.fields?.explicit_rejection, notes: f.fields?.notes ?? null, at: f.updated_at }));
    const rejected = [
      ...optRows.filter((o) => o.option_status === "rejected").map((o) => ({ building: assetNames.get(o.asset_id) ?? null, reason: (o.disqualifiers ?? []).join("; ") || "Marked rejected (no reason recorded)", source: "shortlist", at: o.updated_at })),
      ...optRows.filter((o) => o.version === latestV && o.eligible === false && o.option_status !== "rejected").map((o) => ({ building: assetNames.get(o.asset_id) ?? null, reason: `Ineligible: ${(o.disqualifiers ?? []).join("; ")}`, source: "matching", at: o.updated_at })),
      ...feedback.filter((f) => f.interest === "rejected").map((f) => ({ building: f.building, reason: `${f.explicitRejection ? "Client explicitly said no" : "Negative feedback"}${f.notes ? `: ${f.notes}` : ""}`, source: "meeting feedback", at: f.at })),
    ];
    const missingQ = missingQuestions(r as RequirementRow);
    const comp = requirementCompleteness(r as RequirementRow);
    const fs = (r.constraints?.field_status ?? {}) as Record<string, string>;
    const entity = ref("requirement", r.id, r.title, HREF.requirement(r.id));
    const missing = missingQ.filter((q) => q.priority === "mandatory").map((q) => `${q.label}: ${q.reason === "missing" ? "unknown" : "estimated, needs client confirmation"}`);
    return {
      ok: true, summary: `Requirement ${r.title}`, entities: [entity, ...(r.org_id ? [ref("company", r.org_id, orgName, HREF.company(r.org_id))] : [])], missing,
      data: {
        id: r.id, title: r.title, company: orgName, companyId: r.org_id, status: r.status, objective: r.objective,
        fields: { areaSf: { min: r.area_min_sf, target: r.area_target_sf, max: r.area_max_sf, basis: r.area_basis }, seats: { min: r.seats_min, target: r.seats_target, max: r.seats_max }, budget: { min: r.budget_min, max: r.budget_max, basis: r.budget_basis }, decisionDate: r.decision_date, occupationDate: r.occupation_date, transactionKinds: r.transaction_kinds },
        fieldStatus: fs, completeness: comp, missingQuestions: missingQ.slice(0, 12),
        stakeholders: ((st ?? []) as Row[]).map((s) => ({ name: people.get(s.person_id) ?? null, personId: s.person_id, role: s.role, access: s.access_status })),
        options: optRows.filter((o) => o.version === latestV).map((o) => ({ building: assetNames.get(o.asset_id) ?? null, status: o.option_status, eligible: o.eligible, fit: o.fit_score })),
        rejected, feedback, history: (hist ?? []) as Row[], openTasks: (tasks ?? []) as Row[], href: HREF.requirement(r.id),
      },
      blocks: [
        { kind: "entity_card", entity, fields: [
          { label: "Company", value: orgName }, { label: "Status", value: fmt(r.status) },
          { label: "Seats", value: fmt(r.seats_target), status: factToStatus(fs.seats_target ?? fs.seats) },
          { label: "Area (SF)", value: r.area_target_sf ?? (r.area_min_sf || r.area_max_sf) ? `${r.area_min_sf ?? "?"}–${r.area_max_sf ?? "?"} (target ${r.area_target_sf ?? "?"})` : null },
          { label: "Budget", value: r.budget_max != null ? `${r.budget_min ?? "?"}–${r.budget_max} ${r.budget_basis ?? ""}`.trim() : null },
          { label: "Move-in", value: fmt(r.occupation_date) }, { label: "Completeness", value: `${comp.percentKnown}% known, ${comp.percentConfirmed}% confirmed` },
        ] },
        ...(rejected.length ? [{ kind: "table" as const, title: "Rejected options", columns: ["Building", "Reason", "Source", "When"], rows: rejected.map((x) => [x.building, x.reason, x.source, x.at ? String(x.at).slice(0, 10) : null]) }] : []),
        ...missingBlock(missing),
      ],
      sources: [{ label: "Requirement record", href: HREF.requirement(r.id), observedAt: r.updated_at ?? null, status: r.status === "client_confirmed" ? "verified" : "reported" }],
    };
  },
});

// ---------------------------------------------------------------------------------------------------- opportunities
const searchOpportunities = defineTool({
  id: "search_opportunities", module: "database", category: "A",
  description: "List deals/opportunities, filtered by company, stage, temperature, outcome or name text. Includes days in current stage and next action.",
  input: z.object({
    query: z.string().max(200).optional().describe("Text in the opportunity name"),
    companyId: z.string().optional(), stage: z.string().max(40).optional().describe("Stage key, e.g. options_visits, proposal_negotiation"),
    temperature: z.enum(["cold", "warm", "hot"]).optional(),
    outcome: z.enum(["open", "dormant", "lost", "disqualified", "won", "any"]).optional().describe("Default: open + dormant"),
    limit, offset,
  }),
  async run(i, t) {
    const lim = clampLimit(i.limit); const off = i.offset ?? 0;
    let q = db(t).from("opportunity").select("id, name, org_id, stage, outcome, temperature, stage_entered_at, next_action, next_action_due, expected_close, expected_fee", { count: "exact" }).eq("workspace_id", ws(t)).is("archived_at", null);
    if (i.query) q = q.ilike("name", `%${ilikeSafe(i.query)}%`);
    if (i.companyId) q = q.eq("org_id", i.companyId);
    if (i.stage) q = q.eq("stage", i.stage);
    if (i.temperature) q = q.eq("temperature", i.temperature);
    if (!i.outcome) q = q.or("outcome.is.null,outcome.in.(open,dormant)"); else if (i.outcome !== "any") q = q.eq("outcome", i.outcome);
    const { data, count } = await q.order("updated_at", { ascending: false }).range(off, off + lim - 1);
    const rows = (data ?? []) as Row[];
    const orgs = await namesById(t, "organisation", rows.map((r) => r.org_id));
    const items = rows.map((r) => ({ id: r.id, name: r.name, company: orgs.get(r.org_id) ?? null, stage: r.stage, outcome: r.outcome, temperature: r.temperature, daysInStage: r.stage_entered_at ? daysBetween(String(r.stage_entered_at).slice(0, 10), today()) : null, nextAction: r.next_action, nextActionDue: r.next_action_due, href: HREF.opportunity(r.id) }));
    return {
      ok: true, summary: `${count ?? items.length} opportunit${(count ?? items.length) === 1 ? "y" : "ies"}`, data: { total: count ?? items.length, offset: off, items },
      entities: items.map((x) => ref("opportunity", x.id, x.name, x.href)), coverage: { checked: count ?? items.length, withData: count ?? items.length },
      blocks: items.length ? [{ kind: "table", title: "Opportunities", columns: ["Deal", "Company", "Stage", "Days in stage", "Next action", "Due"], rows: items.map((x) => [x.name, x.company, x.stage, x.daysInStage, x.nextAction ?? null, x.nextActionDue ?? null]) }] : [],
    };
  },
});

export async function loadOpportunityBundle(t: ToolContext, oppId: string) {
  const d = await getOpportunityDetail({ db: db(t), workspaceId: ws(t), userId: t.ctx.userId }, oppId).catch(() => null);
  if (!d || (d.opportunity as Row).workspace_id !== ws(t)) return null;
  const o = d.opportunity as Row;
  const reqId = o.requirement_id as string | null;
  const [{ data: quotes }, { data: st }, { data: tasks }, { data: inter }] = await Promise.all([
    reqId ? db(t).from("quote").select("id, version, valid_until, approved_at, superseded_by, space_id, counterparty_org_id, terms_json").eq("workspace_id", ws(t)).eq("requirement_id", reqId).is("superseded_by", null).limit(20) : Promise.resolve({ data: [] }),
    reqId ? db(t).from("stakeholder").select("person_id, role, access_status").eq("workspace_id", ws(t)).eq("requirement_id", reqId).is("archived_at", null) : Promise.resolve({ data: [] }),
    db(t).from("task").select("title, due_at, status").eq("workspace_id", ws(t)).eq("linked_entity_type", "opportunity").eq("linked_entity_id", oppId).in("status", ["open", "snoozed"]).limit(20),
    db(t).from("interaction").select("id, occurred_at, channel, direction, subject, summary, promises").eq("workspace_id", ws(t)).eq("opportunity_id", oppId).order("occurred_at", { ascending: false }).limit(10),
  ]);
  const people = await namesById(t, "person", ((st ?? []) as Row[]).map((s) => s.person_id));
  return { d, o, quotes: (quotes ?? []) as Row[], stakeholders: ((st ?? []) as Row[]).map((s) => ({ name: people.get(s.person_id) ?? null, personId: s.person_id, role: s.role, access: s.access_status })), tasks: (tasks ?? []) as Row[], interactions: (inter ?? []) as Row[] };
}

const getOpportunityDetails = defineTool({
  id: "get_opportunity_details", module: "database", category: "A",
  description: "One deal in full: stage + stage history (with evidence), days in stage, quotes (live versions), stakeholders, closing milestones blocking the next stage, fees and fee-protection issues, objections, open tasks, last interactions.",
  input: z.object({ opportunityId: id("Opportunity") }),
  async run(i, t) {
    const b = isUuid(i.opportunityId) ? await loadOpportunityBundle(t, i.opportunityId) : null;
    if (!b) return denied(t, "get_opportunity_details", { entity: "opportunity", id: i.opportunityId });
    const { d, o } = b;
    const daysInStage = o.stage_entered_at ? daysBetween(String(o.stage_entered_at).slice(0, 10), today()) : null;
    const blocking = (d.milestones as Row[]).filter((m) => m.required_for_stage && !["done", "waived", "not_applicable"].includes(m.status));
    const openObjections = (d.objections as Row[]).filter((x) => !x.outcome);
    const issues = [
      ...(d.feeIssues as unknown[]).map((x) => (typeof x === "string" ? x : (x as Row).message ?? JSON.stringify(x))),
      ...blocking.map((m) => `Closing item open: ${m.title} (needed for ${m.required_for_stage})`),
      ...openObjections.map((x) => `Objection unresolved: ${x.objection}`),
      ...b.quotes.filter((q) => q.valid_until && q.valid_until < today()).map((q) => `Quote v${q.version} expired ${q.valid_until}`),
    ];
    const entity = ref("opportunity", o.id, o.name, HREF.opportunity(o.id));
    const org = (o.organisation ?? null) as Row | null;
    return {
      ok: true, summary: `Deal ${o.name} — ${o.stage}${daysInStage !== null ? `, ${daysInStage} days in stage` : ""}`,
      entities: [entity, ...(org ? [ref("company", org.id, org.display_name, HREF.company(org.id))] : [])],
      data: {
        id: o.id, name: o.name, company: org?.display_name ?? null, stage: o.stage, outcome: o.outcome, temperature: o.temperature, daysInStage, mandate: o.mandate_status,
        expectedFee: o.expected_fee, expectedClose: o.expected_close, nextAction: o.next_action, nextActionDue: o.next_action_due, risks: o.risks,
        requirement: o.requirement ?? null, history: d.history, quotes: b.quotes.map((q) => ({ id: q.id, version: q.version, validUntil: q.valid_until, approved: !!q.approved_at })),
        stakeholders: b.stakeholders, feeSummary: d.feeSummary, openIssues: issues, openTasks: b.tasks,
        lastInteractions: b.interactions.slice(0, 5).map((x) => ({ at: x.occurred_at, channel: x.channel, subject: x.subject })), href: HREF.opportunity(o.id),
      },
      blocks: [
        { kind: "entity_card", entity, fields: [{ label: "Company", value: org?.display_name ?? null }, { label: "Stage", value: o.stage }, { label: "Days in stage", value: fmt(daysInStage) }, { label: "Next action", value: fmt(o.next_action) }, { label: "Due", value: fmt(o.next_action_due) }, { label: "Expected fee", value: fmt(o.expected_fee) }] },
        ...((d.history as Row[]).length ? [{ kind: "table" as const, title: "Stage history", columns: ["When", "From", "To", "Evidence"], rows: (d.history as Row[]).map((h) => [String(h.changed_at).slice(0, 10), h.from_stage ?? null, h.to_stage, h.evidence ?? null]) }] : []),
        ...missingBlock(issues),
      ],
      sources: [{ label: "Opportunity record", href: HREF.opportunity(o.id), observedAt: o.updated_at ?? null, status: "verified" }],
    };
  },
});

// ---------------------------------------------------------------------------------------------------- leases
const findLeasesExpiring = defineTool({
  id: "find_leases_expiring", module: "database", category: "A",
  description: "Companies whose recorded lease expires within the next N months, optionally only offices in a place (city, micro-market, MIDC/industrial area — matched on the leased building's address and geography, and for leases without a building on the company's recorded office locations) or a sector. ALWAYS reports coverage: how many companies were checked and how many have no lease/expiry data — absence of a lease record is NOT absence of a lease. Expiry dates carry their fact status.",
  input: z.object({
    windowMonths: z.number().int().min(1).max(60).optional().describe("Look-ahead window in months (default 12)"),
    place: z.string().max(100).optional().describe("Location text: city, micro-market, MIDC area etc."),
    sector: z.string().max(100).optional().describe("Company sector contains"),
    includeExpired: z.boolean().optional().describe("Also show leases whose recorded expiry has already passed (status needs confirmation)"),
    limit, offset,
  }),
  async run(i, t) {
    const lim = clampLimit(i.limit); const off = i.offset ?? 0;
    const from = today(); const to = edate(from, i.windowMonths ?? 12);
    let oq = db(t).from("organisation").select("id, display_name, sector").eq("workspace_id", ws(t)).is("archived_at", null).limit(5000);
    if (i.sector) oq = oq.ilike("sector", `%${ilikeSafe(i.sector)}%`);
    const orgs = ((await oq).data ?? []) as Row[];
    const capped = orgs.length >= 5000;
    const orgBy = new Map(orgs.map((o) => [o.id, o]));
    const leases: Row[] = [];
    for (let p = 0; ; p += 1000) {
      const { data } = await db(t).from("lease").select("id, tenant_org_id, asset_id, area_sf, contractual_expiry, fact_status, status, start_date").eq("workspace_id", ws(t)).is("archived_at", null).not("tenant_org_id", "is", null).range(p, p + 999);
      leases.push(...((data ?? []) as Row[]));
      if (!data || data.length < 1000) break;
    }
    const mine = leases.filter((l) => orgBy.has(l.tenant_org_id));
    const assetIds = [...new Set(mine.map((l) => l.asset_id).filter(Boolean))] as string[];
    const assets = new Map<string, Row>();
    for (let k = 0; k < assetIds.length; k += 150) {
      const { data } = await db(t).from("asset").select("id, name, address, locality_id, micro_market_id").eq("workspace_id", ws(t)).in("id", assetIds.slice(k, k + 150));
      for (const a of (data ?? []) as Row[]) assets.set(a.id, a);
    }
    const geo = await loadGeo(t);
    const placeOf = (l: Row) => { const a = l.asset_id ? assets.get(l.asset_id) : null; return a ? [a.name, a.address ?? "", ...geo.path(a.micro_market_id), ...geo.path(a.locality_id)].join(" | ") : ""; };
    const missing: string[] = [];
    let checkedOrgs: Set<string>; let note: string;
    const orgsWithLease = new Set(mine.map((l) => l.tenant_org_id));
    let pool = mine;
    if (i.place) {
      const needle = i.place.toLowerCase();
      // company locations (org_location) also place a company: a lease of a company with an office/HQ in the place counts
      const loc = await orgIdsWithLocationIn(db(t), ws(t), i.place, ["hq", "office", "r_and_d"]);
      pool = mine.filter((l) => placeOf(l).toLowerCase().includes(needle) || (!l.asset_id && loc.matched.has(l.tenant_org_id)));
      checkedOrgs = new Set(pool.map((l) => l.tenant_org_id));
      const noLoc = orgs.filter((o) => !mine.some((l) => l.tenant_org_id === o.id && l.asset_id) && !loc.withAnyLocation.has(o.id)).length;
      const viaLoc = orgs.filter((o) => loc.matched.has(o.id) && !checkedOrgs.has(o.id)).length;
      note = `${checkedOrgs.size} compan${checkedOrgs.size === 1 ? "y has" : "ies have"} a recorded lease in "${i.place}". ${noLoc} of ${orgs.length} companies have no lease with a building and no recorded location, so their location could not be checked.`;
      if (viaLoc) { note += ` ${viaLoc} other compan${viaLoc === 1 ? "y has" : "ies have"} a recorded office in "${i.place}" but no lease with an expiry there.`; missing.push(`${viaLoc} companies with an office in "${i.place}" (company locations) have no lease record there — expiry unknown`); }
      if (noLoc) missing.push(`${noLoc} companies have no lease/location data and could not be checked against "${i.place}"`);
    } else {
      checkedOrgs = new Set(orgs.map((o) => o.id));
      note = `${orgs.length} companies checked; ${orgs.length - orgsWithLease.size} have no lease record.`;
      if (orgs.length - orgsWithLease.size) missing.push(`${orgs.length - orgsWithLease.size} companies have no lease record (expiry unknown, not "no expiry")`);
    }
    if (capped) { note += " Only the first 5000 companies were checked (cap reached): the list may be incomplete."; missing.push("Company cap of 5000 reached — some companies were not checked"); }
    if (i.place) note += ` Filtered to "${i.place}".`; else note += " Not filtered by place (whole workspace).";
    const noExpiry = new Set(pool.filter((l) => !l.contractual_expiry).map((l) => l.tenant_org_id));
    const withExpiry = new Set(pool.filter((l) => l.contractual_expiry).map((l) => l.tenant_org_id));
    const onlyNoExpiry = [...noExpiry].filter((x) => !withExpiry.has(x)).length;
    if (onlyNoExpiry) { missing.push(`${onlyNoExpiry} companies have a lease but no recorded expiry date`); note += ` ${onlyNoExpiry} have a lease without an expiry date.`; }
    const hits = pool.filter((l) => l.contractual_expiry && l.contractual_expiry <= to && (i.includeExpired || l.contractual_expiry >= from))
      .sort((a, b) => String(a.contractual_expiry).localeCompare(String(b.contractual_expiry)));
    const ids = hits.map((h) => h.id);
    const { data: evs } = ids.length ? await db(t).from("lease_event").select("lease_id, event_type, event_date, confirmed, date_basis").eq("workspace_id", ws(t)).is("archived_at", null).in("lease_id", ids.slice(0, 300)).gte("event_date", from).lte("event_date", to) : { data: [] };
    const total = hits.length; const page = hits.slice(off, off + lim);
    const items = page.map((l) => {
      const o = orgBy.get(l.tenant_org_id)!; const a = l.asset_id ? assets.get(l.asset_id) : null;
      return {
        leaseId: l.id, companyId: o.id, company: o.display_name, sector: o.sector, building: a?.name ?? null, place: a ? [geo.byId.get(a.micro_market_id)?.name, geo.byId.get(a.locality_id)?.name].filter(Boolean).join(", ") || a.address : null,
        areaSf: l.area_sf, expiry: l.contractual_expiry, expired: l.contractual_expiry < from, factStatus: l.fact_status, status: factToStatus(l.fact_status),
        events: ((evs ?? []) as Row[]).filter((e) => e.lease_id === l.id).map((e) => ({ type: e.event_type, date: e.event_date, confirmed: e.confirmed })),
        href: HREF.company(o.id),
      };
    });
    const checked = checkedOrgs.size; const withData = [...checkedOrgs].filter((x) => withExpiry.has(x)).length;
    return {
      ok: true, summary: `${total} lease(s) expiring by ${to}; ${withData}/${checked} companies checked have expiry data`,
      data: { window: { from, to }, total, offset: off, items, coverage: { companiesChecked: checked, withExpiryData: withData, note } },
      coverage: { checked, withData, note }, missing,
      entities: items.map((x) => ref("company", x.companyId, x.company, x.href)),
      sources: items.slice(0, 10).map((x) => ({ label: `Lease — ${x.company}`, href: HREF.leases(), observedAt: null, status: x.status })),
      blocks: [
        ...(items.length ? [{ kind: "table" as const, title: `Leases expiring ${from} → ${to}`, columns: ["Company", "Building", "Place", "Area", "Expiry", "How sure"], rows: items.map((x) => [x.company, x.building, x.place, areaSf(x.areaSf), x.expiry, factLabel(x.factStatus)]), note }] : [{ kind: "text" as const, markdown: `No recorded lease expiries in this window. ${note}` }]),
        ...missingBlock(missing),
      ],
    };
  },
});

export const databaseTools = [
  searchCompanies, getCompanyProfile, searchContacts, getContactProfile, searchProperties, getPropertyDetails,
  searchRequirements, getRequirementDetails, searchOpportunities, getOpportunityDetails, findLeasesExpiring,
];
export { NOT_FOUND };
