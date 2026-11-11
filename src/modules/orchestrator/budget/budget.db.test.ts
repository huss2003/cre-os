/**
 * Spec §18 Test 9 — budget limit. A budget scoped to a unique module (tag) so other agents' work in WS1 is never paused.
 * Usage tracked → non-critical job paused (deferred, not lost) → admins notified → critical work continues →
 * the requested provider is reported unchanged (no other provider is ever selected).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, tag, userClient, USERS, WS1 } from "../../../../tests/helpers";
import { budgetAlerts, budgetStates, checkBudget, guardHandlers, recordUsage, setBudget } from "./service";

const admin = adminClient() as any;
const MOD = tag("orchbud");
let budgetId = "";
const deferredJobs: string[] = [];

beforeAll(async () => {
  const owner = await userClient("owner");
  const b = await setBudget(owner as any, WS1, USERS.owner.id, { resource: "research", module: MOD, period: "daily", limitUnits: 2, unit: "calls", alertPct: 50 });
  budgetId = b.id;
});
afterAll(async () => {
  await admin.from("resource_budget").delete().eq("id", budgetId);
  await admin.from("resource_usage").delete().eq("workspace_id", WS1).in("module", [MOD, "jobs"]).like("dedupe_key", `%${MOD}%`);
  await admin.from("resource_usage").delete().eq("workspace_id", WS1).eq("module", MOD);
  await admin.from("outbox").delete().eq("workspace_id", WS1).like("dedupe_key", `orch:budget%${budgetId}%`);
  if (deferredJobs.length) await admin.from("job").delete().in("id", deferredJobs);
  await admin.from("job").delete().eq("workspace_id", WS1).eq("job_type", `${MOD}.research`);
});

describe("Test 9 — budget limit", () => {
  it("only admins can set budgets (RLS)", async () => {
    const col = await userClient("colleague");
    await expect(setBudget(col as any, WS1, USERS.colleague.id, { resource: "research", module: `${MOD}-x`, period: "daily", limitUnits: 1, unit: "calls" })).rejects.toBeTruthy();
  });

  it("tracks usage, pauses non-critical work when exhausted, notifies, keeps the provider", async () => {
    let ran = 0;
    const handlers = guardHandlers({ [`${MOD}.research`]: async () => { ran++; return { ok: true }; } }, () => admin, (t) => (t === `${MOD}.research` ? { resource: "research", module: MOD, critical: false } : null));
    const job = (id: string) => ({ id, workspace_id: WS1, job_type: `${MOD}.research`, payload: { org: "x" }, attempts: 1, due_at: "", dedupe_key: null });

    await recordUsage(admin, WS1, { resource: "research", module: MOD, units: 1, unit: "calls", dedupeKey: `${MOD}:u1` });
    await recordUsage(admin, WS1, { resource: "research", module: MOD, units: 1, unit: "calls", dedupeKey: `${MOD}:u1` }); // idempotent
    let st = (await budgetStates(admin, WS1)).find((s) => s.budget.id === budgetId)!;
    expect(st).toMatchObject({ used: 1, status: "near" });
    expect(await handlers[`${MOD}.research`](job(crypto.randomUUID()) as any)).toEqual({ ok: true });
    expect(ran).toBe(1);

    await recordUsage(admin, WS1, { resource: "research", module: MOD, units: 1, unit: "calls", dedupeKey: `${MOD}:u2` });
    st = (await budgetStates(admin, WS1)).find((s) => s.budget.id === budgetId)!;
    expect(st.status).toBe("exhausted");

    const jid = crypto.randomUUID();
    const res: any = await handlers[`${MOD}.research`](job(jid) as any);
    expect(ran).toBe(1); // paused, not run
    expect(res.paused).toBe("budget_exhausted");
    expect(res.resumeAt).toBe(st.resetsAt);
    const { data: def } = await admin.from("job").select("id, due_at, payload, state").eq("workspace_id", WS1).eq("job_type", `${MOD}.research`);
    expect(def).toHaveLength(1); // deferred to the reset, work preserved
    deferredJobs.push(def[0].id);
    expect(def[0].payload._budgetDeferredFrom).toBe(jid);

    const crit = await checkBudget(admin, WS1, { resource: "research", module: MOD, provider: "openai", critical: true });
    expect(crit).toMatchObject({ allowed: true, critical: true, provider: "openai" });
    const non = await checkBudget(admin, WS1, { resource: "research", module: MOD, provider: "openai" });
    expect(non).toMatchObject({ allowed: false, provider: "openai" });
    expect(non.reason).toMatch(/paused/);

    await budgetAlerts(admin, WS1);
    await budgetAlerts(admin, WS1); // once per budget/period/level
    const { data: alerts } = await admin.from("outbox").select("dedupe_key, user_id").eq("workspace_id", WS1).like("dedupe_key", `orch:budget:${budgetId}:%:exhausted:%`);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.map((a: any) => a.user_id)).toContain(USERS.owner.id);
    const { data: paused } = await admin.from("outbox").select("id").eq("workspace_id", WS1).like("dedupe_key", `orch:budget_paused:${budgetId}%`);
    expect(paused.length).toBeGreaterThan(0);
  });
});
