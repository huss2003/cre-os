import { z } from "zod";
import { saveAnalysis } from "@/modules/toolkit/store";
import { compareLandlordOffers, landlordOfferSchema, OFFER_CMP_FORMULA, type LandlordOffer } from "@/modules/toolkit/calc/landlord-offer";
import { addOrgLocation, searchCompanyLocations, LOCATION_KINDS, LOCATION_KIND_LABEL, type LocationKind } from "../data/locations";
import { getOfferQuote, reviseLandlordOffer, saveLandlordOffer } from "../data/offers";
import type { Block } from "../types";
import { HREF, NOT_FOUND, db, defineTool, denied, factToStatus, failed, getOne, isUuid, logDenied, missingBlock, ref, today, ws, type Row } from "./shared";

/**
 * Data tools (round 2): company locations and typed landlord offers.
 * Suggested group: "data" (search_company_locations also fits "database").
 *
 * Risk choices (S4):
 *  - add_company_location is category C. A location is a new, additive, fact-labelled row (never overwrites a canonical
 *    field, archivable), so the Changes contract would class it routine_internal and org_location is not a proposal
 *    target table; but the assistant is a model, so the user's approval card is the gate before anything is written.
 *  - save_landlord_offer is category B: it creates a NEW immutable quote version (v1) from structured input, labelled with
 *    per-field fact status and its source; nothing existing changes. revise_landlord_offer (a new version superseding
 *    the old one, which invalidates dependent approvals/documents) is category C.
 */
const kindEnum = z.enum(LOCATION_KINDS);

// ---------------------------------------------------------------------------------------------------- locations
const searchCompanyLocationsTool = defineTool({
  id: "search_company_locations", module: "database", category: "A",
  description: "Find companies by where they have sites: HQ, offices, factories, plants, warehouses, R&D (e.g. 'companies with a factory in MIDC Chakan and an office in Hinjewadi'). Filters: kind, city, area text, hasOfficeIn (HQ/office/R&D in a place), hasFactoryIn (factory/plant/warehouse in a place), sector, company. Each site carries source and fact status. ALWAYS reports coverage: companies without any recorded location could not be checked.",
  input: z.object({
    kinds: z.array(kindEnum).max(7).optional(), city: z.string().max(100).optional(), area: z.string().max(150).optional().describe("Micro-market / industrial area text, e.g. 'Chakan', 'Hinjewadi Phase 2'"),
    hasOfficeIn: z.string().max(150).optional(), hasFactoryIn: z.string().max(150).optional(), sector: z.string().max(100).optional(),
    companyId: z.string().optional(), factStatus: z.array(z.enum(["reported", "currently_confirmed", "ai_inference"])).optional(),
    limit: z.number().int().min(1).max(25).optional(), offset: z.number().int().min(0).optional(),
  }),
  async run(i, t) {
    if (i.companyId && (!isUuid(i.companyId) || !(await getOne(t, "organisation", i.companyId, "id")))) return denied(t, "search_company_locations", { entity: "organisation", id: i.companyId });
    try {
      const r = await searchCompanyLocations(db(t), ws(t), { kinds: i.kinds as LocationKind[] | undefined, city: i.city, area: i.area, hasOfficeIn: i.hasOfficeIn, hasFactoryIn: i.hasFactoryIn, sector: i.sector, companyIds: i.companyId ? [i.companyId] : undefined, factStatus: i.factStatus });
      const lim = i.limit ?? 10; const off = i.offset ?? 0;
      const page = r.companies.slice(off, off + lim);
      const missing = r.coverage.withoutLocationData ? [`${r.coverage.withoutLocationData} companies have no recorded location and could not be checked`] : [];
      const rows = page.flatMap((c) => c.locations.slice(0, 6).map((l) => [c.name, LOCATION_KIND_LABEL[l.location_kind as LocationKind], l.name ?? null, l.area ?? null, l.city ?? null, l.headcount ?? null, l.source, l.fact_status] as (string | number | null)[]));
      const blocks: Block[] = page.length
        ? [{ kind: "table", title: "Company locations", columns: ["Company", "Kind", "Site", "Area", "City", "Headcount", "Source", "Fact status"], rows, note: r.coverage.note }]
        : [{ kind: "text", markdown: `No matching recorded locations. ${r.coverage.note}` }];
      return {
        ok: true, summary: `${r.companies.length} compan${r.companies.length === 1 ? "y" : "ies"} match; ${r.coverage.withLocationData}/${r.coverage.companiesChecked} have location data`,
        data: { total: r.companies.length, offset: off, items: page.map((c) => ({ companyId: c.orgId, company: c.name, sector: c.sector, href: HREF.company(c.orgId), locations: c.locations.map((l) => ({ id: l.id, kind: l.location_kind, name: l.name, area: l.area, city: l.city, assetId: l.asset_id, headcount: l.headcount, source: l.source, factStatus: l.fact_status, observedAt: l.observed_at })) })), coverage: r.coverage },
        coverage: { checked: r.coverage.companiesChecked, withData: r.coverage.withLocationData, note: r.coverage.note }, missing,
        entities: page.map((c) => ref("company", c.orgId, c.name, HREF.company(c.orgId))),
        sources: page.slice(0, 10).flatMap((c) => c.locations.slice(0, 1).map((l) => ({ label: `${c.name} — ${l.source === "lease" ? "lease record" : l.source}`, href: HREF.company(c.orgId), observedAt: l.observed_at ?? null, status: factToStatus(l.fact_status) }))),
        blocks: [...blocks, ...missingBlock(missing)],
      };
    } catch (e) { return failed("Location search failed", e); }
  },
});

