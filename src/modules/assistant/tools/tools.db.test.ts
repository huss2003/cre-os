// Assistant tool registry: workspace isolation + security event, lease-expiry coverage honesty, straight-line distance,
// toolkit numbers = calculator, category-C plan() diff without writing. Local Supabase, RLS as the seeded owner (WS1).
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { userClient, adminClient, WS1, WS2, USERS, tag } from "../../../../tests/helpers";
import type { ToolContext, ToolResult } from "../types";
import { TOOLS, getTool, toolsForModel, TOOL_DOCS } from "./index";
import { haversineKm } from "./research";
import { taskDedupeKey } from "./actions";
import { compareRenewalRelocation } from "@/modules/toolkit/calc/renewal";

type Row = Record<string, any>;
let t: ToolContext;
const T = tag("ast");
const run = (id: string, input: unknown): Promise<ToolResult> => {
  const tool = getTool(id)!;
  return tool.run(tool.input.parse(input) as never, t);
};
const inMonths = (m: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };

beforeAll(async () => {
  const db = await userClient("owner");
  t = {
    ctx: { db: db as never, userId: USERS.owner.id, email: USERS.owner.email, workspaceId: WS1, workspaceName: "WS1", timezone: "Asia/Kolkata", role: "owner", allowedClassifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"], isPlatformAdmin: false, workspaces: [] },
    runId: randomUUID(), conversationId: null, focus: null,
  };
});

describe("registry", () => {
  it("exports unique tools, C tools have plan(), and model JSON has no $schema", () => {
    expect(new Set(TOOLS.map((x) => x.id)).size).toBe(TOOLS.length);
    for (const x of TOOLS.filter((x) => x.category === "C")) expect(typeof x.plan).toBe("function");
    const json = toolsForModel();
    expect(json.length).toBe(TOOLS.length);
    for (const j of json) { expect(j.input_schema.type).toBe("object"); expect("$schema" in j.input_schema).toBe(false); }
    expect(toolsForModel(["find_leases_expiring"]).map((j) => j.name)).toEqual(["find_leases_expiring"]);
    expect(TOOL_DOCS.find((d) => d.id === "prepare_send")?.category).toBe("C");
  });
  it("task dedupe key is stable for title+entity+due", () => {
    expect(taskDedupeKey("Call  Rahul ", "organisation", "x", "2026-12-01")).toBe(taskDedupeKey("call rahul", "organisation", "x", "2026-12-01"));
    expect(taskDedupeKey("Call Rahul", "organisation", "x", "2026-12-02")).not.toBe(taskDedupeKey("Call Rahul", "organisation", "x", "2026-12-01"));
  });
});

describe("workspace isolation", () => {
  it("a WS2 company is not visible from WS1 → not_found_or_no_access + security event", async () => {
    const admin = adminClient();
    const secret = `Hidden ${T}`;
    const { data: org } = await admin.from("organisation").insert({ workspace_id: WS2, display_name: secret, owner_user_id: USERS.other.id }).select("id").single();
    const r = await run("get_company_profile", { companyId: org!.id });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_found_or_no_access");
    expect(JSON.stringify(r)).not.toContain(secret);
    const s = await run("search_companies", { query: secret });
    expect((s.data as Row).total).toBe(0);
    const { data: ev } = await admin.from("assistant_security_event").select("kind, tool_id, detail, workspace_id").eq("workspace_id", WS1).eq("tool_id", "get_company_profile").contains("detail", { id: org!.id });
    expect(ev?.length).toBe(1);
    expect(ev![0].kind).toBe("access_denied");
    // a C tool's plan() on the same record is refused too
    await expect(getTool("update_company_record")!.plan!({ companyId: org!.id, changes: { sector: "x" }, reason: "test" } as never, t)).rejects.toThrow("not_found_or_no_access");
  });
});

describe("find_leases_expiring coverage", () => {
  it("counts companies checked and those lacking lease / expiry data", async () => {
    const db = t.ctx.db as any; const sector = `Sector ${T}`; const place = `Zone${T}`;
    const mk = async (n: string) => (await db.from("organisation").insert({ workspace_id: WS1, display_name: `${n} ${T}`, sector }).select("id").single()).data!.id as string;
    const [a, b, c] = [await mk("Alpha"), await mk("Beta"), await mk("Gamma")];
    const asset = (await db.from("asset").insert({ workspace_id: WS1, name: `Tower ${T}`, asset_kind: "building", address: `Plot 4, ${place} MIDC, Pune` }).select("id").single()).data!.id;
    await db.from("lease").insert([
      { workspace_id: WS1, tenant_org_id: a, asset_id: asset, area_sf: 20000, contractual_expiry: inMonths(6), fact_status: "reported" },
      { workspace_id: WS1, tenant_org_id: b, asset_id: null, area_sf: 8000, contractual_expiry: null, fact_status: "reported" },
    ]);
    const r = await run("find_leases_expiring", { windowMonths: 12, sector });
    expect(r.ok).toBe(true);
    expect(r.coverage).toMatchObject({ checked: 3, withData: 1 });
    const d = r.data as Row;
    expect(d.items.map((x: Row) => x.company)).toEqual([`Alpha ${T}`]);
    expect(d.items[0].status).toBe("reported");
    expect(r.missing!.join(" ")).toMatch(/1 companies have no lease record/);
    expect(r.missing!.join(" ")).toMatch(/1 companies have a lease but no recorded expiry/);
    void c;
    const p = await run("find_leases_expiring", { windowMonths: 12, sector, place });
    expect(p.coverage).toMatchObject({ checked: 1, withData: 1 });
    expect(p.coverage!.note).toMatch(/2 of 3 companies have no lease with a building/);
    const none = await run("find_leases_expiring", { windowMonths: 3, sector });
    expect((none.data as Row).total).toBe(0);
    expect(none.coverage).toMatchObject({ checked: 3, withData: 1 });
  });
});

describe("calculate_distance", () => {
  it("returns straight-line km and unknown when coordinates are missing", async () => {
    expect(haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(111.2, 1);
    const db = t.ctx.db as any;
    const withC = (await db.from("asset").insert({ workspace_id: WS1, name: `Geo A ${T}`, asset_kind: "building", lat: 18.5204, lon: 73.8567 }).select("id").single()).data!.id;
    const noC = (await db.from("asset").insert({ workspace_id: WS1, name: `Geo B ${T}`, asset_kind: "building" }).select("id").single()).data!.id;
    const r = await run("calculate_distance", { from: { type: "point", lat: 18.5204, lon: 73.7567, label: "Office" }, to: [{ type: "asset", id: withC }, { type: "asset", id: noC }] });
    const items = (r.data as Row).items as Row[];
    expect((r.data as Row).method).toMatch(/straight-line/);
    expect(items[0].to).toBe(`Geo A ${T}`);
    expect(items[0].km).toBe(haversineKm({ lat: 18.5204, lon: 73.7567 }, { lat: 18.5204, lon: 73.8567 }));
    expect(items[1]).toMatchObject({ to: `Geo B ${T}`, km: null });
    expect(r.missing).toContain(`No coordinates recorded for Geo B ${T}`);
    expect(r.coverage).toMatchObject({ checked: 2, withData: 1 });
  });
});

describe("toolkit tools reuse the calculators", () => {
  it("compare_renewal_vs_relocation numbers equal compareRenewalRelocation and the analysis is saved", async () => {
    const input = {
      title: `RvR ${T}`, discountRatePct: 10, comparisonMonths: 60,
      renewal: { currentRentMonthly: 900000, proposedRentMonthly: 1000000, escalation: { pct: 5, everyMonths: 12 }, extensionMonths: 60, rentFreeMonths: 0, camMonthly: 150000, depositChange: 600000, refurbishment: 2000000, maintenanceMonthly: 0, otherMonthly: 0, otherOneOff: 0 },
      relocation: { newRentMonthly: 850000, escalation: { pct: 5, everyMonths: 12 }, rentFreeMonths: 3, camMonthly: 140000, deposit: 5100000, oldDepositReturned: 5400000, fitout: 15000000, moving: 1500000, restorationOld: 1000000, overlapMonths: 2, brokerage: 850000, itRelocation: 700000, downtimeCost: 500000, employeeTransition: 0, otherMonthly: 0, otherOneOff: 0 },
    };
    const r = await run("compare_renewal_vs_relocation", input);
    expect(r.ok).toBe(true);
    const direct = compareRenewalRelocation({ renewal: input.renewal, relocation: input.relocation, comparisonMonths: 60, discountRatePct: 10 });
    const d = r.data as Row;
    expect(d.renewal.total).toBe(direct.renewal!.total);
    expect(d.relocation.pv).toBe(direct.relocation!.pv);
    expect(d.difference).toEqual(direct.difference);
    const { data: saved } = await (t.ctx.db as any).from("deal_analysis").select("kind, formula_version, workspace_id").eq("id", d.analysisId).single();
    expect(saved).toMatchObject({ kind: "renewal_vs_relocation", formula_version: "rvr-1.0", workspace_id: WS1 });
    expect(r.blocks?.some((b) => b.kind === "table")).toBe(true);
  });
});

describe("category C plan()", () => {
  it("update_company_record plan shows exact before/after and writes nothing", async () => {
    const db = t.ctx.db as any;
    const org = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `PlanCo ${T}`, sector: "IT services", legal_name: null }).select("id, row_version").single()).data!;
    const tool = getTool("update_company_record")!;
    const plan = await tool.plan!(tool.input.parse({ companyId: org.id, changes: { sector: "BFSI", legal_name: `PlanCo Pvt Ltd ${T}`, display_name: `PlanCo ${T}` }, reason: "Client confirmed on call" }) as never, t);
    expect(plan.diff).toEqual([
      { field: "legal_name", before: null, after: `PlanCo Pvt Ltd ${T}` },
      { field: "sector", before: "IT services", after: "BFSI" },
    ]);
    expect(plan.affected[0]).toMatchObject({ type: "company", id: org.id, href: `/companies/${org.id}` });
    expect(plan.explanation).toMatch(/legal_name .*material/);
    const after = (await db.from("organisation").select("sector, row_version").eq("id", org.id).single()).data!;
    expect(after).toEqual({ sector: "IT services", row_version: org.row_version });
  });
});

