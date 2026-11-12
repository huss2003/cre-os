import { describe, it, expect, beforeAll } from "vitest";
import { userClient, adminClient, WS1, WS2, USERS, tag } from "../../../../tests/helpers";
import { lookupEntities, lookupById, safeTerm, type LookupCtx } from "./lookup";

describe("notes link lookup", () => {
  const t = tag("lk"); const name = `Zephyrlook ${t}`;
  let c: LookupCtx; let orgId = "", openReq = "", closedReq = "", otherWsOrg = "", mtg = "", person = "", otherPerson = "";
  beforeAll(async () => {
    const admin = adminClient();
    const own = { workspace_id: WS1, owner_user_id: USERS.owner.id };
    orgId = (await admin.from("organisation").insert({ ...own, display_name: name }).select("id").single()).data!.id;
    openReq = (await admin.from("requirement").insert({ ...own, org_id: orgId, title: `Open ${t}` }).select("id").single()).data!.id;
    closedReq = (await admin.from("requirement").insert({ ...own, org_id: orgId, title: `Done ${t}`, status: "closed" }).select("id").single()).data?.id ?? "";
    otherWsOrg = (await admin.from("organisation").insert({ workspace_id: WS2, owner_user_id: USERS.other.id, display_name: `${name} other` }).select("id").single()).data!.id;
    mtg = (await admin.from("meeting_visit").insert({ ...own, title: `Site visit ${t}`, start_at: "2026-11-12T05:00:00Z", end_at: "2026-11-12T06:00:00Z" }).select("id").single()).data!.id;
    person = (await admin.from("person").insert({ ...own, full_name: `Quorrin ${t}` }).select("id").single()).data!.id;
    await admin.from("employment").insert({ ...own, person_id: person, org_id: orgId, title: "Head of Workplace", is_current: true });
    otherPerson = (await admin.from("person").insert({ workspace_id: WS2, owner_user_id: USERS.other.id, full_name: `Quorrin ${t} other` }).select("id").single()).data!.id;
    c = { db: await userClient("owner"), workspaceId: WS1 };
  });

  it("leases (by tenant company or building) and transactions (by code/name) for the capture link pickers", async () => {
    const admin = adminClient(); const own = { workspace_id: WS1, owner_user_id: USERS.owner.id };
    const asset = (await admin.from("asset").insert({ ...own, name: `Lkbldg ${t}` }).select("id").single()).data!.id;
    const lease = (await admin.from("lease").insert({ ...own, tenant_org_id: orgId, asset_id: asset }).select("id").single()).data!.id;
    expect((await lookupEntities(c, "lease", name)).map((h) => h.id)).toEqual([lease]);
    const byBldg = await lookupEntities(c, "lease", `Lkbldg ${t}`);
    expect(byBldg[0]).toMatchObject({ id: lease, orgId }); expect(byBldg[0].label).toContain(`Lkbldg ${t}`);
    const { createTransaction } = await import("@/modules/transactions/service");
    const tx = await createTransaction({ db: c.db, workspaceId: WS1, userId: USERS.owner.id }, { name: `Lktx ${t}`, txType: "conventional_leasing", clientOrgId: orgId } as never);
    const hits = await lookupEntities(c, "transaction", `Lktx ${t}`);
    expect(hits.map((h) => h.id)).toEqual([tx.id]); expect(hits[0].label).toContain(tx.code);
    expect((await lookupById(c, "transaction", tx.id))?.id).toBe(tx.id);
    expect((await lookupById(c, "lease", lease))?.id).toBe(lease);
  });

  it("needs 2+ chars, finds companies in this workspace only", async () => {
    expect(await lookupEntities(c, "company", "z")).toEqual([]);
    const hits = await lookupEntities(c, "company", name);
    expect(hits.map((h) => h.id)).toEqual([orgId]);
    expect(hits.map((h) => h.id)).not.toContain(otherWsOrg);
  });

  it("requirements: by title or company name, scoped list shows open ones only", async () => {
    expect((await lookupEntities(c, "requirement", `Open ${t}`))[0]).toMatchObject({ id: openReq, orgId });
    expect((await lookupEntities(c, "requirement", name)).map((h) => h.id)).toContain(openReq);
    const scoped = (await lookupEntities(c, "requirement", "", { orgId })).map((h) => h.id);
    expect(scoped).toContain(openReq);
    if (closedReq) expect(scoped).not.toContain(closedReq);
  });

  it("meetings by title with date context; ids resolve to labels; filter text sanitised", async () => {
    const m = await lookupEntities(c, "meeting", `visit ${t}`);
    expect(m[0]).toMatchObject({ id: mtg }); expect(m[0].context).toMatch(/2026/);
    expect((await lookupById(c, "requirement", openReq))?.label).toBe(`Open ${t}`);
    expect(await lookupById(c, "company", otherWsOrg)).toBeNull();
    expect(await lookupById(c, "company", "not-a-uuid")).toBeNull();
    expect(safeTerm("a,b),id.eq.x%")).not.toMatch(/[,()%.]/);
    await expect(lookupEntities(c, "company", "x),or(id.neq.0")).resolves.toEqual([]);
  });

  it("people: by name in this workspace only, with title and company context", async () => {
    expect(await lookupEntities(c, "person", "q")).toEqual([]);
    const hits = await lookupEntities(c, "person", `Quorrin ${t}`);
    expect(hits.map((h) => h.id)).toEqual([person]);
    expect(hits[0]).toMatchObject({ label: `Quorrin ${t}`, orgId });
    expect(hits[0].context).toContain(name);
    expect((await lookupById(c, "person", person))?.label).toBe(`Quorrin ${t}`);
    expect(await lookupById(c, "person", otherPerson)).toBeNull();
  });
});
