/**
 * Workflow 11 round-2 integration tests (RLS enforced): unknown costs block approval unless acknowledged (recorded),
 * per-assumption approval invalidated by value changes, immutable versions, rounding rule stored, SQL guards.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { USERS, WS1, tag, userClient } from "../../../../tests/helpers";
import type { DealsCtx } from "../ctx";
import { DealsError } from "../ctx";
import { approveAssumptions, approveScenario, compareStoredScenarios, evaluateScenario, listAssumptions, recalculateScenario, revokeAssumption, runEngine } from "./service";
import type { FinanceInput } from "./types";

let owner: DealsCtx;
let colleague: DealsCtx;
beforeAll(async () => {
  owner = { db: await userClient("owner"), workspaceId: WS1, userId: USERS.owner.id, role: "owner" };
  colleague = { db: await userClient("colleague"), workspaceId: WS1, userId: USERS.colleague.id, role: "editor" };
});

const expectErr = async (p: Promise<unknown>, status: number, re?: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(DealsError);
  expect((e as DealsError).status).toBe(status);
  if (re) expect(JSON.stringify([(e as DealsError).message, (e as DealsError).details])).toMatch(re);
};

const input = (name: string, over: Partial<FinanceInput> = {}): FinanceInput => ({
  name, kind: "conventional", baseDate: "2027-01-01", horizonMonths: 60, annualDiscountRatePct: 12, tenureMonths: 60,
  area: { chargeableSf: 20000 }, rent: { basis: "chargeable", rate: 85, escalation: { pct: 15, everyMonths: 36 } },
  deposit: { months: 6 }, taxes: { treatment: "included" }, assumptionSources: { discount_rate: "client WACC" }, ...over,
});

describe("11 · unknown costs are visible gaps that block approval unless explicitly acknowledged", () => {
  it("stores gaps + rounding rule; refuses approval for unapproved assumptions, then for gaps; records the acknowledgement", async () => {
    const t = tag("fin");
    const sc = await evaluateScenario(owner, { input: input(`Gap ${t}`), save: true });
    const row = (await owner.db.from("finance_scenario").select("gaps, rounding_rule, version, output_hash, input_json").eq("id", sc.scenarioId!).single()).data!;
    expect((row.gaps as { item: string }[]).map((g) => g.item)).toEqual(["cam", "parking", "fitout", "opex", "reinstatement"]);
    expect((row.rounding_rule as { money: string }).money).toMatch(/0\.01/);
    expect(row.version).toBe(1);
    expect(runEngine(row.input_json as FinanceInput).outputHash).toBe(row.output_hash); // reproducible from stored inputs

    const reg = await listAssumptions(owner, sc.scenarioId!);
    expect(reg.map((a) => [a.key, a.approval_state]).slice(0, 2)).toEqual([["area", "unapproved"], ["deposit_terms", "unapproved"]]);
    expect(reg.find((a) => a.key === "discount_rate")!.source).toBe("client WACC");

    await expectErr(approveScenario(owner, sc.scenarioId!, { acknowledgeGaps: true }), 422, /unapproved assumption: Discount rate/);
    // an editor cannot approve assumptions; nobody can write an approval directly
    await expectErr(approveAssumptions(colleague, sc.scenarioId!, ["discount_rate"]), 404);
    const direct = await owner.db.from("finance_assumption").update({ approval_state: "approved", approved_by: USERS.owner.id }).eq("scenario_id", sc.scenarioId!).eq("key", "discount_rate").select("id");
    expect(direct.error?.code).toBe("42501");
    // direct scenario approval with pending assumptions is refused by SQL too
    const sqlGuard = await owner.db.from("finance_scenario").update({ approved_at: new Date().toISOString() }).eq("id", sc.scenarioId!).select("id");
    expect(sqlGuard.error?.code).toBe("42501");

    const ok = await approveAssumptions(owner, sc.scenarioId!, reg.map((a) => a.key), "per finance policy");
    expect(ok.approved).toBe(reg.length);
    await expectErr(approveScenario(owner, sc.scenarioId!), 422, /CAM \/ maintenance: unknown/);
    const sqlGap = await owner.db.from("finance_scenario").update({ approved_at: new Date().toISOString() }).eq("id", sc.scenarioId!).select("id");
    expect(sqlGap.error?.code).toBe("42501");

    const appr = await approveScenario(owner, sc.scenarioId!, { acknowledgeGaps: true, note: "CAM pending from landlord" }) as { approved_at: string; gaps_acknowledged: { by: string; gaps: { item: string }[]; note: string } };
    expect(appr.approved_at).toBeTruthy();
    expect(appr.gaps_acknowledged.by).toBe(USERS.owner.id);
    expect(appr.gaps_acknowledged.gaps.map((g) => g.item)).toContain("cam");
    const audit = await owner.db.from("approval").select("note").eq("subject_type", "finance_scenario").eq("subject_id", sc.scenarioId!).single();
    expect(audit.data!.note).toMatch(/Approved with acknowledged unknown costs: CAM \/ maintenance, Parking/);
    // stored gaps / rounding rule are engine output — not editable
    const tamper = await owner.db.from("finance_scenario").update({ gaps: [] }).eq("id", sc.scenarioId!).select("id");
    expect(tamper.error?.code).toBe("42501");

    // revoking an assumption drops the scenario approval
    await revokeAssumption(owner, sc.scenarioId!, "gst", "GST treatment under review");
    const after = await owner.db.from("finance_scenario").select("approved_at").eq("id", sc.scenarioId!).single();
    expect(after.data!.approved_at).toBeNull();
  });
});

describe("11 · versions: unchanged assumption approvals carry over; a changed assumption needs approval again", () => {
  it("recalculation creates v2, keeps v1, and re-opens only the changed assumption", async () => {
    const t = tag("ver");
    const complete = input(`Ver ${t}`, { costStates: { cam: "none", parking: "none", fitout: "none", opex: "none", reinstatement: "none" } });
    const v1 = await evaluateScenario(owner, { input: complete, save: true });
    expect(v1.result.complete).toBe(true);
    const keys = (await listAssumptions(owner, v1.scenarioId!)).map((a) => a.key);
    await approveAssumptions(owner, v1.scenarioId!, keys);
    await approveScenario(owner, v1.scenarioId!);

    const v2 = await recalculateScenario(owner, v1.scenarioId!, { ...complete, annualDiscountRatePct: 10 });
    expect(v2.version).toBe(2);
    expect(v2.carriedApprovals).toBe(keys.length - 1);
    const reg2 = await listAssumptions(owner, v2.scenarioId);
    expect(reg2.filter((a) => a.approval_state !== "approved").map((a) => a.key)).toEqual(["discount_rate"]);
    expect(reg2.find((a) => a.key === "rent_terms")!.approval_note).toMatch(/carried from v1/);
    await expectErr(approveScenario(owner, v2.scenarioId), 422, /Discount rate/);
    // v1 untouched and still approved; recalculating v1 again is refused (branching)
    const v1row = (await owner.db.from("finance_scenario").select("approved_at, output_hash").eq("id", v1.scenarioId!).single()).data!;
    expect(v1row.approved_at).toBeTruthy();
    await expectErr(recalculateScenario(owner, v1.scenarioId!, complete), 409, /newer version/);

    // comparison of stored versions: same horizon → comparable, completeness and pending assumptions reported
    expect((await compareStoredScenarios(owner, [v1.scenarioId!, v2.scenarioId])).error).toBe("unequal discount rates"); // 12% vs 10%: refused
    const alt = await evaluateScenario(owner, { input: { ...input(`Alt ${t}`, { annualDiscountRatePct: 10 }), rent: { basis: "chargeable", rate: 80 } }, save: true });
    const cmp = await compareStoredScenarios(owner, [v2.scenarioId, alt.scenarioId!]);
    expect(cmp.error).toBeNull();
    expect(cmp.comparison!.rows.map((r) => r.complete)).toEqual([true, false]);
    expect(cmp.comparison!.rows[1].gaps).toContain("CAM / maintenance");
    expect(cmp.scenarios[0].assumptionsPending).toBe(1);
    expect(cmp.drivers[0].top.length).toBeGreaterThan(0);
    const other = await evaluateScenario(owner, { input: { ...complete, annualDiscountRatePct: 10, name: `Short ${t}`, horizonMonths: 36, tenureMonths: 36 }, save: true });
    const bad = await compareStoredScenarios(owner, [v2.scenarioId, other.scenarioId!]);
    expect(bad.error).toMatch(/unequal horizons/);
  });
});
