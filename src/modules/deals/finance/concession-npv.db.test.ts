/**
 * Concession ladder NPV equivalent (Deal Strategist steps priced by finance engine fin-1.0). Unknown → NULL, never 0.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { USERS, WS1, adminClient, tag, userClient } from "../../../../tests/helpers";
import type { DealsCtx } from "../ctx";
import { createRequirement } from "../requirements/service";
import { createQuote, reviseQuote } from "../quotes/service";
import { createOpportunity } from "../pipeline/service";
import { evaluateScenario, inputFromQuote } from "./service";
import { concessionEquivalence } from "./engine";
import { computeConcessionNpv, concessionFromValue } from "./concession-npv";

let owner: DealsCtx;
const steps: string[] = [];
beforeAll(async () => { owner = { db: await userClient("owner"), workspaceId: WS1, userId: USERS.owner.id, role: "owner" }; });
afterAll(async () => {
  const a = adminClient();
  for (const id of steps) {
    await a.from("job").delete().eq("workspace_id", WS1).eq("job_type", "deals.concession_npv").eq("payload->>step_id", id);
    await a.from("concession_step").delete().eq("workspace_id", WS1).eq("id", id);
  }
});

describe("concession step → finance type + size (pure)", () => {
  it("maps value_json to an engine concession; anything missing is a reason, not zero", () => {
    expect(concessionFromValue({ finance_type: "rent_free", finance_value: 2 })).toEqual({ type: "rent_free", months: 2 });
    expect(concessionFromValue({ finance_type: "deposit_months", finance_value: "-2" })).toEqual({ type: "deposit_months", months: -2 });
    expect(concessionFromValue({ finance_type: "rent_free" })).toMatch(/finance_value .* not recorded/);
    expect(concessionFromValue({ finance_type: null })).toMatch(/not a priced concession/);
    expect(concessionFromValue({ finance_type: "capex_support", finance_value: 0 })).toMatch(/positive/);
  });
});

describe("concession_step.npv_equivalent is filled deterministically by the finance engine", () => {
  it("null until a base scenario exists; equals concessionEquivalence once it does; re-prices (to null) when the quote is revised", async () => {
    const t = tag("cnpv");
    const a = adminClient();
    const req = await createRequirement(owner, { title: `Req ${t}`, orgName: `Org ${t}` }) as { id: string };
    const opp = await createOpportunity(owner, { name: `Opp ${t}`, requirementId: req.id }) as { id: string };
    const q = await createQuote(owner, { requirementId: req.id, validUntil: "2099-12-31", terms: { rent: 85, rent_basis: "chargeable", rent_free_months: 2, deposit_months: 6, escalation_pct: 15, escalation_every_months: 36, tenure_months: 60, gst: "included" } }) as { id: string; version: number; valid_until: string; terms_json: Record<string, unknown> };
    const ins = await owner.db.from("concession_step").insert([
      { workspace_id: WS1, owner_user_id: USERS.owner.id, opportunity_id: opp.id, quote_id: q.id, step_no: 1, concession_type: "rent_free", ask: "1 more month rent-free", value_json: { item: "rent_free", finance_type: "rent_free", finance_value: 1 } },
      { workspace_id: WS1, owner_user_id: USERS.owner.id, opportunity_id: opp.id, quote_id: q.id, step_no: 2, concession_type: "deposit", ask: "lower deposit", value_json: { item: "deposit", finance_type: "deposit_months" } },
    ]).select("id");
    expect(ins.error).toBeNull();
    const [s1, s2] = ins.data!.map((x) => x.id as string);
    steps.push(s1, s2);
    const queued = async (id: string) => ((await a.from("job").select("id").eq("workspace_id", WS1).eq("job_type", "deals.concession_npv").eq("state", "queued").eq("payload->>step_id", id)).data ?? []).length;
    expect(await queued(s1)).toBe(1);

    // no scenario for the quote yet → unknown (NULL, not 0)
    let r = await computeConcessionNpv(a, WS1, s1);
    expect(r.npv).toBeNull();
    let row = (await owner.db.from("concession_step").select("npv_equivalent, engine_version, value_json").eq("id", s1).single()).data!;
    expect(row.npv_equivalent).toBeNull();
    expect(row.engine_version).toBeNull();
    expect((row.value_json as { finance_equivalence: { reason: string } }).finance_equivalence.reason).toMatch(/no finance scenario/);
    expect((row.value_json as { item: string }).item).toBe("rent_free"); // strategist fields preserved

    // a scenario for the quote → priced; the scenario insert re-queued (still deduped to one queued job)
    const input = inputFromQuote({ name: `Base ${t}`, baseDate: "2027-01-01", horizonMonths: 60, annualDiscountRatePct: 12, quote: q as never, space: { chargeable_sf: 20000 } });
    await evaluateScenario(owner, { input, requirementId: req.id, save: true });
    expect(await queued(s1)).toBe(1);
    r = await computeConcessionNpv(a, WS1, s1);
    const expected = concessionEquivalence(input, [{ type: "rent_free", months: 1 }])[0].npvValue;
    expect(r.npv).toBe(expected);
    expect(Number(expected)).toBeGreaterThan(0);
    const priced = (await owner.db.from("concession_step").select("npv_equivalent, engine_version").eq("id", s1).single()).data!;
    expect(Number(priced.npv_equivalent)).toBe(Number(expected));
    expect(priced.engine_version).toBe("fin-1.0");
    // size unknown → stays NULL
    expect((await computeConcessionNpv(a, WS1, s2)).npv).toBeNull();
    expect((await owner.db.from("concession_step").select("npv_equivalent").eq("id", s2).single()).data!.npv_equivalent).toBeNull();

    // quote revised → steps on the old version are re-queued and priced against the CURRENT version (no scenario yet → NULL)
    await a.from("job").delete().eq("workspace_id", WS1).eq("job_type", "deals.concession_npv").eq("payload->>step_id", s1);
    await reviseQuote(owner, q.id, { terms: { rent: 80 }, evidence: "landlord counter" });
    expect(await queued(s1)).toBe(1);
    r = await computeConcessionNpv(a, WS1, s1);
    expect(r.npv).toBeNull();
    expect((await owner.db.from("concession_step").select("engine_version").eq("id", s1).single()).data!.engine_version).toBeNull();
  });
});
