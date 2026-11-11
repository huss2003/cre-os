/* eslint-disable @typescript-eslint/no-explicit-any -- untyped rows in fixtures */
// Data round 2: org_location backfill from leases, location search coverage + dedupe, find_leases_expiring via
// locations, landlord offers saved/compared/revised through the tools. Local Supabase, RLS as the seeded owner (WS1).
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { userClient, adminClient, WS1, USERS, tag } from "../../../../tests/helpers";
import type { ToolContext, ToolResult } from "../types";
import { dataTools } from "../tools/data";
import { databaseTools } from "../tools/database";
import { addOrgLocation, backfillLocationsFromLeases, listOrgLocations, searchCompanyLocations } from "./locations";
import { compareLandlordOffers, landlordOfferSchema } from "@/modules/toolkit/calc/landlord-offer";

type Row = Record<string, any>;
const T = tag("dat");
let t: ToolContext; let db: any;
const admin = adminClient();
const own = { workspace_id: WS1, owner_user_id: USERS.owner.id };
const ids: Record<string, string> = {};
const tool = (id: string) => [...dataTools, ...databaseTools].find((x) => x.id === id)!;
const run = (id: string, input: unknown): Promise<ToolResult> => tool(id).run(tool(id).input.parse(input) as never, t);
const inMonths = (m: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };
const ins = async (table: string, row: Row) => { const r = await admin.from(table).insert({ ...own, ...row }).select("id").single(); if (r.error) throw r.error; return r.data!.id as string; };

beforeAll(async () => {
  db = await userClient("owner");
  t = { ctx: { db, userId: USERS.owner.id, email: USERS.owner.email, workspaceId: WS1, workspaceName: "WS1", timezone: "Asia/Kolkata", role: "owner", allowedClassifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"], isPlatformAdmin: false, workspaces: [] } as never, runId: randomUUID(), conversationId: null, focus: null };
  ids.city = await ins("geography", { level: "city", name: `Puneville ${T}` });
  ids.mm = await ins("geography", { level: "micro_market", name: `Hinjewadi ${T}`, parent_id: ids.city });
  ids.asset = await ins("asset", { name: `Tower ${T}`, micro_market_id: ids.mm, address: "Phase 1" });
  ids.org = await ins("organisation", { display_name: `Acme ${T}`, sector: `sec-${T}` });
  ids.org2 = await ins("organisation", { display_name: `Blank ${T}`, sector: `sec-${T}` });
  ids.org3 = await ins("organisation", { display_name: `NoBldg ${T}`, sector: `sec-${T}` });
  ids.lease = await ins("lease", { tenant_org_id: ids.org, asset_id: ids.asset, area_sf: 20000, start_date: "2024-01-01", contractual_expiry: inMonths(30), fact_status: "reported" });
  ids.lease3 = await ins("lease", { tenant_org_id: ids.org3, area_sf: 8000, contractual_expiry: inMonths(5), fact_status: "reported" });
  ids.req = await ins("requirement", { org_id: ids.org, title: `Req ${T}` });
});

describe("org_location backfill", () => {
  it("creates one reported office per tenant+building from leases, with city/area from geography; re-run adds nothing", async () => {
    await backfillLocationsFromLeases(db, WS1);
    const rows = await listOrgLocations(db, WS1, ids.org);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ location_kind: "office", asset_id: ids.asset, city: `Puneville ${T}`, area: `Hinjewadi ${T}`, source: "lease", source_lease_id: ids.lease, fact_status: "reported", name: `Tower ${T}` });
    expect(await backfillLocationsFromLeases(db, WS1)).toBe(0);
    expect(await listOrgLocations(db, WS1, ids.org)).toHaveLength(1);
  });
});

