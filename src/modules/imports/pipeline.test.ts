/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed PostgREST rows in assertions */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { userClient, adminClient, USERS, tag } from "../../../tests/helpers";
import { approveMapping, decideMatch, processBatch, registerImport, detId } from "./pipeline";
import { uploadImport } from "./service";
import { ASSET_HEADER, LEASE_COMMON, LEASE_LARGE_HEADER, largeLeaseRow, xlsxBytes, type FixtureCell } from "./testkit";

type Db = SupabaseClient<any, any, any>;

// Runs in a private throwaway workspace (deleted afterwards, cascading every row these tests create).
describe("imports pipeline (DB)", () => {
  const admin = adminClient();
  let ws = "";
  let db: Db;
  const t = tag("imp");

  beforeAll(async () => {
    const slug = t.toLowerCase();
    const { data, error } = await admin.from("workspace").insert({ name: `Imports test ${slug}`, slug }).select().single();
    if (error) throw error;
    ws = data.id;
    const m = await admin.from("membership").insert([
      { workspace_id: ws, user_id: USERS.owner.id, role: "owner", see_all_accounts: true,
        allowed_classifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"] },
      { workspace_id: ws, user_id: USERS.colleague.id, role: "editor", see_all_accounts: false,
        allowed_classifications: ["public", "permitted_personal", "corporate_confidential"] },
    ]);
    if (m.error) throw m.error;
    db = await userClient("owner");
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

  const B = (s: string) => `${s} ${t}`; // unique building names
  const assetRows = (towerTwoArea: number): FixtureCell[][] => [
    ASSET_HEADER,
    [B("Orion Park Tower 1"), "Kharadi", "20,000 - 25,000", 300000, "G+10", "Ready", 4],
    [B("Orion Park Tower 2"), "Kharadi", "18000-22000", towerTwoArea, "G+8", "Ready", 1],
    [B("Vega House"), "Baner", 9000, 45000, "G+4", "Under Construction", 0],
  ];
  const upcomingRows: FixtureCell[][] = [
    [B("Orion Park Tower 1"), "Kharadi", "20,000 - 25,000", 300000, "G+10", "Ready", 4],
    [B("Vega House"), "Baner", "9000", 45000, "G+4", "Under Construction", 0],
  ];
  let firstBatch = "";
  let firstBytes: Uint8Array;

  it("headerless upcoming tab: quarantined until an approved positional map; then 2/2 keys link to existing masters, no availability", async () => {
    firstBytes = await xlsxBytes([{ name: "Existing assets", rows: assetRows(0) }, { name: "Upcoming inventory", rows: upcomingRows }]);
    const reg = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "existing and upcoming Assets.xlsx", bytes: firstBytes });
    expect(reg.duplicate).toBe(false);
    firstBatch = reg.batchId;
    const r1 = await processBatch(db, { workspaceId: ws, batchId: reg.batchId });
    expect(r1.status).toBe("completed_with_exceptions");
    expect(r1.counts).toMatchObject({ rows_considered: 5, accepted: 3, quarantined: 2, excluded: 0, layout_rows: 1, reconciles: true });
    expect(r1.counts!.masters.asset).toEqual({ new: 3, existing_linked: 0 });
    const { data: ex } = await db.from("import_exception").select("kind, severity, status").eq("batch_id", reg.batchId).eq("kind", "unknown_schema");
    expect(ex).toEqual([{ kind: "unknown_schema", severity: "blocking", status: "open" }]);

    const { data: b } = await db.from("import_batch").select("sheets").eq("id", reg.batchId).single();
    const sheet = b!.sheets.find((s: { sheet: string }) => s.sheet === "Upcoming inventory");
    const sug = sheet.suggestions.find((s: { positional: boolean }) => s.positional);
    await approveMapping(db, ws, USERS.owner.id, { batchId: reg.batchId, sheet: "Upcoming inventory", adapter: sug.adapter, role: sug.role, columnMap: sug.columnMap, positional: true, headerRow: 0 });
    const r2 = await processBatch(db, { workspaceId: ws, batchId: reg.batchId, allowFrom: ["completed", "completed_with_exceptions", "needs_mapping", "failed"] });
    expect(r2.counts).toMatchObject({ rows_considered: 5, accepted: 5, quarantined: 0, reconciles: true });
    expect(r2.counts!.masters.asset).toEqual({ new: 3, existing_linked: 0 }); // upcoming rows link to the same 3 masters
    expect(r2.counts!.observations.asset_observation.new).toBe(2);
    const { data: up } = await db.from("staged_row").select("row_number, status, flags, targets").eq("batch_id", reg.batchId).eq("sheet", "Upcoming inventory").order("row_number");
    expect(up!.map((r) => r.row_number)).toEqual([1, 2]); // first row retained as data
    expect(up!.every((r) => r.flags.includes("positional_map"))).toBe(true);
    const { data: ex2 } = await db.from("import_exception").select("status").eq("batch_id", reg.batchId).eq("kind", "unknown_schema");
    expect(ex2![0].status).toBe("resolved");
    expect(up!.every((r) => r.targets.some((x: { type: string; created: boolean }) => x.type === "asset"))).toBe(true);
    const { count: avail } = await db.from("availability").select("id", { count: "exact", head: true }).eq("workspace_id", ws);
    const { count: spaces } = await db.from("space").select("id", { count: "exact", head: true }).eq("workspace_id", ws);
    expect([avail, spaces]).toEqual([0, 0]); // no "upcoming" availability invented
    // source zero kept as a flag, total area unknown; towers of one campus are two masters
    const { data: towers } = await db.from("asset").select("name, total_area_sf, total_area_source_zero").eq("workspace_id", ws).ilike("name", `%Orion Park Tower%`).order("name");
    expect(towers).toEqual([
      { name: B("Orion Park Tower 1"), total_area_sf: 300000, total_area_source_zero: false },
      { name: B("Orion Park Tower 2"), total_area_sf: null, total_area_source_zero: true },
    ]);
    const { count: aliases } = await db.from("entity_alias").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("entity_type", "asset");
    expect(aliases).toBe(3);
  });

  it("import repeat: same hash is a no-op (even under another file name); revised version keeps old observations and shows a field diff", async () => {
    const again = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "renamed copy.xlsx", bytes: firstBytes });
    expect(again).toMatchObject({ duplicate: true, batchId: firstBatch });
    const { count: batches } = await db.from("import_batch").select("id", { count: "exact", head: true }).eq("workspace_id", ws);
    expect(batches).toBe(1);

    const revised = await xlsxBytes([{ name: "Existing assets", rows: assetRows(150000) }, { name: "Upcoming inventory", rows: upcomingRows }]);
    const reg = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "existing and upcoming Assets.xlsx", bytes: revised });
    expect(reg).toMatchObject({ duplicate: false, version: 2 });
    const r = await processBatch(db, { workspaceId: ws, batchId: reg.batchId });
    expect(r.status).toBe("completed"); // the approved positional mapping is reused for the new version
    expect(r.counts!.masters.asset).toEqual({ new: 0, existing_linked: 3 });
    expect(r.counts!.observations.asset_observation).toEqual({ new: 5, existing: 0 }); // revisions create new observations
    const { data: b } = await db.from("import_batch").select("diff, previous_batch_id").eq("id", reg.batchId).single();
    expect(b!.previous_batch_id).toBe(firstBatch);
    expect(b!.diff).toMatchObject({ changed: 1, unchanged: 4, added: 0, removed: 0 });
    expect(b!.diff.samples[0].fields).toContainEqual({ field: "total_area", before: 0, after: 150000 });
    // old observation preserved; master not overwritten
    const { data: obs } = await db.from("asset_observation").select("total_area_sf, total_area_source_zero").eq("workspace_id", ws).eq("building_name_raw", B("Orion Park Tower 2")).order("created_at");
    expect(obs).toEqual([{ total_area_sf: null, total_area_source_zero: true }, { total_area_sf: 150000, total_area_source_zero: false }]);
    const { data: master } = await db.from("asset").select("total_area_sf").eq("workspace_id", ws).eq("name", B("Orion Park Tower 2")).single();
    expect(master!.total_area_sf).toBeNull();
    // re-processing the same batch creates nothing new
    const again2 = await processBatch(db, { workspaceId: ws, batchId: reg.batchId, allowFrom: ["completed"] });
    expect(again2.counts!.observations.asset_observation).toEqual({ new: 0, existing: 5 });
  });

  it("lease chronology: lease + lock-in events distinct on one lease, EDATE dates, fractional tenure needs review; re-run creates no events", async () => {
    const tenant = `Acme ${t} Technologies Pvt Ltd`;
    const bytes = await xlsxBytes([
      { name: "Lease Expiry", rows: [
        LEASE_LARGE_HEADER,
        largeLeaseRow({ row: 2, building: B("Orion Park Tower 1"), locality: "Kharadi", area: 7500, tenant, start: "2021-01-31", tenure: 61, cached: "2026-02-28" }),
        largeLeaseRow({ row: 3, building: B("Vega House"), locality: "Baner", area: 12000, tenant: `Acme ${t} Technologies Private Limited`, start: "2020-03-15", tenure: 60.5, cached: "2025-03-15" }),
      ] },
      { name: "Lock-in Expiry", rows: [
        LEASE_COMMON,
        largeLeaseRow({ row: 2, building: B("Orion Park Tower 1"), locality: "Kharadi", area: 7500, tenant, start: "2021-01-31", tenure: 36, cached: "2024-01-31" }).slice(0, 12),
      ] },
    ]);
    const reg = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "office leases expiry 8,000 SF plus in Pune.xlsx", bytes });
    const r = await processBatch(db, { workspaceId: ws, batchId: reg.batchId });
    expect(r.counts).toMatchObject({ rows_considered: 3, accepted: 3, reconciles: true });
    expect(r.counts!.observations.lease).toEqual({ new: 2, existing: 0 });
    expect(r.counts!.observations.lease_event).toEqual({ new: 3, existing: 0 });
    expect(r.counts!.masters.asset).toEqual({ new: 0, existing_linked: 2 }); // buildings resolved to existing masters
    const { data: events } = await db.from("lease_event").select("event_type, event_date, date_basis, needs_review, formula_raw, lease:lease_id(tenant_name_raw, tenure_months_raw, lockin_months_raw)")
      .eq("workspace_id", ws).order("event_type");
    const byKey = Object.fromEntries(events!.map((e: any) => [`${e.event_type}:${e.lease.tenant_name_raw}`, e]));
    expect(byKey[`expiry:${tenant}`]).toMatchObject({ event_date: "2026-02-28", date_basis: "calculated_from_source_tenure", needs_review: false });
    expect(byKey[`expiry:${tenant}`].formula_raw).toContain("=EDATE(K2,L2)");
    expect(byKey[`lockin_end:${tenant}`]).toMatchObject({ event_date: "2024-01-31", needs_review: false });
    expect(byKey[`lockin_end:${tenant}`].lease).toMatchObject({ tenure_months_raw: 61, lockin_months_raw: 36 });
    const frac = events!.find((e: any) => e.lease.tenant_name_raw !== tenant)!;
    expect(frac).toMatchObject({ event_date: null, needs_review: true });
    const again = await processBatch(db, { workspaceId: ws, batchId: reg.batchId, allowFrom: ["completed", "completed_with_exceptions"] });
    expect(again.counts!.observations.lease_event).toEqual({ new: 0, existing: 3 });
    const { count } = await db.from("lease_event").select("id", { count: "exact", head: true }).eq("workspace_id", ws);
    expect(count).toBe(3);
  });

  it("identity ambiguity: legal-form variants are NOT auto-merged; link goes through a merge proposal; towers never become candidates", async () => {
    const { data: cands } = await db.from("identity_match_candidate").select("*").eq("workspace_id", ws);
    const org = cands!.find((c: any) => c.entity_type === "organisation");
    expect(org).toBeTruthy();
    expect(org.decision).toBe("pending");
    expect(Number(org.score)).toBeGreaterThanOrEqual(0.8);
    expect(cands!.some((c: any) => c.entity_type === "asset" && /Orion Park Tower/.test(JSON.stringify(c.right_raw)))).toBe(false);
    const { count: orgs } = await db.from("organisation").select("id", { count: "exact", head: true }).eq("workspace_id", ws);
    expect(orgs).toBe(2);
    const res = await decideMatch(db, ws, USERS.owner.id, org.id, "link");
    expect(res.decision).toBe("merge_proposed");
    const { data: cp } = await db.from("change_proposal").select("operation, risk, state, target_id").eq("id", res.changeProposalId!).single();
    expect(cp).toMatchObject({ operation: "merge", risk: "identity_merge", state: "proposed", target_id: org.left_id });
    await expect(decideMatch(db, ws, USERS.owner.id, org.id, "keep_separate")).rejects.toThrow(/already decided/);
  });

  it("unknown market schema needs mapping; supply matrix stores observations and Total as a control", async () => {
    const csv = `,Total Supply in Million SQFT,,\nYear/Quarter,CBD ${t},SBD East ${t},Total\n2024,1.11,2.22,3.33\n2026,,,\n`;
    const reg = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "Pune_supply_2018_2026 - Copy.csv", bytes: new TextEncoder().encode(csv) });
    const r = await processBatch(db, { workspaceId: ws, batchId: reg.batchId });
    expect(r.status).toBe("completed");
    expect(r.counts).toMatchObject({ rows_considered: 2, accepted: 1, excluded: 1, controls_failed: 0, reconciles: true });
    expect(r.counts!.observations.market_observation).toEqual({ new: 2, existing: 0 });
    const { data: mo } = await db.from("market_observation").select("metric, unit, value, period_type").eq("workspace_id", ws).order("value");
    expect(mo).toEqual([
      { metric: "supply", unit: "million_sf", value: 1.11, period_type: "full_year" },
      { metric: "supply", unit: "million_sf", value: 2.22, period_type: "full_year" },
    ]);
    const unknown = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "mystery.csv", bytes: new TextEncoder().encode("foo,bar\n1,2\n") });
    const u = await processBatch(db, { workspaceId: ws, batchId: unknown.batchId });
    expect(u.status).toBe("needs_mapping");
    expect(u.counts).toMatchObject({ rows_considered: 2, quarantined: 2, reconciles: true });
  });

  it("an editor cannot approve a schema mapping directly through PostgREST (DB guard)", async () => {
    const colleague = await userClient("colleague");
    const { error } = await colleague.from("adapter_mapping").insert({
      workspace_id: ws, name: "sneaky", adapter: "asset_list_v1", sheet_role: "assets_headerless", schema_signature: "headerless:7:x",
      column_map: { building: 0, locality: 1 }, approved: true,
    });
    expect(error?.message).toMatch(/only workspace admins/);
  });

  it("service upload: restricted sources are owner-only and stored under the private prefix; kill switch stops processing", async () => {
    const csv = new TextEncoder().encode(`,Total Absorption in Million SQFT\nYear/Quarter,CBD ${t}\n2023,1.5\n`);
    await expect(uploadImport({ db: await userClient("colleague"), workspaceId: ws, userId: USERS.colleague.id, role: "editor" },
      { name: "abs.csv", bytes: csv }, { classification: "licensed_restricted" })).rejects.toThrow(/only the workspace owner/);
    const res = await uploadImport({ db, workspaceId: ws, userId: USERS.owner.id, role: "owner" }, { name: "abs.csv", bytes: csv }, { classification: "licensed_restricted" });
    expect(res).toMatchObject({ duplicate: false, status: "completed" });
    const { data: so } = await db.from("source_object").select("meta, classification").eq("id", res.source_object_id).single();
    expect(so!.meta.storage_path).toMatch(new RegExp(`^${ws}/private/imports/`));
    expect(so!.classification).toBe("licensed_restricted");
    const { data: mo } = await db.from("market_observation").select("classification, definition").eq("workspace_id", ws).eq("metric", "absorption");
    expect(mo![0].classification).toBe("licensed_restricted");
    expect(mo![0].definition).toMatch(/gross\/net not stated/);

    await admin.from("workspace").update({ ai_paused: true }).eq("id", ws);
    try {
      const reg = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "paused.csv", bytes: new TextEncoder().encode("a,b\n1,2\n") });
      const r = await processBatch(db, { workspaceId: ws, batchId: reg.batchId });
      expect(r.status).toBe("paused");
      const { data: b } = await db.from("import_batch").select("status, error").eq("id", reg.batchId).single();
      expect(b!.status).toBe("registered");
      expect(b!.error).toMatch(/paused/);
    } finally {
      await admin.from("workspace").update({ ai_paused: false }).eq("id", ws);
    }
  });

  it("deterministic ids are workspace-scoped", () => {
    expect(detId(ws, "asset", "a|b")).not.toBe(detId("10000000-0000-4000-8000-000000000001", "asset", "a|b"));
    expect(detId(ws, "asset", "a|b")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