describe("read tools smoke (existing WS1 data)", () => {
  it("every category-A tool runs without error", async () => {
    const db = t.ctx.db as any;
    const one = async (table: string, extra = "id") => ((await db.from(table).select(extra).eq("workspace_id", WS1).is("archived_at", null).limit(1).maybeSingle()).data as Row | null);
    const opp = await one("opportunity", "id, org_id"); const req = await one("requirement"); const person = await one("person"); const asset = await one("asset");
    const orgId = opp?.org_id ?? (await one("organisation"))!.id;
    const calls: [string, unknown][] = [
      ["search_companies", { query: "a" }], ["search_companies", { sector: "IT" }], ["get_company_profile", { companyId: orgId }],
      ["search_contacts", { companyId: orgId }], ["search_properties", { place: "Pune", minAreaSf: 1000, maxRent: 200, status: "any" }],
      ["search_requirements", {}], ["search_opportunities", {}], ["find_leases_expiring", { place: "Pune" }],
      ["get_upcoming_meetings", { from: "2020-01-01", to: "2030-01-01" }], ["get_commitments", {}], ["get_research_signals", {}],
      ["rank_priority_accounts", {}], ["find_decision_makers", { companyId: orgId }], ["get_scores", { entityType: "company", entityId: orgId }],
      ["get_meeting_history", { companyId: orgId }], ["get_outreach_history", { companyId: orgId }],
      ["search_documents", { query: "lease rent" }], ["web_research", { question: "Is anyone expanding in Pune?" }],
    ];
    if (opp) calls.push(["get_opportunity_details", { opportunityId: opp.id }], ["explain_deal_stuck", { opportunityId: opp.id }], ["generate_deal_review", { opportunityId: opp.id }]);
    if (req) calls.push(["get_requirement_details", { requirementId: req.id }]);
    if (person) calls.push(["get_contact_profile", { personId: person.id }]);
    if (asset) calls.push(["get_property_details", { assetId: asset.id }]);
    for (const [id, input] of calls) {
      const r = await run(id, input);
      expect({ id, ok: r.ok, error: r.error }).toEqual({ id, ok: true, error: undefined });
      expect(typeof r.summary).toBe("string");
    }
  }, 120_000);
});