describe("location search + coverage", () => {
  it("adds a factory (deduped) and finds 'factory in Chakan AND office in Hinjewadi' with honest coverage", async () => {
    const a = await addOrgLocation(db, WS1, USERS.owner.id, { orgId: ids.org, kind: "factory", area: `MIDC Chakan ${T}`, city: "Pune", source: "user", factStatus: "currently_confirmed" });
    expect(a.duplicate).toBe(false);
    const again = await addOrgLocation(db, WS1, USERS.owner.id, { orgId: ids.org, kind: "factory", area: `midc  chakan ${T}`, city: "pune", source: "user" });
    expect(again).toMatchObject({ duplicate: true });
    expect(again.row.id).toBe(a.row.id);
    const r = await searchCompanyLocations(db, WS1, { hasFactoryIn: `Chakan ${T}`, hasOfficeIn: `Hinjewadi ${T}`, sector: `sec-${T}` });
    expect(r.companies.map((c) => c.orgId)).toEqual([ids.org]);
    expect(r.coverage).toMatchObject({ companiesChecked: 3, withLocationData: 1, withoutLocationData: 2 });
    expect(r.coverage.note).toMatch(/unknown, not absent/);
    // place text also matches through the geography path (city of the micro-market)
    const viaCity = await searchCompanyLocations(db, WS1, { city: `Puneville ${T}`, sector: `sec-${T}` });
    expect(viaCity.companies.map((c) => c.orgId)).toEqual([ids.org]);
    const tr = await run("search_company_locations", { hasFactoryIn: `chakan ${T}`, sector: `sec-${T}` });
    expect(tr.ok).toBe(true);
    expect(tr.coverage).toMatchObject({ checked: 3, withData: 1 });
    expect(tr.missing?.[0]).toMatch(/2 companies have no recorded location/);
  });

  it("add_company_location plan shows the diff without writing; run is idempotent", async () => {
    const input = tool("add_company_location").input.parse({ companyId: ids.org2, kind: "hq", city: "Mumbai", area: `BKC ${T}`, factStatus: "reported", source: "https://example.com/about" });
    const plan = await tool("add_company_location").plan!(input as never, t);
    expect(plan.diff.find((d) => d.field === "kind")?.after).toBe("hq");
    expect(await listOrgLocations(db, WS1, ids.org2)).toHaveLength(0);
    const r1 = await tool("add_company_location").run(input as never, t);
    const r2 = await tool("add_company_location").run(input as never, t);
    expect((r1.data as Row).duplicate).toBe(false);
    expect((r2.data as Row).duplicate).toBe(true);
    const rows = await listOrgLocations(db, WS1, ids.org2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "assistant", source_ref: "https://example.com/about", fact_status: "reported" });
  });

  it("find_leases_expiring place filter uses company office locations for leases without a building", async () => {
    await addOrgLocation(db, WS1, USERS.owner.id, { orgId: ids.org3, kind: "office", area: `Hinjewadi ${T}`, source: "user" });
    const r = await run("find_leases_expiring", { place: `Hinjewadi ${T}`, windowMonths: 36, sector: `sec-${T}` });
    const companies = ((r.data as Row).items as Row[]).map((x) => x.companyId);
    expect(companies).toEqual(expect.arrayContaining([ids.org, ids.org3]));
  });
});

describe("landlord offers", () => {
  const base = { areaSf: 25000, areaBasis: "chargeable", rentPerSf: 100, escalationPct: 15, escalationEveryMonths: 36, termMonths: 60, rentFreeMonths: 2, camPerSf: 12, carParks: 0, securityDepositMonths: 6, sourceDoc: `LOI ${T}.pdf`, sourcePage: 2 };
  it("save → compare (numbers = calculator, saved analysis) → revise (C plan diff, new version, old immutable)", async () => {
    const a = await run("save_landlord_offer", { requirementId: ids.req, offer: { ...base, name: "Tower A", assetId: ids.asset } });
    const b = await run("save_landlord_offer", { requirementId: ids.req, offer: { ...base, name: "Tower B", rentPerSf: 95, camPerSf: null, fitoutAllowanceInr: 2_000_000 } });
    expect(a.ok && b.ok).toBe(true);
    const qa = (a.data as Row).quoteId; const qb = (b.data as Row).quoteId;
    const { data: q } = await db.from("quote").select("kind, offer, terms_json, version").eq("id", qa).single();
    expect(q).toMatchObject({ kind: "landlord_offer", version: 1, terms_json: { rent: 100, rent_basis: "chargeable", tenure_months: 60 } });
    expect(b.missing?.[0] ?? "").toMatch(/camPerSf/);

    const c = await run("compare_landlord_offers", { requirementId: ids.req, quoteIds: [qa, qb], discountRatePct: 10, baseDate: "2027-01-01" });
    expect(c.ok).toBe(true);
    const expected = compareLandlordOffers([landlordOfferSchema.parse({ ...base, name: "Tower A", assetId: ids.asset }), landlordOfferSchema.parse({ ...base, name: "Tower B", rentPerSf: 95, camPerSf: null, fitoutAllowanceInr: 2_000_000 })], { discountRatePct: 10, baseDate: "2027-01-01" });
    expect((c.data as Row).ranking).toEqual(expected.ranking);
    expect(c.missing?.some((m) => m.startsWith("Tower B: totals exclude unknown"))).toBe(true);
    const { data: an } = await db.from("deal_analysis").select("kind, formula_version, outputs, requirement_id").eq("id", (c.data as Row).analysisId).single();
    expect(an).toMatchObject({ kind: "lease_economics", formula_version: "offer-cmp-1.0", requirement_id: ids.req });
    expect(an.outputs.mode).toBe("compare");
    const table = c.blocks!.find((x) => x.kind === "table") as Row;
    expect(table.rows.find((r: string[]) => r[0].startsWith("CAM / maintenance"))[2]).toBe("unknown");

    // offers are immutable in place
    const upd = await db.from("quote").update({ offer: { ...q.offer, rentPerSf: 1 } }).eq("id", qa).select("id");
    expect(upd.error?.message ?? "").toMatch(/immutable/);

    const rev = tool("revise_landlord_offer");
    const input = rev.input.parse({ quoteId: qa, offer: { ...base, name: "Tower A", assetId: ids.asset, rentPerSf: 98 }, reason: "landlord revised rent" });
    const plan = await rev.plan!(input as never, t);
    expect(plan.diff).toEqual([{ field: "rentPerSf", before: 100, after: 98 }]);
    const done = await rev.run(input as never, t);
    expect((done.data as Row).version).toBe(2);
    const { data: old } = await db.from("quote").select("superseded_by").eq("id", qa).single();
    expect(old.superseded_by).toBe((done.data as Row).quoteId);
  });
});
