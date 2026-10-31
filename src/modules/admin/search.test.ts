import { describe, it, expect, beforeAll } from "vitest";
import { userClient, adminClient, WS1, WS2, USERS, tag } from "../../../tests/helpers";
import { searchEntities, parseSearchQuery } from "./search";
import { getCompany, getPerson } from "./entities";

type C = Awaited<ReturnType<typeof userClient>>;

describe("search permission isolation (acceptance: Permissions)", () => {
  let owner: C, colleague: C, other: C;
  beforeAll(async () => {
    [owner, colleague, other] = await Promise.all([userClient("owner"), userClient("colleague"), userClient("other")]);
  });

  it("colleague finds a restricted account only after it is shared; other tenant never finds it (API + direct URL)", async () => {
    const name = tag("Zephyrine Capital");
    const { data: org, error } = await owner.from("organisation")
      .insert({ workspace_id: WS1, display_name: name, owner_user_id: USERS.owner.id }).select().single();
    expect(error).toBeNull();

    const own = await searchEntities(owner, WS1, { q: name });
    expect(own.map((h) => h.id)).toContain(org.id);

    // colleague: not assigned/shared yet
    expect((await searchEntities(colleague, WS1, { q: name })).map((h) => h.id)).not.toContain(org.id);
    expect(await getCompany(colleague, WS1, org.id)).toBeNull();

    // other tenant: neither via its own workspace nor by naming tenant one's workspace id
    expect((await searchEntities(other, WS2, { q: name })).length).toBe(0);
    expect((await searchEntities(other, WS1, { q: name })).length).toBe(0);
    expect(await getCompany(other, WS1, org.id)).toBeNull();
    expect(await getCompany(other, WS2, org.id)).toBeNull();

    await adminClient().from("record_share").insert({ workspace_id: WS1, entity_type: "organisation", entity_id: org.id, user_id: USERS.colleague.id });
    expect((await searchEntities(colleague, WS1, { q: name })).map((h) => h.id)).toContain(org.id);
    expect((await getCompany(colleague, WS1, org.id))?.org.id).toBe(org.id);
  });

  it("licensed_restricted records stay hidden from members without that classification, even their own", async () => {
    const name = tag("Licensed Matrix Co");
    const { data: org } = await owner.from("organisation")
      .insert({ workspace_id: WS1, display_name: name, classification: "licensed_restricted", owner_user_id: USERS.colleague.id }).select().single();
    expect((await searchEntities(owner, WS1, { q: name })).map((h) => h.id)).toContain(org.id);
    expect((await searchEntities(colleague, WS1, { q: name })).map((h) => h.id)).not.toContain(org.id);
    expect(await getCompany(colleague, WS1, org.id)).toBeNull();
  });

  it("matches aliases (shared record aliases visible to the colleague) and returns the matched alias", async () => {
    const t = tag("q");
    const { data: org } = await owner.from("organisation")
      .insert({ workspace_id: WS1, display_name: `Infosys BPM ${t}`, owner_user_id: USERS.owner.id }).select().single();
    const raw = `Progeon Outsourcing ${t}`;
    const canonical = raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const { error } = await owner.from("entity_alias").insert({ workspace_id: WS1, entity_type: "organisation", entity_id: org.id, raw_alias: raw, canonical_alias: canonical });
    expect(error).toBeNull();
    const hits = await searchEntities(owner, WS1, { q: `progeon outsourcing ${t}` });
    const hit = hits.find((h) => h.id === org.id);
    expect(hit?.matched_alias).toBe(raw);

    expect((await searchEntities(colleague, WS1, { q: raw })).map((h) => h.id)).not.toContain(org.id);
    await adminClient().from("record_share").insert({ workspace_id: WS1, entity_type: "organisation", entity_id: org.id, user_id: USERS.colleague.id });
    expect((await searchEntities(colleague, WS1, { q: raw })).map((h) => h.id)).toContain(org.id);
  });

  it("typed filter restricts entity types", async () => {
    const name = tag("Typefilter Towers");
    await owner.from("asset").insert({ workspace_id: WS1, name, owner_user_id: USERS.owner.id });
    await owner.from("organisation").insert({ workspace_id: WS1, display_name: name, owner_user_id: USERS.owner.id });
    const onlyAssets = await searchEntities(owner, WS1, parseSearchQuery(new URLSearchParams({ q: name, type: "building" })));
    expect(onlyAssets.length).toBeGreaterThan(0);
    expect(onlyAssets.every((h) => h.entity_type === "asset")).toBe(true);
    // no availability snapshot => never shown as vacant
    expect(onlyAssets[0].status_label).toBe("no availability evidence");
    expect(onlyAssets[0].fact_status).toBeNull();
  });
});

