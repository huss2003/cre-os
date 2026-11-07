// Module 1 acceptance: the relational master connects a company to its people, buildings, spaces, requirements,
// opportunities, leases and interactions — and the integrity rules (workspace isolation, no cross-workspace FK,
// NULL ≠ 0, idempotent observations, contradictions kept, archive not delete) hold. Synthetic data only.
import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { userClient, adminClient, WS1, WS2, tag } from "../../../tests/helpers";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("Module 1 — relational master", () => {
  let db: Awaited<ReturnType<typeof userClient>>;
  const ids: Record<string, string> = {};
  const t = tag("m1");

  beforeAll(async () => {
    db = await userClient("owner");
    const one = async (table: string, row: Record<string, unknown>) => {
      const { data, error } = await db.from(table).insert({ workspace_id: WS1, ...row }).select("id").single();
      if (error) throw new Error(`${table}: ${error.message}`);
      return data!.id as string;
    };
    ids.org = await one("organisation", { display_name: `Acme ${t}`, legal_name: `Acme ${t} Pvt Ltd` });
    ids.parent = await one("organisation", { display_name: `Acme Group ${t}` });
    ids.rel = await one("organisation_relation", { from_org_id: ids.parent, to_org_id: ids.org, relation_type: "parent_of" });
    ids.person = await one("person", { full_name: `Priya ${t}` });
    ids.oldOrg = await one("organisation", { display_name: `OldCo ${t}` });
    ids.empOld = await one("employment", { person_id: ids.person, org_id: ids.oldOrg, title: "Manager", is_current: false, end_date: "2024-03-31" });
    ids.empNew = await one("employment", { person_id: ids.person, org_id: ids.org, title: "Head of Real Estate", is_current: true });
    ids.asset = await one("asset", { name: `Tower ${t}`, asset_kind: "building", grade: "A" });
    ids.spec = await one("asset_spec", { asset_id: ids.asset, spec_key: "power_backup", value_text: "100% DG" });
    ids.space = await one("space", { asset_id: ids.asset, floor_text: "5", carpet_sf: 12000 });
    ids.req = await one("requirement", { org_id: ids.org, title: `Pune office ${t}`, area_min_sf: 10000, area_max_sf: 15000 });
    ids.req2 = await one("requirement", { org_id: ids.org, title: `Chennai office ${t}` });
    ids.feat = await one("requirement_feature", { requirement_id: ids.req, feature_key: "grade", value_text: "A", is_hard_constraint: true });
    ids.opp = await one("opportunity", { org_id: ids.org, requirement_id: ids.req, name: `Acme Pune ${t}` });
    ids.lease = await one("lease", { tenant_org_id: ids.org, asset_id: ids.asset, contractual_expiry: "2027-06-30" });
    ids.leaseSpace = await one("lease_space", { lease_id: ids.lease, space_id: ids.space, area_sf: 12000 });
    ids.int = await one("interaction", { occurred_at: new Date().toISOString(), channel: "meeting", subject: `Kickoff ${t}` });
    await one("interaction_link", { interaction_id: ids.int, entity_type: "organisation", entity_id: ids.org });
    ids.part = await one("interaction_participant", { interaction_id: ids.int, person_id: ids.person, role: "attendee" });
  });

  it("connects company → people, buildings, requirements, opportunities, leases, interactions", async () => {
    const [emp, reqs, opps, leases, links, parts] = await Promise.all([
      db.from("employment").select("person_id,is_current,title").eq("org_id", ids.org),
      db.from("requirement").select("id,title").eq("org_id", ids.org),
      db.from("opportunity").select("id,requirement_id").eq("org_id", ids.org),
      db.from("lease").select("id,asset_id,lease_space(space_id,space(floor_text,asset_id))").eq("tenant_org_id", ids.org),
      db.from("interaction_link").select("interaction_id").eq("entity_type", "organisation").eq("entity_id", ids.org),
      db.from("interaction_participant").select("person_id").eq("interaction_id", ids.int),
    ]);
    expect(emp.data).toEqual([{ person_id: ids.person, is_current: true, title: "Head of Real Estate" }]);
    expect(reqs.data!.length).toBe(2);                                 // multiple independent requirements
    expect(opps.data![0].requirement_id).toBe(ids.req);
    expect(leases.data![0].asset_id).toBe(ids.asset);
    expect((leases.data![0] as any).lease_space[0].space.asset_id).toBe(ids.asset); // building ≠ floor ≠ lease
    expect(links.data!.map((l) => l.interaction_id)).toContain(ids.int);
    expect(parts.data![0].person_id).toBe(ids.person);
  });

  it("keeps employment history when a person changes employer", async () => {
    const { data } = await db.from("employment").select("org_id,is_current").eq("person_id", ids.person).order("is_current");
    expect(data).toEqual([{ org_id: ids.oldOrg, is_current: false }, { org_id: ids.org, is_current: true }]);
  });

  it("blocks a foreign key that points into another workspace", async () => {
    const admin = adminClient();
    const { error } = await admin.from("asset_spec").insert({ workspace_id: WS2, asset_id: ids.asset, spec_key: "hvac", value_text: "VRV" });
    expect(error?.message).toMatch(/cross-workspace/);
  });

  it("rejects an invalid foreign key", async () => {
    const { error } = await db.from("lease_space").insert({ workspace_id: WS1, lease_id: ids.lease, space_id: "00000000-0000-4000-8000-0000000000ff" });
    expect(error).toBeTruthy();
  });

  it("isolates workspaces: another user cannot read these rows", async () => {
    const other = await userClient("other");
    const { data } = await other.from("asset_spec").select("id").eq("id", ids.spec);
    expect(data ?? []).toEqual([]);
  });

  it("keeps NULL distinct from zero", async () => {
    const q = await db.from("quote").insert({ workspace_id: WS1, requirement_id: ids.req }).select("id").single();
    const { data } = await db.from("quote_line").insert([
      { workspace_id: WS1, quote_id: q.data!.id, line_kind: "cam", amount: null },
      { workspace_id: WS1, quote_id: q.data!.id, line_kind: "rent_free", amount: 0 },
    ]).select("line_kind,amount").order("line_kind");
    expect(data).toEqual([{ line_kind: "cam", amount: null }, { line_kind: "rent_free", amount: 0 }]);
  });

  it("observations: re-import is idempotent, contradictions are kept side by side", async () => {
    const mk = (raw: string, loc: string) => ({ workspace_id: WS1, entity_type: "asset", entity_id: ids.asset, field: "total_area_sf",
      source_location: loc, value_raw: raw, value_num: Number(raw), unit: "sf", obs_key: sha(`${ids.asset}|total_area_sf|${loc}|${raw}`) });
    await db.from("observation").upsert(mk("500000", "A!R2"), { onConflict: "workspace_id,obs_key", ignoreDuplicates: true });
    await db.from("observation").upsert(mk("500000", "A!R2"), { onConflict: "workspace_id,obs_key", ignoreDuplicates: true });
    await db.from("observation").upsert(mk("520000", "B!R9"), { onConflict: "workspace_id,obs_key", ignoreDuplicates: true });
    const { data } = await db.from("observation").select("value_num").eq("entity_id", ids.asset).eq("field", "total_area_sf").order("value_num");
    expect(data!.map((r) => Number(r.value_num))).toEqual([500000, 520000]);
  });

  it("archives instead of deleting, and writes audit history", async () => {
    const { error } = await db.from("asset_spec").update({ archived_at: new Date().toISOString() }).eq("id", ids.spec);
    expect(error).toBeNull();
    const { data } = await db.from("asset_spec").select("archived_at").eq("id", ids.spec).single();
    expect(data!.archived_at).not.toBeNull();
    const audit = await adminClient().from("audit_event").select("action").eq("workspace_id", WS1).eq("entity_id", ids.spec);
    expect((audit.data ?? []).length).toBeGreaterThan(0);
  });

  it("overview RPC returns counts for the Database screen", async () => {
    const { data, error } = await db.schema("mudar_app").rpc("database_overview", { ws: WS1 });
    expect(error).toBeNull();
    expect(data.organisations).toBeGreaterThan(0);
    expect(data).toHaveProperty("identity_reviews");
  });
});
