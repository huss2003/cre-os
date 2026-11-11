// @ts-nocheck -- journey tests read untyped Supabase rows (no generated DB types); runtime assertions do the checking.
// Journey test plan — STAGE 1: Module 1 Database (TC 1.1–1.7). Synthetic ABC Technologies data, WS1, owner, mock-AI.
// Uses the same services the UI uses: admin/entities (createEntity/saveEntity/getCompany), admin/linked (addLinked),
// admin/search (searchEntities), deals/requirements (createRequirement), deals/quotes (createQuote), changes (proposeChange/approveAndApply).
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, USERS, tag } from "../helpers";
import { createEntity, getCompany, getPerson, getBuilding } from "@/modules/admin/entities";
import { addLinked } from "@/modules/admin/linked";
import { searchEntities } from "@/modules/admin/search";
import { createRequirement, getRequirementDetail } from "@/modules/deals/requirements/service";
import { createQuote } from "@/modules/deals/quotes/service";
import { proposeChange } from "@/lib/services/changes";
import { approveAndApply } from "@/modules/changes/service";

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const log = (id: string, actual: unknown) => console.log(`[ACTUAL ${id}]`, JSON.stringify(actual));

describe("Journey M1 — Database", () => {
  let db: Awaited<ReturnType<typeof userClient>>;
  const owner = USERS.owner.id;
  const t = tag("j1");
  const ABC = `ABC Technologies Pvt. Ltd. ${t}`;
  const ids: Record<string, string> = {};
  const people: Record<string, string> = {};
  const props: Record<string, { asset: string; space: string; avail: string }> = {};

  beforeAll(async () => { db = await userClient("owner"); });

  it("TC1.1 create company: unique id, profile, searchable, available to other modules", async () => {
    const org = await createEntity(db, WS1, owner, "organisation", {
      display_name: ABC, legal_name: ABC, sector: "Information Technology", hq_country: "India", domain: `abc-${t}.example.com`,
      headcount_min: "250", headcount_max: "250",
    });
    ids.org = org.id;
    expect(org.id).toMatch(/^[0-9a-f-]{36}$/);
    const profile = await getCompany(db, WS1, org.id);
    expect(profile).not.toBeNull();
    const hits = await searchEntities(db, WS1, { q: `ABC Technologies ${t}`, types: ["organisation"] });
    log("1.1", { id: org.id, searchHits: hits.map((h) => h.id), sector: org.sector, hqCity: "(no HQ city field; only hq_country)" });
    expect(hits.map((h) => h.id)).toContain(org.id);
    // available to other modules: a requirement can be created against it by id (deals module) — checked in TC1.5
  });

  it("TC1.1/1.6 duplicate company: creating ABC again is detected (not silently duplicated)", async () => {
    let created: Record<string, unknown> | null = null; let err: unknown = null;
    try { created = await createEntity(db, WS1, owner, "organisation", { display_name: ABC, sector: "Information Technology" }); } catch (e) { err = e; }
    const { data: same } = await db.from("organisation").select("id").eq("workspace_id", WS1).ilike("display_name", ABC).is("archived_at", null);
    const { data: cands } = await db.from("identity_match_candidate").select("id").eq("workspace_id", WS1).eq("decision", "pending").contains("right_raw", { display_name: ABC });
    log("1.6-company", { threw: err ? String((err as Error).message) : null, rowsWithSameName: same?.length, matchCandidates: cands?.length ?? 0, createdId: created?.id ?? null });
    if (created) ids.dupOrg = String(created.id);
    expect(err !== null || (cands?.length ?? 0) > 0, "duplicate company must be blocked or flagged for review").toBe(true);
  });

  it("TC1.6 different legal entity with similar name is not merged", async () => {
    const other = await createEntity(db, WS1, owner, "organisation", { display_name: `ABC Technology Services LLP ${t}` });
    expect(other.id).not.toBe(ids.org);
  });

  it("TC1.2 occupancy: Kharadi office 15,000 SF linked to ABC, marked estimate, source + date", async () => {
    const { data: geo, error: ge } = await db.from("geography").insert({ workspace_id: WS1, name: `Kharadi ${t}`, level: "locality" }).select("id").single();
    if (ge) throw ge;
    ids.kharadi = geo.id;
    const office = await createEntity(db, WS1, owner, "asset", { name: `ABC Kharadi Office Bldg ${t}`, locality_id: geo.id, address: "Kharadi, Pune" });
    ids.officeAsset = office.id;
    const r = await addLinked(db, WS1, owner, "lease", office.id, fd({ tenant_org_id: ids.org, area_sf: "15000", status: "active" }));
    ids.lease = r.id!;
    const { data: lease } = await db.from("lease").select("*").eq("id", ids.lease).single();
    const company = await getCompany(db, WS1, ids.org);
    log("1.2", { lease_id: lease.id, tenant: lease.tenant_org_id, area_sf: lease.area_sf, fact_status: lease.fact_status, source_cols: Object.keys(lease).filter((k) => /source|observed|estimate/.test(k)) });
    expect(lease.tenant_org_id).toBe(ids.org);
    expect(Number(lease.area_sf)).toBe(15000);
    expect(JSON.stringify(company)).toContain(ids.lease);
    // Estimated must be distinguishable from verified; UI fixes fact_status='reported' and offers no "estimate" choice.
    expect.soft(lease.fact_status, "estimate must not be stored as confirmed").not.toBe("currently_confirmed");
    expect.soft(["estimated", "estimate"].includes(String(lease.fact_status)) || lease.area_basis === "estimated" || lease.is_estimate === true, "lease form cannot mark area as an ESTIMATE (only 'reported')").toBe(true);
    // Source + observation date: the sourced-value path is `observation` (asset host only, not lease/company occupancy)
    const ob = await addLinked(db, WS1, owner, "observation", office.id, fd({ field: "other", value_raw: "ABC occupies ~15,000 SF (estimate)", value_num: "15000", unit: "sf", source_location: "synthetic test note", observed_on: "2026-11-11", verification: "reported" }));
    expect(ob.id).toBeTruthy();
  });

  it("TC1.3 contacts: three people linked to ABC with distinct designations/roles and unique ids", async () => {
    const roles: [string, string][] = [["Rahul Sharma", "Head of Administration"], ["Priya Mehta", "Head of Finance"], ["Amit Verma", "Head of Human Resources"]];
    for (const [name, title] of roles) {
      const r = await addLinked(db, WS1, owner, "org_employment", ids.org, fd({ new_person_name: `${name} ${t}`, title, is_current: "true" }));
      const { data: emp } = await db.from("employment").select("person_id, title, org_id").eq("id", r.id!).single();
      people[name] = emp.person_id;
      expect(emp.org_id).toBe(ids.org);
      expect(emp.title).toBe(title);
    }
    expect(new Set(Object.values(people)).size).toBe(3);
    const company = (await getCompany(db, WS1, ids.org))!;
    const p = await getPerson(db, WS1, people["Priya Mehta"]);
    log("1.3", { people, companyJsonHasAll: Object.values(people).every((id) => JSON.stringify(company).includes(id)), priyaLoaded: !!p });
    expect(Object.values(people).every((id) => JSON.stringify(company).includes(id))).toBe(true);
    // Stakeholder role (operational / financial approver / workforce) — stored on requirement stakeholders (TC1.5), not on employment.
  });

  it("TC1.4 properties A/B/C saved with separate commercial terms, searchable, unique ids", async () => {
    const spec = {
      A: { loc: "Kharadi", area: 25000, rent: 100, cam: 12, dep: 6, rf: 2, esc: 15 },
      B: { loc: "Kharadi", area: 28000, rent: 95, cam: 10, dep: 6, rf: 3, esc: 12 },
      C: { loc: "Viman Nagar", area: 24000, rent: 110, cam: 8, dep: 4, rf: 1, esc: 15 },
    } as const;
    for (const [k, s] of Object.entries(spec)) {
      const a = await createEntity(db, WS1, owner, "asset", { name: `Property ${k} ${s.loc} ${t}`, address: `${s.loc}, Pune`, total_area_sf: String(s.area) });
      const sp = await addLinked(db, WS1, owner, "space", a.id, fd({ floor_text: "3", chargeable_sf: String(s.area) }));
      const av = await addLinked(db, WS1, owner, "availability", a.id, fd({ space_id: sp.id!, as_of: "2026-11-11", status: "available", fact_status: "reported", asking_rent_min: String(s.rent), asking_rent_max: String(s.rent), rent_basis: "chargeable" }));
      // CAM / deposit / rent-free / escalation: no field on building/space/availability; only quote.terms_json (needs a requirement).
      for (const [spk, v] of [["cam", s.cam]] as const) {
        try { await addLinked(db, WS1, owner, "asset_spec", a.id, fd({ spec_key: spk, value_num: String(v) })); } catch { /* not a supported spec key */ }
      }
      props[k] = { asset: a.id, space: sp.id!, avail: av.id! };
    }
    const assets = await Promise.all(Object.values(props).map((p) => getBuilding(db, WS1, p.asset)));
    const avs = await db.from("availability").select("id, asking_rent_min").in("id", Object.values(props).map((p) => p.avail));
    const hits = await searchEntities(db, WS1, { q: `Property ${t}`, types: ["asset"] });
    const { data: cols } = await db.from("availability").select("*").eq("id", props.A.avail).single();
    log("1.4", { ids: props, rents: avs.data, searchHits: hits.length, availabilityHasCam: Object.keys(cols ?? {}).some((c) => /cam/.test(c)) });
    expect(new Set(Object.values(props).map((p) => p.asset)).size).toBe(3);
    expect(assets.every(Boolean)).toBe(true);
    expect(Number(avs.data!.find((r) => r.id === props.B.avail)!.asking_rent_min)).toBe(95);
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect.soft(Object.keys(cols ?? {}).some((c) => /cam/.test(c)), "property record has no CAM / deposit / rent-free / escalation fields").toBe(true);
  });

  it("TC1.5 requirement 25,000 SF Kharadi, 9 months, 5-yr lease, linked to ABC, independent of occupancy", async () => {
    const ctx = { db, workspaceId: WS1, userId: owner };
    const req = await createRequirement(ctx, {
      orgId: ids.org, title: `ABC Pune expansion 25k SF ${t}`,
      changes: [
        { key: "area", value: [25000, 25000, 25000], status: "estimated" },
        { key: "preferred_locations", value: [ids.kharadi], status: "estimated" },
        { key: "occupation_date", value: "2027-08-11", status: "estimated" },
        { key: "tenure_months", value: 60, status: "estimated" },
      ],
    });
    ids.req = String(req.id);
    const detail = await getRequirementDetail(ctx, ids.req);
    const { data: lease } = await db.from("lease").select("area_sf").eq("id", ids.lease).single();
    log("1.5", { req: { id: req.id, org_id: req.org_id, area_target_sf: req.area_target_sf, area_min_sf: req.area_min_sf, occupation_date: req.occupation_date, tenure: (req.constraints as any)?.values?.tenure_months, status: req.status }, leaseArea: lease.area_sf });
    expect(req.org_id).toBe(ids.org);
    expect(Number(req.area_target_sf ?? req.area_min_sf)).toBe(25000);
    expect(String(req.occupation_date)).toBe("2027-08-11");
    expect(Number((req.constraints as any)?.values?.tenure_months)).toBe(60);
    expect(Number(lease.area_sf)).toBe(15000);
    expect(detail).toBeTruthy();
    // Property commercial terms are kept per property in versioned quotes (deals module), separate fields — no mixing.
    const q = await createQuote(ctx, { requirementId: ids.req, spaceId: props.A.space, terms: { rent: 100, rent_basis: "chargeable", cam_per_sf: 12, deposit_months: 6, rent_free_months: 2, escalation_pct: 15, escalation_every_months: 36, tenure_months: 60 } });
    expect(q.terms_json.cam_per_sf).toBe(12);
    expect(q.terms_json.rent).toBe(100);
  });

  it("TC1.6 duplicate contact: adding Rahul Sharma again is detected", async () => {
    const before = await db.from("person").select("id").eq("workspace_id", WS1).eq("full_name", `Rahul Sharma ${t}`);
    const r = await addLinked(db, WS1, owner, "org_employment", ids.org, fd({ new_person_name: `Rahul Sharma ${t}`, title: "Head of Administration", is_current: "true" }));
    const after = await db.from("person").select("id").eq("workspace_id", WS1).eq("full_name", `Rahul Sharma ${t}`);
    log("1.6-contact", { before: before.data?.length, after: after.data?.length, warnings: r.warnings });
    expect(after.data!.length > 1 ? r.warnings.some((w) => /duplicate|already exists|same name/i.test(w)) : true, "second Rahul Sharma created with no duplicate warning").toBe(true);
  });

  it("TC1.7 history: occupancy 15,000 -> 18,000 SF via approved change; previous value, source and date kept", async () => {
    const { data: l } = await db.from("lease").select("row_version, classification").eq("id", ids.lease).single();
    const p = await proposeChange(db, WS1, { targetType: "lease", targetId: ids.lease, operation: "update", expectedVersion: Number(l.row_version), patch: [{ op: "replace", path: "/area_sf", value: 18000 }], reason: "Synthetic test: revised estimate from site visit note 2026-11-11", proposedByKind: "user", classification: l.classification });
    await approveAndApply(db, p.id, { actorUserId: owner } as never);
    const { data: now } = await db.from("lease").select("area_sf").eq("id", ids.lease).single();
    const { data: audit } = await db.from("audit_event").select("occurred_at, before, after, change_proposal_id, actor_user_id").eq("workspace_id", WS1).eq("entity_type", "lease").eq("entity_id", ids.lease).order("occurred_at", { ascending: false });
    const upd = (audit ?? []).find((a) => a.before && a.after && Number(a.before.area_sf) === 15000 && Number(a.after.area_sf) === 18000);
    const { data: prop } = await db.from("change_proposal").select("reason, created_at").eq("id", p.id).single();
    const company = await getCompany(db, WS1, ids.org);
    log("1.7", { now: now.area_sf, auditRows: audit?.length, hasBeforeAfter: !!upd, reason: prop?.reason, trailHasLease: JSON.stringify(company).includes("18000") });
    expect(Number(now.area_sf)).toBe(18000);
    expect(upd, "audit keeps previous 15,000 value").toBeTruthy();
    expect(upd!.change_proposal_id).toBe(p.id);
    expect(prop!.reason).toMatch(/site visit/);
  });

  it("M1 pass: company, contacts, occupancy, properties and requirement linked through one central record", async () => {
    const c = (await getCompany(db, WS1, ids.org))!;
    const s = JSON.stringify(c);
    expect(s).toContain(ids.req);
    expect(s).toContain(ids.lease);
    for (const id of Object.values(people)) expect(s).toContain(id);
  });
});
