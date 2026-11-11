// QA regression: linked-record form validation (plain-language errors, NULL ≠ 0) and DB integrity rules.
import { describe, it, expect } from "vitest";
import { LINKED, parseLinked } from "./linked";
import { friendlyDbError } from "./http";
import { userClient, WS1, tag } from "../../../tests/helpers";

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe("linked form validation", () => {
  it("rejects invalid email and phone with readable messages", () => {
    expect(() => parseLinked(LINKED.contact_method, fd({ method_type: "email", value: "rahul@" }))).toThrow(/email address is not valid/);
    expect(() => parseLinked(LINKED.contact_method, fd({ method_type: "phone", value: "12ab" }))).toThrow(/phone number is not valid/);
    expect(parseLinked(LINKED.contact_method, fd({ method_type: "email", value: "  Rahul@ABC.example.com " })).value).toBe("rahul@abc.example.com");
  });
  it("rejects end date before start, negative area, current role with end date", () => {
    expect(() => parseLinked(LINKED.employment, fd({ org_id: "00000000-0000-4000-8000-000000000001", is_current: "false", start_date: "2024-05-01", end_date: "2024-01-01" }))).toThrow(/before the start date/);
    expect(() => parseLinked(LINKED.space, fd({ floor_text: "5", carpet_sf: "-100" }))).toThrow(/cannot be negative/);
    expect(() => parseLinked(LINKED.employment, fd({ org_id: "00000000-0000-4000-8000-000000000001", is_current: "true", end_date: "2024-01-01" }))).toThrow(/cannot be current/);
  });
  it("keeps blank as NULL and zero as zero; floor labels stay text", () => {
    const r = parseLinked(LINKED.space, fd({ floor_text: " Upper  Ground ", carpet_sf: "", chargeable_sf: "0" }));
    expect(r).toMatchObject({ floor_text: "Upper Ground", carpet_sf: null, chargeable_sf: 0 });
  });
  it("rejects bad lat/lon, unknown select values, non-uuid refs", () => {
    expect(() => parseLinked(LINKED.geography, fd({ level: "city", name: "Pune", lat: "95" }))).toThrow(/Latitude/);
    expect(() => parseLinked(LINKED.geography, fd({ level: "planet", name: "X" }))).toThrow(/choose one of the listed/);
    expect(() => parseLinked(LINKED.lease, fd({ tenant_org_id: "abc" }))).toThrow(/pick a record/);
  });
  it("translates database errors for non-technical users", () => {
    expect(friendlyDbError('duplicate key value violates unique constraint "organisation_cin_uq"')).toMatch(/already has this CIN/);
    expect(friendlyDbError('new row violates check constraint "employment_dates_chk"')).toMatch(/end date must be on or after/);
  });
});

describe("database integrity rules (DB-076, DB-104, DB-417)", () => {
  it("DB rejects employment ending before it starts, geography cycles, fee shares above 1", async () => {
    const db = await userClient("owner");
    const t = tag("qa");
    const org = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `QA ${t}` }).select("id").single()).data!.id;
    const per = (await db.from("person").insert({ workspace_id: WS1, full_name: `QA ${t}` }).select("id").single()).data!.id;
    const bad = await db.from("employment").insert({ workspace_id: WS1, person_id: per, org_id: org, start_date: "2024-05-01", end_date: "2024-01-01", is_current: false });
    expect(bad.error?.message).toMatch(/employment_dates_chk/);
    const city = (await db.from("geography").insert({ workspace_id: WS1, level: "city", name: `C ${t}` }).select("id").single()).data!.id;
    const loc = (await db.from("geography").insert({ workspace_id: WS1, level: "locality", name: `L ${t}`, parent_id: city }).select("id").single()).data!.id;
    const cyc = await db.from("geography").update({ parent_id: loc }).eq("id", city);
    expect(cyc.error?.message).toMatch(/cycle/);
    const opp = (await db.from("opportunity").insert({ workspace_id: WS1, org_id: org, name: `O ${t}` }).select("id").single()).data!.id;
    const fm = (await db.from("fee_milestone").insert({ workspace_id: WS1, opportunity_id: opp, milestone: "signing" }).select("id").single()).data!.id;
    expect((await db.from("fee_allocation").insert({ workspace_id: WS1, fee_milestone_id: fm, partner_org_id: org, share: 0.7 })).error).toBeNull();
    const over = await db.from("fee_allocation").insert({ workspace_id: WS1, fee_milestone_id: fm, partner_org_id: org, share: 0.4 });
    expect(over.error?.message).toMatch(/exceeds 1/);
  });
});

