/**
 * Workflows 08/09 round-2 integration tests against the local stack as signed-in users (RLS enforced).
 * Fixtures are tagged and live in WS1; the tasks and queued jobs this file caused are deleted afterwards (requirement /
 * inventory rows stay, like the other deals fixtures, because audit + guard triggers make their removal invasive).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { USERS, WS1, adminClient, tag, userClient } from "../../../../tests/helpers";
import type { DealsCtx } from "../ctx";
import { DealsError } from "../ctx";
import { confirmRequirement, createRequirement, setNotApplicable, updateRequirementFields } from "./service";
import { QUESTION_TASK_SOURCE } from "./tasks";
import { runShortlist } from "../matching/service";
import { updateMatchingConfig } from "../matching/config";
import { VERIFY_TASK_SOURCE } from "../matching/verify-tasks";
import { rematchRequirement } from "../matching/rematch";

let owner: DealsCtx;
const created: { requirements: string[]; assets: string[] } = { requirements: [], assets: [] };
beforeAll(async () => {
  owner = { db: await userClient("owner"), workspaceId: WS1, userId: USERS.owner.id, role: "owner" };
  // Earlier runs of this file (before afterAll archived its inventory) left "Tower match-*" spaces at the same
  // 12,345 SF; they tie with this run's space and push it out of the top-10 verification set. Retire them.
  const a = adminClient();
  const old = (await a.from("asset").select("id").eq("workspace_id", WS1).like("name", "Tower match-%").is("archived_at", null)).data ?? [];
  if (old.length) {
    const now = new Date().toISOString();
    const ids = old.map((r) => r.id as string);
    await a.from("space").update({ archived_at: now }).eq("workspace_id", WS1).in("asset_id", ids);
    await a.from("asset").update({ archived_at: now }).eq("workspace_id", WS1).in("id", ids);
  }
});
afterAll(async () => {
  const a = adminClient();
  for (const id of created.requirements) {
    await a.from("job").delete().eq("workspace_id", WS1).in("job_type", ["deals.rematch", "deals.req_tasks"]).eq("payload->>requirement_id", id);
    await a.from("task").delete().eq("workspace_id", WS1).eq("linked_entity_type", "requirement").eq("linked_entity_id", id);
  }
  // retire this file's inventory so later runs' shortlists in the shared WS1 are not crowded by it
  if (created.assets.length) {
    const now = new Date().toISOString();
    await a.from("space").update({ archived_at: now }).eq("workspace_id", WS1).in("asset_id", created.assets);
    await a.from("asset").update({ archived_at: now }).eq("workspace_id", WS1).in("id", created.assets);
  }
});

const expectErr = async (p: Promise<unknown>, status: number, re?: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(DealsError);
  expect((e as DealsError).status).toBe(status);
  if (re) expect(JSON.stringify([(e as DealsError).message, (e as DealsError).details])).toMatch(re);
};

async function questionTasks(reqId: string) {
  const r = await owner.db.from("task").select("idempotency_key, status, title, completion_evidence").eq("linked_entity_type", "requirement").eq("linked_entity_id", reqId).eq("source", QUESTION_TASK_SOURCE);
  return (r.data ?? []) as { idempotency_key: string; status: string; title: string; completion_evidence: string | null }[];
}

describe("08 · multiple requirements can exist for one company", () => {
  it("two requirements on the same organisation are independent", async () => {
    const t = tag("multi");
    const a = await createRequirement(owner, { title: `Pune HQ ${t}`, orgName: `Org ${t}` }) as { id: string; org_id: string };
    const b = await createRequirement(owner, { title: `Pune satellite ${t}`, orgId: a.org_id, changes: [{ key: "seats", value: ["", "80", ""], status: "reported" }] }) as { id: string; org_id: string; constraints: { field_status: Record<string, string> } };
    created.requirements.push(a.id, b.id);
    expect(b.org_id).toBe(a.org_id);
    expect(b.constraints.field_status.seats).toBe("reported");
    const both = await owner.db.from("requirement").select("id").eq("org_id", a.org_id);
    expect(both.data!.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("08 · missing questions → deduped follow-up tasks refreshed as answers arrive", () => {
  it("creates once, re-titles estimates, closes on confirmation / not-applicable, reopens on clearing", async () => {
    const t = tag("qtask");
    const req = await createRequirement(owner, { title: `Req ${t}`, orgName: `Org ${t}` }) as { id: string; row_version: number };
    created.requirements.push(req.id);
    const first = await questionTasks(req.id);
    expect(first.length).toBe(17); // one per mandatory contract field
    expect(new Set(first.map((x) => x.idempotency_key)).size).toBe(first.length);
    // an estimate: still open, now "confirm with client"; re-running never duplicates
    let r = await updateRequirementFields(owner, req.id, req.row_version, [{ key: "tenure_months", value: 60 }], "call");
    let ts = await questionTasks(req.id);
    expect(ts.length).toBe(17);
    expect(ts.find((x) => x.idempotency_key.endsWith(":tenure_months"))!.title).toMatch(/^Confirm with client: Tenure/);
    // client-confirmed → closed with evidence
    r = await updateRequirementFields(owner, req.id, Number((r.requirement as { row_version: number }).row_version), [{ key: "tenure_months", status: "client_confirmed" }], "signed brief");
    ts = await questionTasks(req.id);
    const tenure = ts.find((x) => x.idempotency_key.endsWith(":tenure_months"))!;
    expect(tenure.status).toBe("done");
    expect(tenure.completion_evidence).toBe("Answered: tenure_months is now client-confirmed");
    // not applicable → closed
    const na = await setNotApplicable(owner, req.id, Number((r.requirement as { row_version: number }).row_version), ["procurement_process"]) as { row_version: number };
    expect((await questionTasks(req.id)).find((x) => x.idempotency_key.endsWith(":procurement_process"))!.status).toBe("done");
    // back to applicable → reopened (same row, not a duplicate)
    await setNotApplicable(owner, req.id, na.row_version, ["procurement_process"], true);
    ts = await questionTasks(req.id);
    expect(ts.length).toBe(17);
    expect(ts.find((x) => x.idempotency_key.endsWith(":procurement_process"))!.status).toBe("open");
  });
});

describe("09 · matching configuration, verification tasks and re-match on availability change", () => {
  it("config is settable; confirmed hard filters go through approval; verification tasks dedupe; availability inserts enqueue one re-match", async () => {
    const t = tag("match");
    const req = await createRequirement(owner, { title: `Req ${t}`, orgName: `Org ${t}`, changes: [
      { key: "area", value: [12340, 12345, 12350] }, { key: "area_basis", value: "chargeable" }, { key: "power", value: "500 kVA" },
    ] }) as { id: string; row_version: number; constraints: { required_specs: Record<string, unknown> } };
    created.requirements.push(req.id);
    expect(req.constraints.required_specs).toEqual({ min_power_kva: 500 }); // free text fed the structured spec

    const cfg = await updateMatchingConfig(owner, req.id, req.row_version, {
      weights: { location: 35 }, hardFilters: { budget_ceiling: true }, catchments: [{ label: "Baner", lat: 18.56, lon: 73.78 }], requiredSpecs: { min_car_parks: 20 },
    }, "adviser set-up");
    expect(cfg.proposalId).toBeNull();
    expect(cfg.applied.sort()).toEqual(["catchments", "hard_filters", "required_specs", "weights"]);
    const c = (cfg.requirement as { constraints: Record<string, unknown> }).constraints;
    expect(c.hard_filters).toEqual({ budget_ceiling: true, latest_occupation: false, preferred_only: false });
    expect(c.required_specs).toEqual({ min_power_kva: 500, min_car_parks: 20 });
    await expectErr(updateMatchingConfig(owner, req.id, req.row_version, { weights: { cost: 5 } }), 409); // stale version

    // inventory: one asset with two spaces; power known, parking unknown → needs verification
    const asset = await owner.db.from("asset").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, name: `Tower ${t}`, specs: { power_kva: 800 } }).select("id").single();
    created.assets.push(asset.data!.id);
    const sp = await owner.db.from("space").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, asset_id: asset.data!.id, floor_text: "4", chargeable_sf: 12345 }).select("id").single();
    const run1 = await runShortlist(owner, req.id);
    const opt = run1.results.find((x) => x.spaceId === sp.data!.id)!;
    // shared WS1 holds other builders' spaces: the unique area range makes ours the only in-range candidate
    // (spaces left by earlier runs of this same fixture have the identical 12,345 SF and tie with ours: ignore them)
    const rivals = run1.results.filter((x) => x.eligibility !== "ineligible" && (x === opt || x.area?.value !== 12345));
    expect(rivals.indexOf(opt)).toBeLessThan(10);
    expect(opt.eligibility).toBe("needs_verification");
    expect(opt.qualifies).toContain("Meets power ≥ 500 kVA (building: 800)");
    const vt = async () => ((await owner.db.from("task").select("idempotency_key, status").eq("linked_entity_id", req.id).eq("source", VERIFY_TASK_SOURCE)).data ?? []).filter((x) => (x.idempotency_key as string).includes(sp.data!.id));
    const before = await vt();
    const code = (k: string) => k.slice(k.indexOf(sp.data!.id) + sp.data!.id.length + 1);
    expect(before.map((x) => code(x.idempotency_key)).sort()).toEqual(["hf_budget_unset", "no_availability", "spec:car_parks"]); // budget filter on but no budget yet → verify, never pass
    await runShortlist(owner, req.id);
    expect((await vt()).length).toBe(before.length); // deduped across runs

    // availability insert → exactly one queued deals.rematch for this requirement (statement trigger, deduped)
    const a = adminClient();
    const queued = async () => (await a.from("job").select("id").eq("workspace_id", WS1).eq("job_type", "deals.rematch").eq("state", "queued").eq("payload->>requirement_id", req.id)).data ?? [];
    const today = new Date().toISOString().slice(0, 10);
    await owner.db.from("availability").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, space_id: sp.data!.id, as_of: today, status: "available", available_from: "2027-01-01", asking_rent_min: 80, asking_rent_max: 80, rent_basis: "chargeable", valid_until: "2099-12-31", fact_status: "currently_confirmed" });
    await owner.db.from("availability").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, space_id: sp.data!.id, as_of: today, status: "available", available_from: "2027-01-01", asking_rent_min: 81, asking_rent_max: 81, rent_basis: "chargeable", valid_until: "2099-12-31", fact_status: "currently_confirmed" });
    expect((await queued()).length).toBe(1);

    // the job handler re-runs matching with the service role; the "no availability" verification task closes
    const res = await rematchRequirement(a, WS1, req.id, "availability insert") as { version: number };
    expect(res.version).toBe(run1.version + 2);
    const sv = await owner.db.from("shortlist_version").select("note").eq("requirement_id", req.id).eq("version", res.version).single();
    expect(sv.data!.note).toMatch(/auto re-match: availability insert/);
    const after = await vt();
    expect(after.find((x) => x.idempotency_key.endsWith(":no_availability"))!.status).toBe("done");

    // confirmed requirement: hard-filter change becomes a proposal; a direct DB write is refused
    const full = await updateRequirementFields(owner, req.id, Number((cfg.requirement as { row_version: number }).row_version), [
      { key: "objective", value: "relocation", status: "client_confirmed" }, { key: "decision_date", value: "2026-12-15", status: "client_confirmed" },
      { key: "occupation_date", value: "2027-03-01", status: "client_confirmed" }, { key: "area", value: [12340, 12345, 12350], status: "client_confirmed" },
      { key: "area_basis", value: "chargeable", status: "client_confirmed" }, { key: "budget", value: [70, 95], status: "client_confirmed" },
      { key: "budget_basis", value: "per_sf_month", status: "client_confirmed" }, { key: "budget_inclusions", value: "rent+CAM", status: "client_confirmed" },
      { key: "fitout_standard", value: "warm_shell", status: "client_confirmed" }, { key: "tenure_months", value: 60, status: "client_confirmed" },
      { key: "legal_entity", value: "Acme", status: "client_confirmed" }, { key: "commercial_authority", value: "CFO", status: "client_confirmed" },
      { key: "procurement_process", value: "board", status: "client_confirmed" }, { key: "current_lease_notice", value: "6 months", status: "client_confirmed" },
      { key: "mandate_status", value: "exclusive", status: "client_confirmed" }, { key: "conflict_status", value: "clear", status: "client_confirmed" },
    ], "brief");
    const na = await setNotApplicable(owner, req.id, Number((full.requirement as { row_version: number }).row_version), ["preferred_locations"]) as { row_version: number };
    const conf = await confirmRequirement(owner, req.id, na.row_version, { evidence: "signed brief" }) as { row_version: number; constraints: Record<string, unknown> };
    expect((await questionTasks(req.id)).every((x) => x.status === "done")).toBe(true);
    const direct = await owner.db.from("requirement").update({ constraints: { ...conf.constraints, hard_filters: { budget_ceiling: false } } }).eq("id", req.id).select("id");
    expect(direct.error?.code).toBe("42501");
    const p = await updateMatchingConfig(owner, req.id, conf.row_version, { hardFilters: { budget_ceiling: false, latest_occupation: true }, weights: { cost: 30 } }, "client relaxed budget");
    expect(p.proposalId).toBeTruthy();
    expect(p.applied).toEqual(["weights"]);
    const now = await owner.db.from("requirement").select("constraints").eq("id", req.id).single();
    expect((now.data!.constraints as Record<string, unknown>).hard_filters).toEqual({ budget_ceiling: true, latest_occupation: false, preferred_only: false });
    // confirmation and the config edit each enqueued a re-match — still at most one queued
    expect((await queued()).length).toBe(1);
  });
});
