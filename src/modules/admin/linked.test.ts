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