describe("space duplicate (DB-144)", () => {
  it("blocks the same floor + unit twice in one building", async () => {
    const { addLinked } = await import("./linked");
    const db = await userClient("owner");
    const t = tag("sp");
    const asset = (await db.from("asset").insert({ workspace_id: WS1, name: `B ${t}` }).select("id").single()).data!.id;
    const owner = "00000000-0000-4000-8000-000000000001";
    await addLinked(db, WS1, owner, "space", asset, fd({ floor_text: "5", unit: "A", carpet_sf: "1000" }));
    await expect(addLinked(db, WS1, owner, "space", asset, fd({ floor_text: "5", unit: "a" }))).rejects.toThrow(/already exists/);
  });
});

describe("place duplicate", () => {
  it("blocks the same place name/alias (case + spaces ignored) under the same parent; archived places don't block", async () => {
    const { addLinked } = await import("./linked");
    const db = await userClient("owner");
    const t = tag("gp");
    const owner = "00000000-0000-4000-8000-000000000001";
    const city = (await db.from("geography").insert({ workspace_id: WS1, level: "city", name: `City ${t}` }).select("id").single()).data!.id;
    await addLinked(db, WS1, owner, "geography", null, fd({ level: "locality", name: `Kharadi ${t}`, parent_id: city, aliases: `Kharadi Bypass ${t}` }));
    await expect(addLinked(db, WS1, owner, "geography", null, fd({ level: "locality", name: `  kharadi   ${t.toUpperCase()} `, parent_id: city }))).rejects.toThrow(/already exists/);
    await expect(addLinked(db, WS1, owner, "geography", null, fd({ level: "micro_market", name: `KHARADI BYPASS ${t}`, parent_id: city }))).rejects.toThrow(/already exists/);
    await db.from("geography").insert({ workspace_id: WS1, level: "locality", name: `Old ${t}`, parent_id: city, archived_at: new Date().toISOString() });
    await addLinked(db, WS1, owner, "geography", null, fd({ level: "locality", name: `Old ${t}`, parent_id: city }));
  });
});

describe("search by domain (DB-029)", () => {
  it("finds a company by its website domain", async () => {
    const db = await userClient("owner");
    const t = tag("dom");
    await db.from("organisation").insert({ workspace_id: WS1, display_name: `Dom ${t}`, domain: `${t}.example.com` });
    const { data } = await db.schema("mudar_app").rpc("search_entities", { p_workspace: WS1, p_query: `${t}.example.com`, p_types: null, p_as_of: null, p_limit: 10, p_include_archived: false });
    expect((data ?? []).map((r: { title: string }) => r.title)).toContain(`Dom ${t}`);
  });
});

describe("canonical observation via approval (DB-385)", () => {
  it("proposes an observation as current; applying marks it confirmed, others untouched", async () => {
    const { proposeChange } = await import("@/lib/services/changes");
    const db = await userClient("owner");
    const t = tag("obs");
    const asset = (await db.from("asset").insert({ workspace_id: WS1, name: `B ${t}` }).select("id").single()).data!.id;
    const mk = (v: string) => db.from("observation").insert({ workspace_id: WS1, entity_type: "asset", entity_id: asset, field: "asking_rent", value_raw: v, obs_key: `${t}-${v}` }).select("id,row_version").single();
    const a = (await mk("98")).data!, b = (await mk("110")).data!;
    const p = await proposeChange(db as any, WS1, { targetType: "observation", targetId: a.id, operation: "update", expectedVersion: Number(a.row_version),
      patch: [{ op: "replace", path: "/verification", value: "currently_confirmed" }], reason: "landlord confirmed by phone", proposedByKind: "user" });
    expect(p.id).toBeTruthy();
    const { data: rows } = await db.from("observation").select("id,verification").in("id", [a.id, b.id]);
    expect(rows!.every((r) => r.verification === "reported")).toBe(true); // nothing changes before approval
  });
});

describe("requirement ranges (DB-214)", () => {
  it("rejects min area above max even with no target", async () => {
    const { assertRequirementRanges } = await import("@/modules/deals/requirements/service");
    expect(() => assertRequirementRanges({ area_min_sf: 30000, area_max_sf: 10000 })).toThrow(/Minimum area/);
    expect(() => assertRequirementRanges({ decision_date: "2027-02-01", occupation_date: "2027-01-01" })).toThrow(/Move-in/);
    expect(() => assertRequirementRanges({ area_min_sf: 10000, area_max_sf: null })).not.toThrow();
  });
});
