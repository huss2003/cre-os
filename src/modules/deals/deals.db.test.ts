/**
 * Integration tests against the local Supabase stack as real signed-in users (RLS enforced). Fixtures are tagged and
 * created in WS1/WS2 only; nothing created by others is touched. Covers security-review M3/M4 for deals tables, stage
 * history, fee evidence, shortlist runs, quote invalidation, document staleness/permissions and idempotency.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { USERS, WS1, WS2, tag, userClient } from "../../../tests/helpers";
import { asRole } from "../../../tests/security/pg";
import type { DealsCtx } from "./ctx";
import { DealsError, idempotent } from "./ctx";
import { createRequirement, updateRequirementFields, confirmRequirement, setNotApplicable } from "./requirements/service";
import { runShortlist } from "./matching/service";
import { createQuote, reviseQuote } from "./quotes/service";
import { approveAssumptions, approveScenario, evaluateScenario, inputFromQuote } from "./finance/service";
import { approveDocument, downloadDocument, generateDocument, refreshStatus, releaseDocument } from "./documents/service";
import { createOpportunity, moveStage, recordFeeMilestone, seedClosingChecklist, updateMilestone } from "./pipeline/service";
import { proposeCrmExport, recordExternalSnapshot, markExported } from "./crm/export";
import { REQUIREMENT_FIELDS } from "./requirements/contract";

let owner: DealsCtx;
let colleague: DealsCtx;
let other: DealsCtx;
beforeAll(async () => {
  owner = { db: await userClient("owner"), workspaceId: WS1, userId: USERS.owner.id, role: "owner" };
  colleague = { db: await userClient("colleague"), workspaceId: WS1, userId: USERS.colleague.id, role: "editor" };
  other = { db: await userClient("other"), workspaceId: WS2, userId: USERS.other.id, role: "owner" };
});

const expectErr = async (p: Promise<unknown>, status: number, re?: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(DealsError);
  expect((e as DealsError).status).toBe(status);
  if (re) expect(JSON.stringify([(e as DealsError).message, (e as DealsError).details])).toMatch(re);
};

async function fullyConfirmed(ctx: DealsCtx, t: string) {
  const req = await createRequirement(ctx, { title: `Req ${t}`, orgName: `Org ${t}` }) as { id: string; row_version: number };
  const values: Record<string, unknown> = {
    objective: "relocation", decision_date: "2026-12-15", occupation_date: "2027-03-01", area: [18000, 20000, 22000], area_basis: "chargeable",
    budget: [70, 95], budget_basis: "per_sf_month", budget_inclusions: "rent + CAM, excl. GST", preferred_locations: [], fitout_standard: "warm_shell",
    tenure_months: 60, legal_entity: "Acme India Pvt Ltd", commercial_authority: "CFO", procurement_process: "board approval", current_lease_notice: "2026-12-31 notice",
    mandate_status: "exclusive", conflict_status: "clear",
  };
  const r = await updateRequirementFields(ctx, req.id, req.row_version, Object.entries(values).map(([key, value]) => ({ key, value, status: "client_confirmed" as const })), "test setup");
  // preferred locations empty → mark not applicable so the contract is complete
  const after = r.requirement as { id: string; row_version: number };
  const na = await setNotApplicable(ctx, req.id, after.row_version, ["preferred_locations"]) as { row_version: number };
  return { id: req.id, row_version: na.row_version };
}

describe("requirements: confirmed fields only change via approved proposals (M3)", () => {
  it("estimates edit directly; confirmed fields become proposals; direct API writes are refused; apply_change passes", async () => {
    const t = tag("dreq");
    const req = await createRequirement(owner, { title: `Req ${t}`, orgName: `Org ${t}`, changes: [{ key: "area", value: [15000, 20000, 25000] }] }) as { id: string; row_version: number; status: string };
    expect(req.status).toBe("estimated");
    let r = await updateRequirementFields(owner, req.id, req.row_version, [{ key: "area", value: [16000, 20000, 24000], status: "client_confirmed" }], "call with CFO");
    expect(r.applied).toEqual(["area"]);
    const v1 = r.requirement as { row_version: number; area_min_sf: string };
    expect(Number(v1.area_min_sf)).toBe(16000);

    // stale version refused
    await expectErr(updateRequirementFields(owner, req.id, req.row_version, [{ key: "budget", value: [1, 2] }], "x"), 409);

    // direct PostgREST write of a confirmed field — refused by the DB even for the owner
    const direct = await owner.db.from("requirement").update({ area_min_sf: 1000 }).eq("id", req.id).select("id");
    expect(direct.error?.code).toBe("42501");
    const downgrade = await owner.db.from("requirement").update({ constraints: { field_status: { area: "estimated" } } }).eq("id", req.id).select("id");
    expect(downgrade.error?.code).toBe("42501");

    // through the service: a proposal, nothing applied
    r = await updateRequirementFields(owner, req.id, v1.row_version, [{ key: "area", value: [17000, 20000, 24000] }], "client revised", "k1");
    expect(r.applied).toEqual([]);
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0].risk).toBe("material_fact");
    const still = await owner.db.from("requirement").select("area_min_sf").eq("id", req.id).single();
    expect(Number(still.data!.area_min_sf)).toBe(16000);

    // approve + apply (rolled back) passes the guard because it carries mudar_app.change_proposal_id
    const applied = await asRole("owner", async (db) => {
      const a = await db.q(`select mudar_app.approve_change($1)`, [r.proposals[0].id]);
      if (a.error) return `approve: ${a.error.message}`;
      const p = await db.q(`select mudar_app.apply_change($1)`, [r.proposals[0].id]);
      if (p.error) return `apply: ${p.error.message}`;
      const row = await db.q<{ area_min_sf: string }>(`select area_min_sf from mudar.requirement where id=$1`, [req.id]);
      return Number(row.rows[0].area_min_sf);
    });
    expect(applied).toBe(17000);
  });

  it("confirmation requires every mandatory field confirmed and evidence; afterwards the whole contract is locked", async () => {
    const t = tag("dconf");
    const req = await createRequirement(owner, { title: `Req ${t}`, orgName: `Org ${t}` }) as { id: string; row_version: number };
    await expectErr(confirmRequirement(owner, req.id, req.row_version, { evidence: "email" }), 422, /unknown/);
    const full = await fullyConfirmed(owner, tag("dconf2"));
    const c = await confirmRequirement(owner, full.id, full.row_version, { evidence: "signed brief 30 Oct" }) as { status: string; row_version: number };
    expect(c.status).toBe("client_confirmed");
    const lock = await owner.db.from("requirement").update({ budget_max: 200 }).eq("id", full.id).select("id");
    expect(lock.error?.code).toBe("42501");
    const r = await updateRequirementFields(owner, full.id, c.row_version, [{ key: "growth_assumption", value: "10%/yr" }], "x");
    expect(r.proposals).toHaveLength(1);
    expect(REQUIREMENT_FIELDS.length).toBeGreaterThan(30);
  });
});

describe("cross-workspace references are rejected (M4)", () => {
  it("a WS2 owner cannot attach a WS2 requirement to a WS1 organisation", async () => {
    const t = tag("dm4");
    const org = await owner.db.from("organisation").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, display_name: `Org ${t}` }).select("id").single();
    const r = await other.db.from("requirement").insert({ workspace_id: WS2, owner_user_id: USERS.other.id, org_id: org.data!.id, title: `x ${t}` }).select("id");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/same workspace|foreign key|violates/);
  });
});

describe("pipeline: stage gates, DB-written history, fee evidence, CRM export", () => {
  it("moves with evidence, blocks unconfirmed requirement, records history; fees need evidence", async () => {
    const full = await fullyConfirmed(owner, tag("dopp"));
    const opp = await createOpportunity(owner, { name: `Opp ${tag("o")}`, requirementId: full.id, stage: "engaged" }) as { id: string; row_version: number };
    await expectErr(moveStage(owner, opp.id, opp.row_version, "requirement_confirmed", "brief"), 422, /client-confirmed/);
    const moved = await moveStage(owner, opp.id, opp.row_version, "qualified_discussion", "two-way call 30 Oct, timing + need confirmed") as { stage: string; row_version: number };
    expect(moved.stage).toBe("qualified_discussion");
    const hist = await owner.db.from("opportunity_stage_history").select("from_stage, to_stage, evidence").eq("opportunity_id", opp.id).order("changed_at");
    expect(hist.data!.map((h) => h.to_stage)).toEqual(["engaged", "qualified_discussion"]);
    expect(hist.data![1].evidence).toMatch(/two-way call/);
    // stale version
    await expectErr(moveStage(owner, opp.id, opp.row_version, "options_visits"), 409);
    // won before signing refused by DB too
    const won = await owner.db.from("opportunity").update({ outcome: "won" }).eq("id", opp.id).select("id");
    expect(won.error).not.toBeNull();
    // fees
    await expectErr(recordFeeMilestone(owner, opp.id, { gross_fee: 3000000, invoiced_amount: 1000000, invoiced_on: "2026-11-01" }), 400, /evidence/);
    const fee = await recordFeeMilestone(owner, opp.id, { gross_fee: 3000000, credit_share: 0.5, milestone: "on signing" }) as { id: string };
    expect(fee.id).toBeTruthy();
    // closing checklist is idempotent; proof required items cannot be done without proof
    const a = await seedClosingChecklist(owner, opp.id);
    const b = await seedClosingChecklist(owner, opp.id);
    expect(b.length).toBe(a.length);
    const loi = (a as { id: string; template_key: string }[]).find((m) => m.template_key === "loi_signed")!;
    await expectErr(updateMilestone(owner, loi.id, { status: "done" }), 422, /proof/);
    // CRM export: needs official id; competing CRM update shown, not overwritten
    const ex = await proposeCrmExport(owner, opp.id) as { id: string; status: string };
    expect(ex.status).toBe("needs_external_id");
    await expectErr(markExported(owner, ex.id), 422, /official CRM id/);
    const rec = await recordExternalSnapshot(owner, ex.id, { stage: "loi", name: "renamed in CRM" }, "CRM-123") as { status: string; conflict_fields: unknown[] };
    expect(rec.status).toBe("conflict");
    await expectErr(markExported(owner, ex.id), 422, /conflict/);
    const done = await markExported(owner, ex.id, { resolution: "keep_external" }) as { status: string };
    expect(done.status).toBe("reconciled");
  });
});

describe("shortlist → quote → finance → documents (staleness + permissions)", () => {
  it("runs end to end and invalidates on quote revision", async () => {
    const t = tag("dflow");
    const full = await fullyConfirmed(owner, t);
    await confirmRequirement(owner, full.id, full.row_version, { evidence: "signed brief" });
    const asset = await owner.db.from("asset").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, name: `Tower ${t}`, total_area_sf: 900000, specs: {} }).select("id").single();
    const s1 = await owner.db.from("space").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, asset_id: asset.data!.id, floor_text: "5", chargeable_sf: 20000, carpet_sf: 14000, seats: 180, configuration: "warm_shell" }).select("id").single();
    const s2 = await owner.db.from("space").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, asset_id: asset.data!.id, floor_text: "6", chargeable_sf: 21000 }).select("id").single();
    const today = new Date().toISOString().slice(0, 10);
    await owner.db.from("availability").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, space_id: s1.data!.id, as_of: today, status: "available", available_from: "2027-01-01", asking_rent_min: 85, asking_rent_max: 85, rent_basis: "chargeable", fitout_basis: "warm_shell", valid_until: "2099-12-31", fact_status: "currently_confirmed" });

    const run = await runShortlist(owner, full.id);
    expect(run.version).toBeGreaterThanOrEqual(1);
    const o1 = run.results.find((x) => x.spaceId === s1.data!.id)!;
    const o2 = run.results.find((x) => x.spaceId === s2.data!.id)!;
    expect(o1.area.value).toBe(20000);              // space snapshot, not the 900,000 SF building
    expect(o2.flags.vacancyUnverified).toBe(true);  // no snapshot → unverified, never "available"
    expect(o2.eligibility).not.toBe("eligible");
    const stored = await owner.db.from("shortlist_option").select("id").eq("requirement_id", full.id).eq("version", run.version);
    expect(stored.data!.length).toBe(run.results.length);

    const q = await createQuote(owner, { requirementId: full.id, spaceId: s1.data!.id, validUntil: "2099-12-31", evidence: "landlord email",
      terms: { rent: 85, rent_basis: "chargeable", cam_per_sf: 12, escalation_pct: 15, escalation_every_months: 36, rent_free_months: 3, deposit_months: 6, tenure_months: 60, gst: "included", inclusions: "DG backup" } }) as { id: string; version: number; valid_until: string; terms_json: Record<string, unknown> };
    const direct = await owner.db.from("quote").update({ terms_json: { rent: 1 } }).eq("id", q.id).select("id");
    expect(direct.error?.code).toBe("42501"); // quote versions are immutable

    const input = inputFromQuote({ name: `A ${t}`, baseDate: "2027-01-01", horizonMonths: 60, annualDiscountRatePct: 12, quote: q as never, space: { chargeable_sf: 20000, carpet_sf: 14000, seats: 180 }, fitoutCost: 20000000 });
    const sc = await evaluateScenario(owner, { input, requirementId: full.id, save: true });
    expect(sc.scenarioId).toBeTruthy();
    const cf = await owner.db.from("finance_cashflow").select("id", { count: "exact", head: true }).eq("scenario_id", sc.scenarioId!);
    expect(cf.count).toBe(sc.result.cashflows.length);
    // round 2: every assumption approved + unknown costs (parking/opex/reinstatement) acknowledged explicitly
    await approveAssumptions(owner, sc.scenarioId!, sc.result.assumptions.map((x) => x.key));
    await approveScenario(owner, sc.scenarioId!, { acknowledgeGaps: true, note: "test" });

    const deck = await generateDocument(owner, { purpose: "shortlist_deck", requirementId: full.id, scenarioIds: [sc.scenarioId!], preparedFor: "CFO" });
    const xl = await generateDocument(owner, { purpose: "comparison_xlsx", requirementId: full.id, scenarioIds: [sc.scenarioId!] });
    const deckId = (deck.document as { id: string }).id, xlId = (xl.document as { id: string }).id;
    const file = await downloadDocument(owner, xlId);
    expect(file.buffer.length).toBeGreaterThan(1000);
    expect(file.mime).toMatch(/spreadsheetml/);
    // colleague (no see-all, not the owner) cannot read the row → cannot download the output document
    await expectErr(downloadDocument(colleague, xlId), 404);

    const appr = await approveDocument(owner, deckId) as { status: string; approved_hash: string; sha256: string };
    expect(appr.status).toBe("approved");
    expect(appr.approved_hash).toBe(appr.sha256);

    // revise the quote → scenario approval dropped, documents built on v1 become stale (DB trigger)
    const q2 = await reviseQuote(owner, q.id, { terms: { rent: 80 } }) as { version: number };
    expect(q2.version).toBe(2);
    const scRow = await owner.db.from("finance_scenario").select("approved_at").eq("id", sc.scenarioId!).single();
    expect(scRow.data!.approved_at).toBeNull();
    const docs = await owner.db.from("document_version").select("id, status").in("id", [deckId, xlId]);
    expect(docs.data!.every((d) => d.status === "stale")).toBe(true);
    await expectErr(approveDocument(owner, xlId), 422, /stale/);
    await expectErr(releaseDocument(owner, deckId, { recipient: "CFO" }), 422);
    const force = await owner.db.from("document_version").update({ status: "approved" }).eq("id", xlId).select("id");
    expect(force.error?.code).toBe("42501");
    const st = await refreshStatus(owner, deckId);
    expect(st.reasons.join()).toMatch(/superseded/);
  });
});

describe("idempotency", () => {
  it("same key returns the first response without re-running", async () => {
    const key = tag("idem");
    let runs = 0;
    const a = await idempotent(owner, "test.scope", key, async () => ({ n: ++runs }));
    const b = await idempotent(owner, "test.scope", key, async () => ({ n: ++runs }));
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
    expect(runs).toBe(1);
  });
});
