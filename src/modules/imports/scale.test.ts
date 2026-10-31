/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed PostgREST rows in assertions */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { userClient, adminClient, USERS, tag } from "../../../tests/helpers";
import { processBatch, registerImport } from "./pipeline";
import { LEASE_LARGE_HEADER, largeLeaseRow, xlsxBytes, type FixtureCell } from "./testkit";

// Volume check at the size of the real large lease tab (815 rows): one pass, then an idempotent re-run.
describe("imports pipeline at source volume", () => {
  const admin = adminClient();
  let ws = "";
  beforeAll(async () => {
    const slug = tag("impscale").toLowerCase();
    const { data, error } = await admin.from("workspace").insert({ name: `Imports scale ${slug}`, slug }).select().single();
    if (error) throw error;
    ws = data.id;
    await admin.from("membership").insert({ workspace_id: ws, user_id: USERS.owner.id, role: "owner", see_all_accounts: true,
      allowed_classifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"] });
  });
  afterAll(async () => {
    if (!ws) return;
    const { data: objs } = await admin.storage.from("workspace-files").list(`${ws}/imports`, { limit: 100 });
    for (const o of objs ?? []) {
      const { data: files } = await admin.storage.from("workspace-files").list(`${ws}/imports/${o.name}`);
      await admin.storage.from("workspace-files").remove((files ?? []).map((f) => `${ws}/imports/${o.name}/${f.name}`));
    }
    await admin.from("workspace").delete().eq("id", ws);
  });

  it("815 lease rows: all reconcile; size labels classified from data; re-run creates nothing", async () => {
    const rows: FixtureCell[][] = [LEASE_LARGE_HEADER];
    for (let i = 0; i < 815; i++) {
      const area = i % 4 === 0 ? 4500 + i : 8000 + i * 10; // ~25% under 8,000 SF: classified, never discarded
      rows.push(largeLeaseRow({ row: i + 2, building: `Bldg ${i % 120}`, locality: `Loc ${i % 15}`, area, tenant: `Tenant ${i % 400} Ltd`, start: "2021-01-31", tenure: i % 100 === 7 ? 60.5 : 36 + (i % 48) }));
    }
    const db = await userClient("owner");
    const bytes = await xlsxBytes([{ name: "Lease Expiry", rows }]);
    const reg = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "large.xlsx", bytes });
    const t0 = Date.now();
    const r = await processBatch(db, { workspaceId: ws, batchId: reg.batchId });
    const ms = Date.now() - t0;
    expect(r.counts).toMatchObject({ rows_considered: 815, accepted: 815, reconciles: true });
    expect(r.counts!.observations.lease_event.new).toBe(815);
    const { data: staged } = await db.from("staged_row").select("mapped_json->size_class").eq("batch_id", reg.batchId).range(0, 999);
    const small = staged!.filter((s: any) => s.size_class === "below_min" || s.size_class === "in_scope_small").length;
    expect(small).toBeGreaterThan(150);
    const again = await processBatch(db, { workspaceId: ws, batchId: reg.batchId, allowFrom: ["completed", "completed_with_exceptions"] });
    expect(again.counts!.observations.lease_event).toEqual({ new: 0, existing: 815 });
    expect(ms).toBeLessThan(60_000);
  }, 180_000);
});
