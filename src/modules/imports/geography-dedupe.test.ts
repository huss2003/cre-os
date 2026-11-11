/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed PostgREST rows in assertions */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { userClient, adminClient, USERS, tag } from "../../../tests/helpers";
import { processBatch, registerImport } from "./pipeline";
import { ASSET_HEADER, xlsxBytes, type FixtureCell } from "./testkit";

type Db = SupabaseClient<any, any, any>;

describe("imports: places are reused, archived masters are not re-linked (DB)", () => {
  const admin = adminClient();
  let ws = "";
  let db: Db;
  const t = tag("geo");
  let kharadi = "";

  beforeAll(async () => {
    const slug = t.toLowerCase();
    const { data, error } = await admin.from("workspace").insert({ name: `Geo test ${slug}`, slug }).select().single();
    if (error) throw error;
    ws = data.id;
    const m = await admin.from("membership").insert({ workspace_id: ws, user_id: USERS.owner.id, role: "owner", see_all_accounts: true,
      allowed_classifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"] });
    if (m.error) throw m.error;
    db = await userClient("owner");
    const city = (await db.from("geography").insert({ workspace_id: ws, level: "city", name: "Pune" }).select("id").single()).data!.id;
    kharadi = (await db.from("geography").insert({ workspace_id: ws, level: "locality", name: "Kharadi", parent_id: city, aliases: ["Kharadi Bypass"] }).select("id").single()).data!.id;
    await db.from("entity_alias").insert({ workspace_id: ws, entity_type: "geography", entity_id: kharadi, raw_alias: "EON Kharadi", canonical_alias: "eon kharadi" });
    // an archived "Baner" must never be matched
    await db.from("geography").insert({ workspace_id: ws, level: "locality", name: "Baner", archived_at: new Date().toISOString() });
  });
  afterAll(async () => {
    if (!ws) return;
    for (const prefix of [`${ws}/imports`, `${ws}/private/imports`]) {
      const { data: objs } = await admin.storage.from("mudar-workspace-files").list(prefix, { limit: 100 });
      for (const o of objs ?? []) {
        const { data: files } = await admin.storage.from("mudar-workspace-files").list(`${prefix}/${o.name}`);
        await admin.storage.from("mudar-workspace-files").remove((files ?? []).map((f) => `${prefix}/${o.name}/${f.name}`));
      }
    }
    await admin.from("workspace").delete().eq("id", ws);
  });

  const rows = (area: number): FixtureCell[][] => [
    ASSET_HEADER,
    [`Alpha ${t}`, "  KHARADI ", 9000, area, "G+4", "Ready", 0],
    [`Beta ${t}`, "kharadi bypass", 9000, 40000, "G+4", "Ready", 0],
    [`Gamma ${t}`, "EON  Kharadi", 9000, 40000, "G+4", "Ready", 0],
    [`Delta ${t}`, "Baner", 9000, 40000, "G+4", "Ready", 0],
  ];

  it("matches existing places by name / aliases / entity_alias case- and space-insensitively; never matches archived", async () => {
    const reg = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "assets.xlsx", bytes: await xlsxBytes([{ name: "Existing assets", rows: rows(30000) }]) });
    const r = await processBatch(db, { workspaceId: ws, batchId: reg.batchId });
    expect(r.counts!.masters.asset).toEqual({ new: 4, existing_linked: 0 });
    const { data: geos } = await db.from("geography").select("id, name").eq("workspace_id", ws).is("archived_at", null).neq("level", "city");
    expect(geos!.map((g) => g.name).sort()).toEqual(["Baner", "Kharadi"]); // one live Baner created, no second Kharadi
    const { data: assets } = await db.from("asset").select("name, locality_id").eq("workspace_id", ws).in("name", [`Alpha ${t}`, `Beta ${t}`, `Gamma ${t}`]);
    expect(assets!.every((a) => a.locality_id === kharadi)).toBe(true);
  });

  it("re-import after the buildings were archived creates fresh masters instead of linking to archived ones", async () => {
    await db.from("asset").update({ archived_at: new Date().toISOString() }).eq("workspace_id", ws).like("name", `%${t}`);
    const reg = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "assets.xlsx", bytes: await xlsxBytes([{ name: "Existing assets", rows: rows(35000) }]) });
    const r = await processBatch(db, { workspaceId: ws, batchId: reg.batchId });
    expect(r.counts!.masters.asset).toEqual({ new: 4, existing_linked: 0 });
    const { count: live } = await db.from("asset").select("id", { count: "exact", head: true }).eq("workspace_id", ws).is("archived_at", null);
    const { count: arch } = await db.from("asset").select("id", { count: "exact", head: true }).eq("workspace_id", ws).not("archived_at", "is", null);
    expect([live, arch]).toEqual([4, 4]); // archived ones stay archived (not resurrected)
    // a third run links to the fresh ones
    const reg3 = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "assets.xlsx", bytes: await xlsxBytes([{ name: "Existing assets", rows: rows(36000) }]) });
    const r3 = await processBatch(db, { workspaceId: ws, batchId: reg3.batchId });
    expect(r3.counts!.masters.asset).toEqual({ new: 0, existing_linked: 4 });
  });
});
