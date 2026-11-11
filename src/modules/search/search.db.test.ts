import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, WS2, USERS, tag } from "../../../tests/helpers";
import { findAccounts, nlToFilter } from "./finder";
import { searchEverything } from "./everything";
import { search2Tools } from "../assistant/tools/search2";

type C = Awaited<ReturnType<typeof userClient>>;
const TODAY = "2026-11-11";

describe("account finder + expanded search (spec §2.9)", () => {
  let owner: C, other: C;
  const sector = tag("Sect");
  const place = tag("Kharadi");
  const ids: Record<string, string> = {};

  async function ins(table: string, row: Record<string, unknown>) {
    const { data, error } = await owner.from(table).insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, ...row }).select().single();
    if (error) throw new Error(`${table}: ${error.message}`);
    return data as { id: string };
  }

  beforeAll(async () => {
    [owner, other] = await Promise.all([userClient("owner"), userClient("other")]);
    const geo = await ins("geography", { level: "micro_market", name: place });
    const inA = await ins("asset", { asset_kind: "building", name: tag("Tower In"), micro_market_id: geo.id, grade: "A" });
    const outB = await ins("asset", { asset_kind: "building", name: tag("Tower Out"), grade: "A" });
    ids.assetIn = inA.id;
    const org = async (k: string, lease: Record<string, unknown> | null, contact: "known" | "unknown" | null) => {
      const o = await ins("organisation", { display_name: tag(`Co ${k}`), sector });
      ids[k] = o.id; ids[`name_${k}`] = (o as unknown as { display_name: string }).display_name;
      if (lease) ids[`lease_${k}`] = (await ins("lease", { tenant_org_id: o.id, status: "active", ...lease })).id;
      if (contact) {
        const p = await ins("person", { full_name: tag(`Person ${k}`) });
        await ins("employment", { person_id: p.id, org_id: o.id, title: "Admin Head", is_current: true });
        if (contact === "known") {
          const i = await ins("interaction", { occurred_at: "2026-10-01T10:00:00Z", channel: "call", direction: "outbound", subject: "Intro" });
          await ins("interaction_link", { interaction_id: i.id, entity_type: "person", entity_id: p.id });
        }
      }
    };
    await org("match", { asset_id: inA.id, area_sf: 30000, area_basis: "chargeable", contractual_expiry: "2027-06-30" }, "known");
    await org("carpet", { asset_id: inA.id, area_sf: 30000, area_basis: "carpet", contractual_expiry: "2027-03-31" }, "known");
    await org("noarea", { asset_id: inA.id, area_sf: null, contractual_expiry: "2027-04-30" }, "known");
    await org("nodates", { asset_id: inA.id, area_sf: 20000, area_basis: "chargeable" }, "known");
    await org("stranger", { asset_id: inA.id, area_sf: 25000, area_basis: "chargeable", contractual_expiry: "2027-05-31" }, "unknown");
    await org("elsewhere", { asset_id: outB.id, area_sf: 25000, area_basis: "chargeable", contractual_expiry: "2027-05-31" }, "known");
    await org("big", { asset_id: inA.id, area_sf: 50000, area_basis: "chargeable", contractual_expiry: "2027-02-28" }, "known");
    await org("soon", { asset_id: inA.id, area_sf: 18000, area_basis: "chargeable", contractual_expiry: "2029-12-31" }, "known");
    await ins("lease_event", { lease_id: ids.lease_soon, event_type: "notice_deadline", event_date: "2026-12-15", date_basis: "contractual" });
  });

  it("parses the spec example into a typed filter (with the workspace place list)", async () => {
    const r = await nlToFilter(owner, WS1, `Show companies occupying 15,000–40,000 SF in ${place} with a lease event next year and a contact I already know`, { today: TODAY });
    expect(r.filter).toMatchObject({ areaMinSf: 15000, areaMaxSf: 40000, places: [place], eventWindow: { kind: "next_calendar_year" }, knownContact: true });
    expect(r.modelFilled).toEqual([]);
  });

  it("spec example: matches only the company that passes every rule, and reports coverage honestly", async () => {
    const r = await findAccounts(owner, WS1, { sectors: [sector], areaMinSf: 15000, areaMaxSf: 40000, places: [place], eventWindow: { kind: "next_calendar_year" }, knownContact: true }, { today: TODAY });
    const got = r.results.map((h) => h.orgId);
    expect(got).toContain(ids.match);
    expect(got).toContain(ids.carpet); // basis 'any' → carpet 30k counts
    for (const k of ["noarea", "nodates", "stranger", "elsewhere", "big", "soon"]) expect(got).not.toContain(ids[k]);
    const m = r.results.find((h) => h.orgId === ids.match)!;
    expect(m.contacts?.[0].basis).toMatch(/interaction/);
    expect(m.events?.[0]).toMatchObject({ type: "expiry", date: "2027-06-30" });
    expect(r.coverage.areaUnknown).toBe(1);   // noarea
    expect(r.coverage.eventsUnknown).toBe(1); // nodates
    expect(r.window).toEqual({ from: "2027-01-01", to: "2027-12-31" });
  });

  it("respects the area basis: chargeable filter excludes a carpet-only lease and counts it as not evaluable", async () => {
    const r = await findAccounts(owner, WS1, { sectors: [sector], areaMinSf: 15000, areaMaxSf: 40000, areaBasis: "chargeable", places: [place] }, { today: TODAY });
    const got = r.results.map((h) => h.orgId);
    expect(got).toContain(ids.match);
    expect(got).not.toContain(ids.carpet);
    expect(r.coverage.areaUnknown).toBe(2); // carpet + noarea
  });

  it("lease window: within 6 months finds the notice deadline, not expiries next summer", async () => {
    const r = await findAccounts(owner, WS1, { sectors: [sector], eventTypes: ["notice_deadline"], eventWindow: { kind: "within_months", months: 6 } }, { today: TODAY });
    expect(r.results.map((h) => h.orgId)).toEqual([ids.soon]);
    const r2 = await findAccounts(owner, WS1, { sectors: [sector], eventTypes: ["expiry"], eventWindow: { kind: "within_months", months: 6 } }, { today: TODAY });
    expect(r2.results.map((h) => h.orgId).sort()).toEqual([ids.big, ids.carpet, ids.noarea].sort());
  });

  it("known-contact rule needs a current employee with an interaction or relationship", async () => {
    const r = await findAccounts(owner, WS1, { sectors: [sector], knownContact: true }, { today: TODAY });
    const got = r.results.map((h) => h.orgId);
    expect(got).not.toContain(ids.stranger);
    expect(got).toContain(ids.elsewhere);
  });

  it("workspace isolation: other tenant sees nothing, even naming WS1", async () => {
    const a = await findAccounts(other, WS1, { sectors: [sector] }, { today: TODAY });
    expect(a.results).toEqual([]);
    const b = await findAccounts(other, WS2, { sectors: [sector] }, { today: TODAY });
    expect(b.results).toEqual([]);
    expect(await searchEverything(other, WS1, { q: place })).toEqual([]);
  });

  it("expanded search covers leases, floors, meetings, tasks, signals, documents, quotes and chats", async () => {
    const t = tag("Zorblax");
    const sp = await ins("space", { asset_id: ids.assetIn, floor_text: `7 ${t}`, unit: "701" });
    const task = await ins("task", { title: `Call ${t}`, status: "open" });
    const meet = await ins("meeting_visit", { title: `Visit ${t}`, start_at: "2026-11-20T05:00:00Z", end_at: "2026-11-20T06:00:00Z", status: "confirmed" });
    const sig = await ins("signal", { category: "expansion", kind: "expansion", title: `Expansion ${t}`, org_id: ids.match, dedupe_key: t });
    const legal = await ins("legal_document", { title: `Lease deed ${t}`, doc_kind: "lease", family_key: t, text_content: "x", text_sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" });
    const conv = await ins("assistant_conversation", { title: `Chat ${t}` });
    const q = await ins("quote", { counterparty_org_id: ids.match, space_id: sp.id, version: 1, currency: "INR", terms_json: {} });
    const hits = await searchEverything(owner, WS1, { q: t });
    const byType = new Map(hits.map((h) => [h.entity_type, h]));
    expect(byType.get("space")?.id).toBe(sp.id);
    expect(byType.get("task")?.id).toBe(task.id);
    expect(byType.get("meeting")?.id).toBe(meet.id);
    expect(byType.get("signal")?.href).toBe(`/signals/${sig.id}`);
    expect(byType.get("legal_document")?.href).toBe(`/legal/${legal.id}`);
    expect(byType.get("conversation")?.href).toBe(`/assistant/${conv.id}`);
    expect((await searchEverything(owner, WS1, { types: ["quote"], q: ids.name_match })).map((h) => h.id)).toContain(q.id);

    const leases = await searchEverything(owner, WS1, { types: ["lease"], q: ids.name_match });
    expect(leases.map((h) => h.id)).toContain(ids.lease_match);
    const dated = await searchEverything(owner, WS1, { types: ["task", "meeting"], q: t, from: "2026-11-15", to: "2026-11-30" });
    expect(dated.map((h) => h.id)).toEqual([meet.id]);
  });

  it("assistant find_accounts tool takes plain text", async () => {
    const tool = search2Tools[0];
    const res = await tool.run({ text: `companies in ${place} occupying 15k-40k sf with a contact I know`, filter: { sectors: [sector] } }, { ctx: { db: owner, workspaceId: WS1, userId: USERS.owner.id } } as never);
    expect(res.ok).toBe(true);
    const items = (res.data as { items: { orgId: string }[] }).items.map((i) => i.orgId);
    expect(items).toContain(ids.match);
    expect(items).not.toContain(ids.stranger);
  });
});
