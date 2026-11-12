import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminClient, USERS, WS1, tag } from "../../../tests/helpers";
import { encryptSecret } from "@/lib/util/crypto";
import { exportWorkspace, restoreSampleCheck, restoreTableSample, deleteExportFiles, exportTables, fetchTableRows, BACKUP_BUCKET, RESTORE_TEST, type RestoreTableResult } from "./backup";

// Acceptance (workflow 22): "backup recovery is periodically tested" — a real restore into scratch copies of the live tables.
describe("real restore test (monthly restore sample)", () => {
  const admin = adminClient();
  let ws = "";
  const prefixes: string[] = [];
  beforeAll(async () => {
    const slug = tag("rs").toLowerCase();
    const { data, error } = await admin.from("workspace").insert({ name: `Restore ${slug}`, slug }).select().single();
    if (error) throw error;
    ws = data.id;
    await admin.from("membership").insert({ workspace_id: ws, user_id: USERS.owner.id, role: "owner", see_all_accounts: true });
  });
  afterAll(async () => {
    for (const p of prefixes) await deleteExportFiles(admin, p);
    if (ws) await admin.from("workspace").delete().eq("id", ws);
  });

  it("restores the exported rows into temp copies of the live tables, compares them value by value and records it in backup_run findings", async () => {
    await admin.from("organisation").insert({ workspace_id: ws, display_name: "Restore Org" });
    await admin.from("asset").insert({ workspace_id: ws, name: "Restore Tower", total_area_sf: 1234.5 });
    const { data: p } = await admin.from("person").insert({ workspace_id: ws, full_name: "Restore Person" }).select().single();
    await admin.from("contact_method").insert({ workspace_id: ws, person_id: p.id, method_type: "email", value: "r@example.test" });

    const exp = await exportWorkspace(admin, ws);
    prefixes.push(exp.storage_prefix);
    const run = await restoreSampleCheck(admin, ws, { exportId: exp.id });
    expect(run.status).toBe("succeeded");
    const r = run.findings.restore;
    expect(r.failed).toEqual([]);
    expect(r.tables_restored).toBeGreaterThanOrEqual(5); // membership, organisation, asset, person, contact_method (+ audit)
    expect(r.rows_restored).toBeGreaterThanOrEqual(5);
    expect(Object.keys(r.hashes)).toEqual(expect.arrayContaining(["asset", "contact_method", "organisation", "person"]));
    expect(run.findings.duration_ms).toBeLessThan(40_000);
    // nothing leaked into live tables
    const { count } = await admin.from("organisation").select("id", { count: "exact", head: true }).eq("workspace_id", ws);
    expect(count).toBe(1);

    // An export that cannot be restored into the current schema fails the check (and the supervisor alerts on it)
    const bad = JSON.stringify({ table: "organisation", workspace_id: ws, rows: [{ id: "not-a-uuid", workspace_id: ws, display_name: "x" }] });
    const file = `${exp.storage_prefix}/organisation.json${exp.encrypted ? ".enc" : ""}`;
    await admin.storage.from(BACKUP_BUCKET).upload(file, new Blob([exp.encrypted ? encryptSecret(bad) : bad]), { upsert: true });
    const failed = await restoreSampleCheck(admin, ws, { exportId: exp.id });
    expect(failed.status).toBe("failed");
    expect(failed.findings.mismatches.map((m: { problem: string }) => m.problem).join("\n")).toMatch(/restore failed: 22P02/);
    expect(failed.findings.restore.failed.map((f: { table: string }) => f.table)).toEqual(["organisation"]);
  });

  it("detects values a restore would change (numeric scale) and rows from another workspace", async () => {
    const id = crypto.randomUUID();
    const lossy = await restoreTableSample(admin, ws, "asset", [{ id, workspace_id: ws, name: "Lossy", total_area_sf: 1.234 }]);
    expect(lossy).toMatchObject({ rows_in: 1, rows_restored: 1, value_mismatch_rows: 1, value_mismatch_columns: ["total_area_sf"] });
    const fine = await restoreTableSample(admin, ws, "asset", [{ id, workspace_id: ws, name: "Fine", total_area_sf: 1.5 }]);
    expect(fine).toMatchObject({ rows_restored: 1, value_mismatch_rows: 0 }); // 1.5 == 1.50 after restore
    const foreign = await restoreTableSample(admin, ws, "asset", [{ id, workspace_id: WS1, name: "Other tenant" }]);
    expect(foreign.error).toMatch(/another workspace/);
  });

  it("a full restore pass over every workspace table (live seeded data) finishes well under 40 s with no false mismatches", async () => {
    const tables = await exportTables(admin);
    expect(tables.length).toBeGreaterThan(50);
    const started = Date.now();
    const results: RestoreTableResult[] = [];
    const queue = [...tables];
    await Promise.all(Array.from({ length: RESTORE_TEST.concurrency }, async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
        // The restore check restores RESTORE_TEST.rowsPerTable rows per table; reading the whole (ever-growing shared) WS1 table
        // just to sample it measured the test DB size, not restore speed. Read exactly the rows the restore check restores.
        const data = await fetchTableRows(admin, WS1, t, { maxRows: RESTORE_TEST.rowsPerTable });
        results.push(await restoreTableSample(admin, WS1, t, JSON.parse(JSON.stringify(data)))); // same JSON round trip as a stored export
      }
    }));
    const ms = Date.now() - started;
    expect(ms).toBeLessThan(40_000);
    expect(results.filter((r) => r.error)).toEqual([]);
    expect(results.filter((r) => (r.value_mismatch_rows ?? 0) > 0)).toEqual([]);
    expect(results.filter((r) => (r.duplicate_ids ?? 0) > 0)).toEqual([]);
  }, 60_000);
});