describe("identity ambiguity and fact status (acceptance: Identity ambiguity)", () => {
  it("two people sharing a name are returned as distinct records with distinguishing context", async () => {
    const owner = await userClient("owner");
    const name = `Rahul Sharma ${tag("p")}`;
    const mk = async (orgName: string, fact: string) => {
      const { data: o } = await owner.from("organisation").insert({ workspace_id: WS1, display_name: tag(orgName), owner_user_id: USERS.owner.id }).select().single();
      const { data: p } = await owner.from("person").insert({ workspace_id: WS1, full_name: name, owner_user_id: USERS.owner.id }).select().single();
      await owner.from("employment").insert({ workspace_id: WS1, person_id: p.id, org_id: o.id, title: "Head of Admin", is_current: true, fact_status: fact, owner_user_id: USERS.owner.id });
      return { o, p };
    };
    const a = await mk("Alpha Pharma", "reported");
    const b = await mk("Beta Logistics", "currently_confirmed");
    const hits = (await searchEntities(owner, WS1, { q: name, types: ["person"] })).filter((h) => h.title === name);
    expect(hits.map((h) => h.id).sort()).toEqual([a.p.id, b.p.id].sort());
    const ha = hits.find((h) => h.id === a.p.id)!;
    const hb = hits.find((h) => h.id === b.p.id)!;
    expect(ha.subtitle).toContain(a.o.display_name);
    expect(hb.subtitle).toContain(b.o.display_name);
    expect(ha.fact_status).toBe("reported");
    expect(hb.fact_status).toBe("currently_confirmed");
  });

  it("'as of' date shows the employment valid then; past jobs stay on the person", async () => {
    const owner = await userClient("owner");
    const name = `Priya Kulkarni ${tag("p")}`;
    const { data: oldOrg } = await owner.from("organisation").insert({ workspace_id: WS1, display_name: tag("OldCo"), owner_user_id: USERS.owner.id }).select().single();
    const { data: newOrg } = await owner.from("organisation").insert({ workspace_id: WS1, display_name: tag("NewCo"), owner_user_id: USERS.owner.id }).select().single();
    const { data: p } = await owner.from("person").insert({ workspace_id: WS1, full_name: name, owner_user_id: USERS.owner.id }).select().single();
    await owner.from("employment").insert([
      { workspace_id: WS1, person_id: p.id, org_id: oldOrg.id, title: "CFO", start_date: "2020-01-01", end_date: "2025-06-30", is_current: false, fact_status: "historical_observed", owner_user_id: USERS.owner.id },
      { workspace_id: WS1, person_id: p.id, org_id: newOrg.id, title: "CFO", start_date: "2025-07-01", is_current: true, fact_status: "reported", owner_user_id: USERS.owner.id },
    ]);
    const now = (await searchEntities(owner, WS1, { q: name, types: ["person"] }))[0];
    expect(now.subtitle).toContain(newOrg.display_name);
    const then = (await searchEntities(owner, WS1, { q: name, types: ["person"], asOf: "2024-03-01" }))[0];
    expect(then.subtitle).toContain(oldOrg.display_name);
    expect(then.fact_status).toBe("historical_observed");

    const detail = await getPerson(owner, WS1, p.id);
    expect(detail?.employment.map((e) => e.org_id).sort()).toEqual([oldOrg.id, newOrg.id].sort());
  });

  it("finds a person by exact email (hash match) without exposing other tenants", async () => {
    const owner = await userClient("owner");
    const other = await userClient("other");
    const email = `${tag("cfo")}@example.test`;
    const { data: p } = await owner.from("person").insert({ workspace_id: WS1, full_name: tag("Email Person"), owner_user_id: USERS.owner.id }).select().single();
    await owner.from("contact_method").insert({ workspace_id: WS1, person_id: p.id, method_type: "email", value: email, owner_user_id: USERS.owner.id, classification: "permitted_personal" });
    expect((await searchEntities(owner, WS1, { q: email.toUpperCase() })).map((h) => h.id)).toContain(p.id);
    expect((await searchEntities(other, WS2, { q: email })).length).toBe(0);
  });
});