const addLocationInput = z.object({
  companyId: z.string(), kind: kindEnum, name: z.string().max(200).optional(), address: z.string().max(500).optional(),
  city: z.string().max(100).optional(), area: z.string().max(150).optional().describe("Micro-market / industrial area"),
  assetId: z.string().optional().describe("Building id if the site is a known building"), headcount: z.number().int().min(0).optional(),
  factStatus: z.enum(["reported", "currently_confirmed", "ai_inference"]).describe("reported = a source said so; currently_confirmed = the client/user confirmed it now; ai_inference = your inference"),
  source: z.string().min(2).max(300).describe("Where this came from: URL, document, 'user said in chat'…"),
  observedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const addCompanyLocation = defineTool({
  id: "add_company_location", module: "database", category: "C", minRole: "member",
  description: "Record a company site (HQ, office, factory, plant, warehouse, R&D) with its source and fact status. Needs the user's approval. Duplicates (same company, kind and building/area/city/name) are not created twice.",
  input: addLocationInput,
  async plan(i, t) {
    const o = isUuid(i.companyId) ? await getOne(t, "organisation", i.companyId, "id, display_name") : null;
    if (!o) { await logDenied(t, "add_company_location", { entity: "organisation", id: i.companyId }); throw new Error(NOT_FOUND); }
    let building: Row | null = null;
    if (i.assetId) { building = isUuid(i.assetId) ? await getOne(t, "asset", i.assetId, "id, name") : null; if (!building) { await logDenied(t, "add_company_location", { entity: "asset", id: i.assetId }); throw new Error(NOT_FOUND); } }
    const after = { kind: i.kind, name: i.name ?? null, building: building?.name ?? null, area: i.area ?? null, city: i.city ?? null, address: i.address ?? null, headcount: i.headcount ?? null, factStatus: i.factStatus, source: i.source };
    return {
      title: `Add ${LOCATION_KIND_LABEL[i.kind]} location for ${o.display_name}`,
      affected: [ref("company", o.id, o.display_name, HREF.company(o.id))],
      diff: Object.entries(after).filter(([, v]) => v !== null).map(([field, v]) => ({ field, before: null, after: v })),
      explanation: `Adds a new location row labelled "${i.factStatus}" (source: ${i.source}). Nothing existing is overwritten; it can be edited or removed on the company page.`,
    };
  },
  async run(i, t) {
    try {
      if (!isUuid(i.companyId) || !(await getOne(t, "organisation", i.companyId, "id"))) return denied(t, "add_company_location", { entity: "organisation", id: i.companyId });
      if (i.assetId && (!isUuid(i.assetId) || !(await getOne(t, "asset", i.assetId, "id")))) return denied(t, "add_company_location", { entity: "asset", id: i.assetId });
      const isUrl = /^https?:\/\//i.test(i.source);
      const r = await addOrgLocation(db(t), ws(t), t.ctx.userId, {
        orgId: i.companyId, kind: i.kind, name: i.name, address: i.address, city: i.city, area: i.area, assetId: i.assetId ?? null, headcount: i.headcount ?? null,
        factStatus: i.factStatus, source: "assistant", sourceRef: i.source.slice(0, 500), observedAt: i.observedAt ?? today(),
      });
      return {
        ok: true, summary: r.duplicate ? "This location was already recorded — nothing added" : `Added ${LOCATION_KIND_LABEL[i.kind]} location`,
        data: { locationId: r.row.id, duplicate: r.duplicate, href: HREF.company(i.companyId) },
        entities: [ref("company", i.companyId, null, HREF.company(i.companyId))],
        sources: [{ label: isUrl ? "Source link" : i.source.slice(0, 80), href: isUrl ? i.source : undefined, observedAt: i.observedAt ?? today(), status: factToStatus(i.factStatus) }],
        blocks: [{ kind: "status", done: r.duplicate ? [] : ["Location saved"], pending: [], blocked: r.duplicate ? ["Already recorded"] : [] }],
      };
    } catch (e) { return failed("Could not add the location", e); }
  },
});

// ---------------------------------------------------------------------------------------------------- landlord offers
const offerInput = landlordOfferSchema.describe("Landlord offer. null/omitted = unknown (never 0). Rates are ₹ per SF per month on areaBasis.");

const saveLandlordOfferTool = defineTool({
  id: "save_landlord_offer", module: "toolkit", category: "B", minRole: "member",
  description: "Save a landlord's commercial offer for a requirement as a new typed offer record (quote v1, kind landlord_offer): building/space, area + basis + efficiency, rent ₹/SF/month, escalation, lock-in, term, deposit, rent-free, fit-out allowance, CAM, car parks, power backup, possession, validity, source document/page, fact status per field. Unknowns stay unknown. To change an existing offer use revise_landlord_offer.",
  input: z.object({ requirementId: z.string(), offer: offerInput, landlordCompanyId: z.string().optional() }),
  async run(i, t) {
    if (!isUuid(i.requirementId) || !(await getOne(t, "requirement", i.requirementId, "id"))) return denied(t, "save_landlord_offer", { entity: "requirement", id: i.requirementId });
    for (const [table, id] of [["asset", i.offer.assetId], ["space", i.offer.spaceId], ["organisation", i.landlordCompanyId]] as const)
      if (id && (!isUuid(id) || !(await getOne(t, table, id, "id")))) return denied(t, "save_landlord_offer", { entity: table, id });
    try {
      const q = await saveLandlordOffer({ db: db(t), workspaceId: ws(t), userId: t.ctx.userId }, { requirementId: i.requirementId, offer: i.offer as LandlordOffer, landlordOrgId: i.landlordCompanyId ?? null });
      const unknown = Object.entries(i.offer).filter(([, v]) => v === null).map(([k]) => k);
      return {
        ok: true, summary: `Saved landlord offer "${i.offer.name}" (v1)`,
        data: { quoteId: q.id, version: q.version, href: HREF.requirement(i.requirementId) },
        entities: [ref("requirement", i.requirementId, null, HREF.requirement(i.requirementId))],
        missing: unknown.length ? [`Unknown in this offer: ${unknown.join(", ")}`] : [],
        sources: i.offer.sourceDoc ? [{ label: `${i.offer.sourceDoc}${i.offer.sourcePage ? ` p.${i.offer.sourcePage}` : ""}`, status: factToStatus(i.offer.factStatus) }] : [],
        blocks: [{ kind: "status", done: [`Offer "${i.offer.name}" saved as v1`], pending: [], blocked: [] }],
      };
    } catch (e) { return failed("Could not save the offer", e); }
  },
});

const reviseLandlordOfferTool = defineTool({
  id: "revise_landlord_offer", module: "toolkit", category: "C", minRole: "member",
  description: "Change a saved landlord offer: creates a new version that supersedes the old one (dependent scenario approvals and documents become stale). Pass the full updated offer. Needs approval.",
  input: z.object({ quoteId: z.string(), offer: offerInput, reason: z.string().min(3).max(500) }),
  async plan(i, t) {
    const q = isUuid(i.quoteId) ? await getOfferQuote({ db: db(t), workspaceId: ws(t), userId: t.ctx.userId }, i.quoteId) : null;
    if (!q) { await logDenied(t, "revise_landlord_offer", { entity: "quote", id: i.quoteId }); throw new Error(NOT_FOUND); }
    const before = (q.offer ?? {}) as Row; const after = landlordOfferSchema.parse(i.offer) as Row;
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
    return {
      title: `Revise offer "${before.name ?? after.name}" → v${Number(q.version) + 1}`,
      affected: q.requirement_id ? [ref("requirement", q.requirement_id, null, HREF.requirement(q.requirement_id))] : [],
      diff: keys.map((k) => ({ field: k, before: before[k] ?? null, after: after[k] ?? null })),
      explanation: `${i.reason}. A new version is created; v${q.version} is kept but superseded, and analyses or documents built on it are marked stale.${keys.length ? "" : " Nothing would change."}`,
    };
  },
  async run(i, t) {
    try {
      const c = { db: db(t), workspaceId: ws(t), userId: t.ctx.userId };
      if (!isUuid(i.quoteId) || !(await getOfferQuote(c, i.quoteId))) return denied(t, "revise_landlord_offer", { entity: "quote", id: i.quoteId });
      const next = await reviseLandlordOffer(c, i.quoteId, i.offer as LandlordOffer, `Assistant: ${i.reason}`);
      return { ok: true, summary: `Offer revised to v${next.version}`, data: { quoteId: next.id, version: next.version }, blocks: [{ kind: "status", done: [`Saved v${next.version}`], pending: [], blocked: [] }] };
    } catch (e) { return failed("Could not revise the offer", e); }
  },
});

const compareLandlordOffersTool = defineTool({
  id: "compare_landlord_offers", module: "toolkit", category: "B",
  description: "Compare landlord offers line by line (offer-cmp-1.0 on the lease-1.0 calculators): rent, rent on carpet, escalation, lock-in, deposit, rent-free, fit-out allowance, CAM, car parks, then effective rent, total cost over the term, NPV at a discount rate and cost per seat (if seats known). Pass saved offer ids (quoteIds) and/or inline offers. Unknown fields stay unknown and are listed. Saves the analysis.",
  input: z.object({
    title: z.string().max(200).optional(), requirementId: z.string().optional(),
    quoteIds: z.array(z.string()).max(10).optional().describe("Saved landlord offer ids (from save_landlord_offer)"),
    offers: z.array(offerInput).max(10).optional().describe("Inline offers not saved yet"),
    discountRatePct: z.number().min(0).max(50).describe("Annual discount rate % for NPV, e.g. 10"),
    baseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Common commencement used for all offers (default: earliest stated lease commencement/possession, else today)"),
  }).refine((v) => (v.quoteIds?.length ?? 0) + (v.offers?.length ?? 0) > 0, "give quoteIds or offers"),
  async run(i, t) {
    if (i.requirementId && (!isUuid(i.requirementId) || !(await getOne(t, "requirement", i.requirementId, "id")))) return denied(t, "compare_landlord_offers", { entity: "requirement", id: i.requirementId });
    const c = { db: db(t), workspaceId: ws(t), userId: t.ctx.userId };
    const offers: LandlordOffer[] = []; const quoteRefs: Row[] = [];
    for (const qid of i.quoteIds ?? []) {
      const q = isUuid(qid) ? await getOfferQuote(c, qid) : null;
      if (!q) return denied(t, "compare_landlord_offers", { entity: "quote", id: qid });
      offers.push(landlordOfferSchema.parse(q.offer));
      quoteRefs.push({ quoteId: q.id, version: q.version, superseded: !!q.superseded_by, validUntil: q.valid_until });
    }
    offers.push(...((i.offers ?? []) as LandlordOffer[]));
    const dates = offers.map((o) => o.leaseCommencement ?? o.possessionDate).filter(Boolean).sort() as string[];
    const baseDate = i.baseDate ?? dates[0] ?? today();
    try {
      const r = compareLandlordOffers(offers, { discountRatePct: i.discountRatePct, baseDate });
      const warn = quoteRefs.filter((q) => q.superseded).map((q) => `Offer ${q.quoteId} v${q.version} has been superseded by a newer version`);
      const expired = offers.filter((o) => o.validUntil && o.validUntil < today()).map((o) => `${o.name}: offer validity expired ${o.validUntil}`);
      const missing = [...r.missing, ...warn, ...expired];
      const lc = r.leaseComparison;
      const outputs = lc && lc.offers.length > 1 ? { mode: "compare", comparison: lc, offerComparison: r } : lc && lc.offers.length === 1 ? { mode: "single", result: lc.offers[0], offerComparison: r } : { mode: "compare", comparison: { formulaVersion: r.leaseFormula, horizonMonths: 0, offers: [], rows: [], warnings: [] }, offerComparison: r };
      const title = i.title ?? "Landlord offer comparison (assistant)";
      const saved = await saveAnalysis(db(t), ws(t), t.ctx.userId, { kind: "lease_economics", title, requirementId: i.requirementId ?? null, quoteRefs, inputs: { offers, discountRatePct: i.discountRatePct, baseDate, quoteIds: i.quoteIds ?? [] }, outputs, formulaVersion: OFFER_CMP_FORMULA, missing, note: `assistant run ${t.runId}` });
      const best = r.ranking[0];
      const statusMark = (s: string | null) => (s === "currently_confirmed" ? " ✓" : s === "ai_inference" ? " (inferred)" : "");
      const tableRows = r.lines.map((l) => [`${l.label}${l.unit ? ` (${l.unit})` : ""}`, ...l.values.map((v, k) => (v === null ? "unknown" : `${v}${statusMark(l.status[k])}${l.best === k && r.names.length > 1 ? " ◀" : ""}`))]);
      return {
        ok: true, summary: best ? `Compared ${r.names.length} offers; lowest NPV of cost: ${best.name}` : `Compared ${r.names.length} offers; none could be costed`,
        entities: [{ type: "analysis", id: saved.id, label: title, href: HREF.analysis("lease_economics", saved.id) }], missing,
        data: { analysisId: saved.id, version: saved.version, formula: r.formula, baseDate, ranking: r.ranking, unknowns: r.unknowns, lines: r.lines.filter((l) => ["effectiveRentPerSf", "totalCost", "npv", "costPerSeat"].includes(l.key)).map((l) => ({ key: l.key, values: l.values })), href: HREF.analysis("lease_economics", saved.id) },
        blocks: [
          { kind: "table", title: "Landlord offers — line by line", columns: ["Line", ...r.names], rows: tableRows, note: "◀ = best on that line · ✓ = currently confirmed · (inferred) = AI inference; other stated values are reported" },
          ...(r.ranking.length ? [{ kind: "table" as const, title: `Ranking by NPV of cost @ ${i.discountRatePct}%`, columns: ["Rank", "Offer", "NPV (₹)", "Nominal total (₹)", "Δ NPV vs best (₹)", "Totals"], rows: r.ranking.map((x) => [x.rank, x.name, x.npv, x.nominalTco, x.deltaNpvVsBest, x.complete ? "complete" : "INCOMPLETE"]) }] : []),
          { kind: "brief", title: "Assumptions", sections: [{ heading: "How this was calculated", bullets: r.assumptions }] },
          ...missingBlock(missing),
          { kind: "download", label: "Open analysis", href: HREF.analysis("lease_economics", saved.id) },
        ],
        sources: [{ label: `Analysis v${saved.version} (${OFFER_CMP_FORMULA})`, href: HREF.analysis("lease_economics", saved.id), status: "verified" }, ...offers.filter((o) => o.sourceDoc).map((o) => ({ label: `${o.name}: ${o.sourceDoc}${o.sourcePage ? ` p.${o.sourcePage}` : ""}`, status: factToStatus(o.factStatus) }))],
      };
    } catch (e) { return failed("Offer comparison failed", e); }
  },
});

export const dataTools = [searchCompanyLocationsTool, addCompanyLocation, saveLandlordOfferTool, reviseLandlordOfferTool, compareLandlordOffersTool];
export const DATA_TOOL_GROUP = "data";
