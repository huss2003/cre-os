/**
 * Deals-B round 2 integration tests (local Supabase, real signed-in users, RLS on). Fixtures are tagged, live in WS1,
 * and job-created rows (tasks / outbox) are removed afterwards.
 *  12 Design Studio — version lineage, immediate staleness on requirement / availability change, released flagged stale.
 *  17 Closing Coordinator — checklist auto-created at LOI with dependencies, blocked state, owner + due date, deduped alerts.
 *  21 Revenue Controller — close-date history, fee status rules, finance CSV reconciliation (proposals, never overwrite).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { USERS, WS1, adminClient, tag, userClient } from "../../../tests/helpers";
import { asRole, catalog } from "../../../tests/security/pg";
import type { DealsCtx } from "./ctx";
import { DealsError } from "./ctx";
import { createRequirement, updateRequirementFields, confirmRequirement, setNotApplicable } from "./requirements/service";
import { runShortlist } from "./matching/service";
import { approveDocument, generateDocument, listDocuments, regenerateDocument, releaseDocument } from "./documents/service";
import { createOpportunity, moveStage, recordFeeMilestone, updateFeeMilestone, updateLabels } from "./pipeline/service";
import { getClosingView, runClosingAlerts, updateMilestoneDetails } from "./pipeline/closing-service";
import { CLOSING_TEMPLATE } from "./pipeline/stages";
import { importFinanceCsv } from "./fees/recon-service";

let owner: DealsCtx;
const cleanupKeys: string[] = [];
beforeAll(async () => {
  owner = { db: await userClient("owner"), workspaceId: WS1, userId: USERS.owner.id, role: "owner" };
});
afterAll(async () => {
  const admin = adminClient();
  if (cleanupKeys.length) {
    await admin.from("task").delete().eq("workspace_id", WS1).in("idempotency_key", cleanupKeys);
    await admin.from("outbox").delete().eq("workspace_id", WS1).in("dedupe_key", cleanupKeys);
  }
});

const expectErr = async (p: Promise<unknown>, status: number, re?: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(DealsError);
  expect((e as DealsError).status).toBe(status);
  if (re) expect(JSON.stringify([(e as DealsError).message, (e as DealsError).details])).toMatch(re);
};

async function confirmedRequirement(t: string) {
  const req = await createRequirement(owner, { title: `Req ${t}`, orgName: `Org ${t}` }) as { id: string; row_version: number };
  const values: Record<string, unknown> = {
    objective: "relocation", decision_date: "2026-12-15", occupation_date: "2027-03-01", area: [18000, 20000, 22000], area_basis: "chargeable",
    budget: [70, 95], budget_basis: "per_sf_month", budget_inclusions: "rent + CAM", preferred_locations: [], fitout_standard: "warm_shell",
    tenure_months: 60, legal_entity: "Acme India Pvt Ltd", commercial_authority: "CFO", procurement_process: "board", current_lease_notice: "2026-12-31",
    mandate_status: "exclusive", conflict_status: "clear",
  };
  const r = await updateRequirementFields(owner, req.id, req.row_version, Object.entries(values).map(([key, value]) => ({ key, value, status: "client_confirmed" as const })), "setup");
  const na = await setNotApplicable(owner, req.id, (r.requirement as { row_version: number }).row_version, ["preferred_locations"]) as { row_version: number };
  await confirmRequirement(owner, req.id, na.row_version, { evidence: "signed brief" });
  return req.id;
}

describe("12 Design Studio: versioned, traceable, stale facts trigger re-review", () => {
  it("new generation = new version in the same family; prior approved/released versions are kept and listed", async () => {
    const t = tag("dsv");
    const req = await createRequirement(owner, { title: `Req ${t}`, orgName: `Org ${t}`, changes: [{ key: "area", value: [9000, 10000, 11000] }] }) as { id: string; row_version: number };
    const v1 = (await generateDocument(owner, { purpose: "proposal", requirementId: req.id, preparedFor: "CFO" })).document as { id: string; family_id: string; version_no: number; parent_id: string | null; input_versions: { sources: string[] } };
    expect(v1).toMatchObject({ version_no: 1, parent_id: null });
    expect(v1.family_id).toBe(v1.id);
    expect(v1.input_versions.sources.join()).toMatch(/Requirement .* row version/);
    await approveDocument(owner, v1.id);
    const rel = await releaseDocument(owner, v1.id, { recipient: "CFO" }) as { document: { status: string; released_at: string } };
    expect(rel.document.status).toBe("released");
    expect(rel.document.released_at).toBeTruthy();

    // requirement edit → stale immediately (SQL trigger), released flagged stale too, release time kept
    await updateRequirementFields(owner, req.id, req.row_version, [{ key: "area", value: [9500, 10000, 11000] }], "client revised");
    const after = (await owner.db.from("document_version").select("status, released_at, stale_reasons").eq("id", v1.id).single()).data as { status: string; released_at: string; stale_reasons: { reason: string; was: string }[] };
    expect(after.status).toBe("stale");
    expect(after.released_at).toBeTruthy();
    expect(after.stale_reasons[0]).toMatchObject({ was: "released" });
    expect(after.stale_reasons[0].reason).toMatch(/requirement edited/);
    await expectErr(releaseDocument(owner, v1.id, { recipient: "CFO" }), 422);

    const v2 = (await regenerateDocument(owner, v1.id)).document as { id: string; family_id: string; version_no: number; parent_id: string; status: string; input_versions: { prepared_for: string } };
    expect(v2).toMatchObject({ family_id: v1.family_id, version_no: 2, parent_id: v1.id, status: "draft" });
    expect(v2.input_versions.prepared_for).toBe("CFO");
    const listed = (await listDocuments(owner, { requirementId: req.id })) as { id: string; version_no: number; approved_hash: string | null }[];
    expect(listed.map((d) => d.version_no).sort()).toEqual([1, 2]);
    expect(listed.find((d) => d.id === v1.id)!.approved_hash).toBeTruthy(); // prior approval kept
    // lineage is immutable
    const tamper = await owner.db.from("document_version").update({ version_no: 9 }).eq("id", v2.id).select("id");
    expect(tamper.error?.code).toBe("42501");
  });

  it("changed availability marks dependent documents stale immediately", async () => {
    const t = tag("dsa");
    const reqId = await confirmedRequirement(t);
    const asset = await owner.db.from("asset").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, name: `Tower ${t}`, lat: 18.56, lon: 73.78, specs: {} }).select("id").single();
    const space = await owner.db.from("space").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, asset_id: asset.data!.id, floor_text: "3", chargeable_sf: 20000 }).select("id").single();
    const today = new Date().toISOString().slice(0, 10);
    await owner.db.from("availability").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, space_id: space.data!.id, as_of: today, status: "available", valid_until: "2099-12-31", fact_status: "currently_confirmed", asking_rent_min: 85, asking_rent_max: 90, rent_basis: "chargeable" });
    await runShortlist(owner, reqId);
    const deck = (await generateDocument(owner, { purpose: "shortlist_deck", requirementId: reqId })).document as { id: string; input_versions: { availability?: Record<string, string>; sources: string[] } };
    expect(Object.keys(deck.input_versions.availability ?? {}).length).toBeGreaterThanOrEqual(1);
    expect(deck.input_versions.sources.join()).toMatch(/Availability .* as of/);
    const note = (await generateDocument(owner, { purpose: "market_note", requirementId: reqId })).document as { id: string };
    await owner.db.from("availability").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, space_id: space.data!.id, as_of: today, status: "under_offer", valid_until: "2099-12-31", fact_status: "reported" });
    const rows = (await owner.db.from("document_version").select("id, status, stale_reasons").in("id", [deck.id, note.id])).data as { status: string; stale_reasons: { reason: string }[] }[];
    expect(rows.every((r) => r.status === "stale")).toBe(true);
    expect(rows[0].stale_reasons[0].reason).toMatch(/new availability snapshot/);
  });
});

describe("17 Closing Coordinator", () => {
  it("SQL checklist template equals CLOSING_TEMPLATE", async () => {
    const [{ t }] = await catalog<{ t: unknown[] }>("select mudar_app.deals_closing_template() as t");
    expect(t).toEqual(CLOSING_TEMPLATE.map((x) => ({ ...x })));
  });

  it("LOI auto-creates the checklist (idempotent); blocked dependencies visible; owner + due date; done needs the dependency", async () => {
    const t = tag("dcl");
    const reqId = await confirmedRequirement(t);
    let opp = await createOpportunity(owner, { name: `Opp ${t}`, requirementId: reqId, stage: "engaged" }) as { id: string; row_version: number };
    opp = await moveStage(owner, opp.id, opp.row_version, "loi", "LOI signed 30 Oct, copy in DMS #77") as { id: string; row_version: number };
    const ms = (await owner.db.from("deal_milestone").select("id, template_key, depends_on, status").eq("opportunity_id", opp.id)).data as { id: string; template_key: string; depends_on: string | null }[];
    expect(ms).toHaveLength(CLOSING_TEMPLATE.length);
    const k = (key: string) => ms.find((m) => m.template_key === key)!;
    expect(k("title_due_diligence").depends_on).toBe(k("loi_signed").id);
    // re-running the seed adds nothing
    await owner.db.rpc("deals_seed_closing_checklist", { p_id: opp.id });
    expect((await owner.db.from("deal_milestone").select("id", { count: "exact", head: true }).eq("opportunity_id", opp.id)).count).toBe(CLOSING_TEMPLATE.length);

    // owner + due date + dependency editable; done refused while the prerequisite is open (service and DB)
    const upd = await updateMilestoneDetails(owner, k("title_due_diligence").id, { assigneeUserId: USERS.colleague.id, dueDate: "2026-11-20", ownerNote: "client legal" }) as { assignee_user_id: string; due_date: string };
    expect(upd).toMatchObject({ assignee_user_id: USERS.colleague.id, due_date: "2026-11-20" });
    await expectErr(updateMilestoneDetails(owner, k("title_due_diligence").id, { status: "done", proofText: "OC copy" }), 422, /waiting on .{0,3}LOI/);
    const direct = await owner.db.from("deal_milestone").update({ status: "done", proof_text: "x" }).eq("id", k("title_due_diligence").id).select("id");
    expect(direct.error?.message).toMatch(/blocked: waiting on/);
    await expectErr(updateMilestoneDetails(owner, k("loi_signed").id, { dependsOn: k("handover").id }), 422, /cycle/);
    await expectErr(updateMilestoneDetails(owner, k("loi_signed").id, { assigneeUserId: USERS.other.id }), 400, /member/);

    const view = await getClosingView(owner, opp.id, "2026-10-31");
    const tdd = view.timeline.find((x) => x.id === k("title_due_diligence").id)!;
    expect(tdd.blocked).toBe(true);
    expect(tdd.waitingOn[0].title).toMatch(/LOI/);
    expect(view.outstanding.some((o) => o.id === k("loi_signed").id)).toBe(true);

    // skipping past documentation is blocked by the real checklist item
    await expectErr(moveStage(owner, opp.id, opp.row_version, "signed", "signed"), 422, /LOI \/ term sheet signed/);
  });

  it("overdue / blocked alerts: notify + task, deduped across runs", async () => {
    const t = tag("dal");
    const reqId = await confirmedRequirement(t);
    let opp = await createOpportunity(owner, { name: `Opp ${t}`, requirementId: reqId, stage: "engaged" }) as { id: string; row_version: number };
    opp = await moveStage(owner, opp.id, opp.row_version, "loi", "LOI ref 12") as { id: string; row_version: number };
    const ms = (await owner.db.from("deal_milestone").select("id, template_key").eq("opportunity_id", opp.id)).data as { id: string; template_key: string }[];
    const loi = ms.find((m) => m.template_key === "loi_signed")!, tdd = ms.find((m) => m.template_key === "title_due_diligence")!;
    await updateMilestoneDetails(owner, loi.id, { dueDate: "2026-10-01", assigneeUserId: USERS.owner.id });
    await updateMilestoneDetails(owner, tdd.id, { dueDate: "2026-11-05" });
    const admin = adminClient();
    const r1 = await runClosingAlerts(admin, WS1, "2026-10-31");
    const keys = [`deals.closing:${loi.id}:overdue:2026-10-01`, `deals.closing:${tdd.id}:blocked:${loi.id}`];
    cleanupKeys.push(...keys);
    const tasks = (await admin.from("task").select("idempotency_key, assigned_user_id, linked_entity_id").eq("workspace_id", WS1).in("idempotency_key", keys)).data!;
    expect(tasks.map((x) => x.idempotency_key).sort()).toEqual([...keys].sort());
    expect(tasks.every((x) => x.linked_entity_id === opp.id)).toBe(true);
    const out = (await admin.from("outbox").select("dedupe_key, kind, payload").eq("workspace_id", WS1).in("dedupe_key", keys)).data!;
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe("deals.closing_alert");
    const r2 = await runClosingAlerts(admin, WS1, "2026-10-31");
    expect(r2.tasksCreated).toBe(0);
    expect(r1.tasksCreated).toBeGreaterThanOrEqual(2);
    expect((await admin.from("task").select("id", { count: "exact", head: true }).eq("workspace_id", WS1).in("idempotency_key", keys)).count).toBe(2);
  });
});

describe("21 Revenue Controller", () => {
  it("expected_close changes are recorded for slippage; fee status rules; reconciliation proposes, never overwrites", async () => {
    const t = tag("drc");
    const opp = await createOpportunity(owner, { name: `Opp ${t}`, orgId: null, requirementId: (await createRequirement(owner, { title: `Req ${t}`, orgName: `Org ${t}` }) as { id: string }).id, stage: "engaged", expectedClose: "2026-11-30", crmExternalId: `CRM-${t}` }) as { id: string; row_version: number };
    await updateLabels(owner, opp.id, opp.row_version, { expectedClose: "2027-01-15" });
    const hist = (await owner.db.from("opportunity_close_history").select("old_expected_close, new_expected_close").eq("opportunity_id", opp.id).order("changed_at")).data!;
    expect(hist).toEqual([{ old_expected_close: null, new_expected_close: "2026-11-30" }, { old_expected_close: "2026-11-30", new_expected_close: "2027-01-15" }]);
    const forged = await owner.db.from("opportunity_close_history").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, opportunity_id: opp.id, new_expected_close: "2026-01-01" });
    expect(forged.error).not.toBeNull(); // append-only, written by trigger

    await expectErr(recordFeeMilestone(owner, opp.id, { gross_fee: 100, contractual_amount: 100 }), 400, /agreement reference/);
    await expectErr(recordFeeMilestone(owner, opp.id, { invoice_no: "X-1" }), 400, /invoiced amount/);
    const f1 = await recordFeeMilestone(owner, opp.id, { gross_fee: 300000, milestone: "on signing", contractual_amount: 300000, contract_ref: "EL-1", invoiced_amount: 200000, invoiced_on: "2026-10-01", invoice_no: `INV-${t}`, evidence: "invoice pdf" }) as { id: string };
    await recordFeeMilestone(owner, opp.id, { gross_fee: 100000, milestone: "on possession" });
    await expectErr(updateFeeMilestone(owner, f1.id, { invoice_no: "CHANGED" }), 403);

    const csv = `invoice_no,deal_ref,invoice_date,invoice_amount,due_date,collected_amount,collected_date\nINV-${t},,2026-10-01,210000,2026-10-31,50000,2026-10-20\nINV-${t}-B,CRM-${t},2026-10-05,100000,2026-11-04,,\nNOPE-${t},,2026-10-02,5,,,\n`;
    const r = await importFinanceCsv(owner, { fileName: `finance-${t}.csv`, text: csv, sourceSystem: "Tally" });
    expect(r.replayed).toBe(false);
    const imp = r.import as { id: string; summary: Record<string, number>; totals: { reconciles: boolean } };
    expect(imp.summary).toMatchObject({ mismatch: 1, missing_in_cre_os: 1, unmatched: 1, proposals: 2 });
    expect(imp.totals.reconciles).toBe(false);
    const rows = (await owner.db.from("fee_recon_row").select("row_no, status, proposal_ids, exceptions").eq("import_id", imp.id).order("row_no")).data!;
    expect(rows[0].exceptions.join()).toMatch(/Invoiced amount differs/);
    const prop = (await owner.db.from("change_proposal").select("target_type, target_id, state, risk").in("id", rows[0].proposal_ids)).data!;
    expect(prop[0]).toMatchObject({ target_type: "fee_milestone", target_id: f1.id, risk: "high_value" });
    // recorded amount untouched (official value only proposed)
    expect(Number(((await owner.db.from("fee_milestone").select("invoiced_amount").eq("id", f1.id).single()).data as { invoiced_amount: string }).invoiced_amount)).toBe(200000);
    // an approved proposal applies cleanly through the guards (rolled back)
    const applied = await asRole("owner", async (db) => {
      const a = await db.q(`select mudar_app.approve_change($1)`, [rows[1].proposal_ids[0]]);
      if (a.error) return `approve: ${a.error.message}`;
      const p = await db.q(`select mudar_app.apply_change($1)`, [rows[1].proposal_ids[0]]);
      if (p.error) return `apply: ${p.error.message}`;
      const f = await db.q<{ invoiced_amount: string; invoice_no: string; invoice_due_on: string }>(`select invoiced_amount, invoice_no, invoice_due_on::text from mudar.fee_milestone where id = (select target_id from mudar.change_proposal where id = $1)`, [rows[1].proposal_ids[0]]);
      return f.rows[0];
    });
    expect(applied).toMatchObject({ invoiced_amount: "100000.00", invoice_no: `INV-${t}-B`, invoice_due_on: "2026-11-04" });
    // same file again → replayed, no new proposals
    const again = await importFinanceCsv(owner, { fileName: "renamed.csv", text: csv });
    expect(again.replayed).toBe(true);
    expect((again.import as { id: string }).id).toBe(imp.id);
  });
});
