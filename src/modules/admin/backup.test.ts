import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminClient, USERS, tag } from "../../../tests/helpers";
import { exportWorkspace, restoreSampleCheck, deleteExportFiles, BACKUP_BUCKET } from "./backup";
import { backupStatus } from "./health";

// Private throwaway workspace: exports never touch other modules' fixtures.
describe("logical export + restore-sample round trip (acceptance: Backups)", () => {
  const admin = adminClient();
  let wsId = "";
  const prefixes: string[] = [];
  beforeAll(async () => {
    const slug = tag("bk").toLowerCase();
    const { data: ws, error } = await admin.from("workspace").insert({ name: `Backup ${slug}`, slug }).select().single();
    if (error) throw error;
    wsId = ws.id;
    await admin.from("membership").insert({ workspace_id: wsId, user_id: USERS.owner.id, role: "owner", see_all_accounts: true });
  });
  afterAll(async () => {
    for (const p of prefixes) await deleteExportFiles(admin, p);
    if (wsId) await admin.from("workspace").delete().eq("id", wsId);
  });

  it("exports every workspace table, verifies counts/hashes, flags suppressions newer than the export, detects tampering", async () => {
    const { data: org } = await admin.from("organisation").insert({ workspace_id: wsId, display_name: "Backup Org" }).select().single();
    const { data: p } = await admin.from("person").insert({ workspace_id: wsId, full_name: "Backup Person" }).select().single();
    const { data: cm } = await admin.from("contact_method").insert({ workspace_id: wsId, person_id: p.id, method_type: "email", value: "b@example.test" }).select().single();
    expect(org && cm).toBeTruthy();

    const exp = await exportWorkspace(admin, wsId);
    prefixes.push(exp.storage_prefix);
    expect(exp.status).toBe("succeeded");
    expect(exp.table_counts.organisation).toBe(1);
    expect(exp.table_counts.contact_method).toBe(1);
    expect(exp.table_counts.membership).toBe(1);
    expect(Object.keys(exp.table_counts).length).toBeGreaterThan(30);
    expect(exp.table_counts.job).toBeUndefined();

    const ok = await restoreSampleCheck(admin, wsId, { exportId: exp.id });
    expect(ok.status).toBe("succeeded");
    expect(ok.findings.mismatches).toEqual([]);
    expect(ok.verified_export_id).toBe(exp.id);

    // Suppress the contact AFTER the export: a naive restore would reactivate it -> warning with the id
    await admin.from("contact_method").update({ suppressed: true }).eq("id", cm.id).eq("workspace_id", wsId);
    const warn = await restoreSampleCheck(admin, wsId, { exportId: exp.id, sample: 2 });
    expect(warn.status).toBe("warning");
    expect(warn.findings.hazards.contact_suppressions_newer_than_export).toEqual([cm.id]);

    // Tamper with an exported file -> integrity failure
    const file = `${exp.storage_prefix}/organisation.json${exp.encrypted ? ".enc" : ""}`;
    const bogus = exp.encrypted ? "AAAA.AAAA.AAAA" : JSON.stringify({ table: "organisation", workspace_id: wsId, rows: [] });
    await admin.storage.from(BACKUP_BUCKET).upload(file, new Blob([bogus]), { upsert: true });
    const bad = await restoreSampleCheck(admin, wsId, { exportId: exp.id }).catch((e) => e);
    const { data: runs } = await admin.from("backup_run").select("kind, status, finished_at, started_at").eq("workspace_id", wsId).order("started_at", { ascending: false });
    expect(runs?.[0].status).toBe("failed");
    expect(bad).toBeTruthy();

    const status = backupStatus(runs ?? []);
    expect(status.rpoMet).toBe(true);
    expect(status.restoreSampleDue).toBe(false);
    expect(status.fullDrillDue).toBe(true);
  });
});
