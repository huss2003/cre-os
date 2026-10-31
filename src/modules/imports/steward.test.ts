/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed PostgREST rows in assertions */
/**
 * Intake Engineer + Database Steward acceptance (workflows 01/02) in a throwaway workspace:
 * approved-source quarantine, source-vs-master conflicts (visible, proposed with evidence, never overwritten, zero
 * duplicates on re-import), person candidates via proposals, merge evidence, provenance, stale-record detector.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { userClient, adminClient, USERS, tag } from "../../../tests/helpers";
import { decideMatch, processBatch, registerImport } from "./pipeline";
import { approveSource, listSources, uploadImport } from "./service";
import { ASSET_HEADER, LEASE_LARGE_HEADER, largeLeaseRow, xlsxBytes, type FixtureCell } from "./testkit";
import { approveAndApply } from "@/modules/changes/service";
import { listConflicts, markVerified, proposeConflictFix, recordProvenance, runStaleDetector } from "@/modules/changes/steward";

describe("intake + steward (DB)", () => {
  const admin = adminClient();
  let ws = "";
  let db: any;
  const t = tag("stw");
  const B = (s: string) => `${s} ${t}`;
  const ownerCtx = () => ({ db, workspaceId: ws, userId: USERS.owner.id, role: "owner" as const });

  beforeAll(async () => {
    const { data, error } = await admin.from("workspace").insert({ name: `Steward ${t}`, slug: t.toLowerCase() }).select().single();
    if (error) throw error;
    ws = data.id;
    await admin.from("membership").insert([
      { workspace_id: ws, user_id: USERS.owner.id, role: "owner", see_all_accounts: true, allowed_classifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"] },
      { workspace_id: ws, user_id: USERS.colleague.id, role: "editor", see_all_accounts: false, allowed_classifications: ["public", "permitted_personal", "corporate_confidential"] },
    ]);
    db = await userClient("owner");
  });
  afterAll(async () => {
    if (!ws) return;
    const { data: objs } = await admin.storage.from("mudar-workspace-files").list(`${ws}/imports`, { limit: 100 });
    for (const o of objs ?? []) {
      const { data: files } = await admin.storage.from("mudar-workspace-files").list(`${ws}/imports/${o.name}`);
      await admin.storage.from("mudar-workspace-files").remove((files ?? []).map((f) => `${ws}/imports/${o.name}/${f.name}`));
    }
    await admin.from("workspace").delete().eq("id", ws);
  });

  const assets = (area: number, status: string): FixtureCell[][] => [ASSET_HEADER, [B("Helix One"), "Kharadi", "20,000 - 25,000", area, "12", status, 2]];
  const leases = (rate: number, tenure: number): FixtureCell[][] => [LEASE_LARGE_HEADER,
    largeLeaseRow({ row: 2, building: B("Helix One"), locality: "Kharadi", area: 9000, rate, tenant: `Nimbus ${t} Pvt Ltd`, start: "2022-01-31", tenure })];

  it("unknown source is quarantined until an admin approves it (editors cannot approve); then the file is processed", async () => {
    const colleague = await userClient("colleague");
    const bytes = await xlsxBytes([{ name: "Assets", rows: assets(300000, "Ready") }]);
    const up = await uploadImport({ db: colleague, workspaceId: ws, userId: USERS.colleague.id, role: "editor" }, { name: "assets.xlsx", bytes }, { source: { name: "Random USB stick", kind: "other" } });
    expect(up.status).toBe("awaiting_source");
    const { count: assetsBefore } = await admin.from("asset").select("id", { count: "exact", head: true }).eq("workspace_id", ws);
    expect(assetsBefore).toBe(0);
    const { data: ex } = await admin.from("import_exception").select("kind, severity, status").eq("batch_id", up.batch_id);
    expect(ex).toEqual([{ kind: "unapproved_source", severity: "blocking", status: "open" }]);
    const { data: src } = await admin.from("import_source").select("id, approved").eq("workspace_id", ws).eq("name_key", "random usb stick").single();
    expect(src!.approved).toBe(false);
    const { error } = await colleague.from("import_source").update({ approved: true }).eq("id", src!.id);
    expect(error?.message).toMatch(/only workspace admins/);
    const res = await approveSource(ownerCtx(), src!.id);
    expect(res.processed).toEqual([{ batch_id: up.batch_id, status: "completed" }]);
    const { data: ex2 } = await admin.from("import_exception").select("status").eq("batch_id", up.batch_id).eq("kind", "unapproved_source").single();
    expect(ex2!.status).toBe("resolved");
    // the default "Manual upload" source is approved, so plain uploads are processed
    const list = await listSources(ownerCtx());
    expect(list.find((s) => s.is_default)).toMatchObject({ name: "Manual upload", approved: true });
  });

  let leaseV2Batch = "";
  it("conflicts: a revised file that disagrees with the master raises field conflicts (material => proposal with evidence); master untouched; zero duplicates on re-import", async () => {
    // v1 leases, then v2 assets + leases with different values (same file names => new versions)
    const l1 = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "leases.xlsx", bytes: await xlsxBytes([{ name: "Lease Expiry", rows: leases(80, 36) }]) });
    await processBatch(db, { workspaceId: ws, batchId: l1.batchId });
    const a2 = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "assets.xlsx", bytes: await xlsxBytes([{ name: "Assets", rows: assets(320000, "Under Construction") }]) });
    await processBatch(db, { workspaceId: ws, batchId: a2.batchId });
    const v2bytes = await xlsxBytes([{ name: "Lease Expiry", rows: leases(95, 48) }]);
    const l2 = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "leases.xlsx", bytes: v2bytes });
    leaseV2Batch = l2.batchId;
    const r = await processBatch(db, { workspaceId: ws, batchId: l2.batchId });
    expect((r.counts as any).steward.conflicts).toBe(3); // rent, tenure, expiry date

    const { data: conf } = await admin.from("field_conflict").select("entity_type, field, master_value, source_value, material, status, change_proposal_id, staged_row_id, source_object_id, source_locator")
      .eq("workspace_id", ws).order("entity_type").order("field");
    const by = Object.fromEntries(conf!.map((c: any) => [`${c.entity_type}.${c.field}`, c]));
    expect(by["asset.total_area_sf"]).toMatchObject({ master_value: 300000, source_value: 320000, material: false, status: "open", change_proposal_id: null });
    expect(by["asset.status"]).toMatchObject({ master_value: "ready", source_value: "under_construction", material: false });
    expect(by["lease.rent_per_sf"]).toMatchObject({ master_value: 80, source_value: 95, material: true, status: "proposed", source_locator: "Lease Expiry!2" });
    expect(by["lease.tenure_months_raw"]).toMatchObject({ master_value: 36, source_value: 48, material: true, status: "proposed" });
    expect(by["lease_event.event_date"]).toMatchObject({ master_value: "2025-01-31", source_value: "2026-01-31", material: true });
    const { data: cp } = await admin.from("change_proposal").select("target_type, risk, state, evidence_ids, patch").eq("id", by["lease.rent_per_sf"].change_proposal_id).single();
    expect(cp).toMatchObject({ target_type: "lease", risk: "material_fact", state: "proposed", patch: [{ op: "replace", path: "/rent_per_sf", value: 95 }] });
    expect(cp!.evidence_ids.sort()).toEqual([by["lease.rent_per_sf"].staged_row_id, by["lease.rent_per_sf"].source_object_id].sort());
    // masters never overwritten
    const { data: lease } = await admin.from("lease").select("rent_per_sf, tenure_months_raw").eq("workspace_id", ws).single();
    expect(lease).toEqual({ rent_per_sf: 80, tenure_months_raw: 36 });
    const { data: asset } = await admin.from("asset").select("total_area_sf, status").eq("workspace_id", ws).single();
    expect(asset).toEqual({ total_area_sf: 300000, status: "ready" });

    // re-importing the same file / re-processing creates zero duplicates
    const snap = async () => ({
      conflicts: (await admin.from("field_conflict").select("id", { count: "exact", head: true }).eq("workspace_id", ws)).count,
      proposals: (await admin.from("change_proposal").select("id", { count: "exact", head: true }).eq("workspace_id", ws)).count,
    });
    const before = await snap();
    const again = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "leases (copy).xlsx", bytes: v2bytes });
    expect(again.duplicate).toBe(true);
    await processBatch(db, { workspaceId: ws, batchId: l2.batchId, allowFrom: ["completed", "completed_with_exceptions"] });
    expect(await snap()).toEqual(before);
  });

  it("conflict report shows both values + source; 'propose fix' goes through approval; afterwards the field is traceable to the source row", async () => {
    const open = await listConflicts(db, ws);
    const area = open.find((c) => c.field === "total_area_sf")!;
    expect(area).toMatchObject({ master_value_now: 300000, source_value: 320000, still_disagrees: true, source_locator: "Assets!2" });
    expect(area.source_label).toMatch(/^assets\.xlsx@v2/);
    const p = await proposeConflictFix(db, ws, area.id);
    expect(p.evidence_ids.length).toBe(2);
    await approveAndApply(db, p.id);
    expect((await listConflicts(db, ws)).some((c) => c.id === area.id)).toBe(false);   // record now agrees => resolved
    const prov = await recordProvenance(db, ws, "asset", area.entity_id);
    const fld = prov.fields.find((x) => x.field === "total_area_sf")!;
    expect(fld.value).toBe(320000);
    expect(fld.changes[0]).toMatchObject({ state: "applied", proposal_id: p.id });
    expect(fld.changes[0].evidence.map((e) => e.kind).sort()).toEqual(["file", "staged_row"]);
    expect(fld.changes[0].evidence.find((e) => e.kind === "staged_row")!.locator).toBe("Assets!2");
    expect(fld.traceable).toBe(true);
    // a material lease field imported originally is traced to its source file/rows
    const { data: lease } = await admin.from("lease").select("id").eq("workspace_id", ws).single();
    const lp = await recordProvenance(db, ws, "lease", lease!.id);
    expect(lp.untraceableMaterial).toEqual([]);
    expect(lp.fields.find((x) => x.field === "rent_per_sf")!.conflicts.length).toBe(1);
  });

  it("representative names become PROPOSED person masters (never merged by name), with evidence; applying proposes the employment link", async () => {
    const { data: props } = await admin.from("change_proposal").select("id, target_type, operation, patch, evidence_ids, state, risk").eq("workspace_id", ws).like("idempotency_key", "imports.person:%");
    expect(props).toHaveLength(1); // two lease versions + re-processing => still one proposal for (Rep Person, Nimbus)
    expect(props![0]).toMatchObject({ target_type: "person", operation: "create", state: "proposed", patch: [{ op: "add", path: "/full_name", value: "Rep Person" }] });
    expect(props![0].evidence_ids).toHaveLength(2);
    const { count: people } = await admin.from("person").select("id", { count: "exact", head: true }).eq("workspace_id", ws);
    expect(people).toBe(0);
    const r = await approveAndApply(db, props![0].id);
    expect(r.applied.follow_up?.employment_proposal_id).toBeTruthy();
    const { data: emp } = await admin.from("change_proposal").select("target_type, operation, risk, state, evidence_ids").eq("id", r.applied.follow_up!.employment_proposal_id).single();
    expect(emp).toMatchObject({ target_type: "employment", operation: "create", risk: "material_fact", state: "proposed" });
    expect(emp!.evidence_ids).toEqual(props![0].evidence_ids);
  });

  it("identity merge proposals carry evidence ids (source file + staged rows)", async () => {
    const bytes = await xlsxBytes([{ name: "Lease Expiry", rows: [LEASE_LARGE_HEADER,
      largeLeaseRow({ row: 2, building: B("Helix One"), locality: "Kharadi", area: 7000, tenant: `Nimbus ${t} Private Limited`, start: "2023-01-31", tenure: 36 })] }]);
    const reg = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName: "more leases.xlsx", bytes });
    await processBatch(db, { workspaceId: ws, batchId: reg.batchId });
    const { data: cand } = await admin.from("identity_match_candidate").select("id").eq("workspace_id", ws).eq("entity_type", "organisation").eq("decision", "pending").limit(1).single();
    const res = await decideMatch(db, ws, USERS.owner.id, cand!.id, "link");
    const { data: cp } = await admin.from("change_proposal").select("operation, evidence_ids").eq("id", res.changeProposalId!).single();
    expect(cp!.operation).toBe("merge");
    expect(cp!.evidence_ids.length).toBeGreaterThanOrEqual(2);
    const { data: so } = await admin.from("source_object").select("id").in("id", cp!.evidence_ids);
    expect(so!.length).toBe(1);
  });

  it("stale-record detector flags records outside the window, creates one deduped review task each, and clears on verification", async () => {
    const later = new Date(Date.now() + 400 * 86_400_000);
    const r1 = await runStaleDetector(admin, ws, { now: later });
    expect(r1.stale).toBeGreaterThan(0);
    const { data: fr } = await admin.from("record_freshness").select("entity_type, entity_id, status, basis, task_id").eq("workspace_id", ws).eq("entity_type", "asset");
    expect(fr![0]).toMatchObject({ status: "stale", basis: "approved_change" });
    const tasksQ = async () => (await admin.from("task").select("id", { count: "exact", head: true }).eq("workspace_id", ws).like("idempotency_key", "steward:stale:%")).count;
    const n1 = await tasksQ();
    expect(n1).toBe(r1.tasks);
    await runStaleDetector(admin, ws, { now: later });
    expect(await tasksQ()).toBe(n1);                       // re-runs never duplicate tasks
    await markVerified(db, ws, USERS.owner.id, "asset", fr![0].entity_id, "Called the developer");
    const { data: task } = await admin.from("task").select("status").eq("id", fr![0].task_id).single();
    expect(task!.status).toBe("done");
    const r3 = await runStaleDetector(admin, ws, {});      // today: within every window
    expect(r3.stale).toBe(0);
    const { data: after } = await admin.from("record_freshness").select("status").eq("workspace_id", ws);
    expect(after!.every((x: any) => x.status === "fresh")).toBe(true);
  });

  it("re-processing a quarantined-then-approved batch and the lease v2 batch leaves reconciliation intact", async () => {
    const r = await processBatch(db, { workspaceId: ws, batchId: leaseV2Batch, allowFrom: ["completed", "completed_with_exceptions"] });
    expect(r.counts!.reconciles).toBe(true);
  });
});
