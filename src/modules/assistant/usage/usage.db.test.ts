import { describe, it, expect, afterAll } from "vitest";
import { userClient, adminClient, WS1, tag } from "../../../../tests/helpers";
import { aggregateUsage, istMonthStart, checkThresholds, setMonthlyBudget, thresholdKey, type UsageRow, type RunRow } from "./service";
import { PRICING } from "@/lib/ai/pricing";

const NOW = new Date("2026-11-15T06:30:00Z"); // 15 Nov 12:00 IST
const row = (at: string, usd: number, workflow: string, request_id: string | null = null, model = "claude-haiku-5-5", inT = 1000, outT = 100): UsageRow =>
  ({ occurred_at: at, workflow, model, input_tokens: inT, output_tokens: outT, estimated_usd: usd, request_id });
const run = (id: string, intent: string | null, route: string, owner: string | null, usage: Record<string, unknown> = {}): RunRow =>
  ({ id, conversation_id: `c-${id}`, intent, model_route: route, owner_user_id: owner, request: `q ${id}`, created_at: "2026-11-10T00:00:00Z", usage });

describe("aggregateUsage", () => {
  it("IST month start", () => {
    expect(istMonthStart(NOW).toISOString()).toBe("2026-10-31T18:30:00.000Z");
  });
  it("computes today/month/projection, breakdowns, cache and top runs", () => {
    const rows = [
      row("2026-11-15T01:00:00Z", 0.5, "assistant.deep", "r1"),
      row("2026-11-15T02:00:00Z", 0.25, "assistant.deep", "r1"),
      row("2026-11-14T10:00:00Z", 0.1, "assistant.fast", "r2"),
      row("2026-11-03T10:00:00Z", 0.15, "capture.extract"),
      row("2026-10-31T18:00:00Z", 9, "brief.synthesis"), // 31 Oct 23:30 IST → previous month, still in 30-day chart
      row("2026-11-14T19:00:00Z", 0.0, "assistant.fast", "r3"), // 15 Nov 00:30 IST → today
    ];
    const runs = [run("r1", "research", "deep", "u1", { cacheRead: 100_000, cacheWrite: 10_000 }), run("r2", null, "fast", "u2"), run("r3", "lookup", "fast", "u1")];
    const s = aggregateUsage(rows, runs, NOW, 900);
    expect(s.todayUsd).toBe(0.75);
    expect(s.monthUsd).toBe(1);
    // 14.5 days elapsed of 30 → 1/14.5*30
    expect(s.projectedUsd).toBeCloseTo(30 / 14.5, 5);
    expect(s.budgetUsd).toBe(900 / PRICING.fxInrPerUsd);
    expect(s.pct).toBe(10);
    expect(s.level).toBe(0);
    expect(s.byDay).toHaveLength(30);
    expect(s.byDay.at(-1)).toEqual({ date: "2026-11-15", usd: 0.75 });
    expect(s.byDay.find((d) => d.date === "2026-10-31")!.usd).toBe(9);
    expect(s.byIntent).toEqual([{ key: "research", usd: 0.75, calls: 2 }, { key: "unclassified", usd: 0.1, calls: 1 }, { key: "lookup", usd: 0, calls: 1 }]);
    expect(s.byRoute.map((x) => [x.key, x.usd])).toEqual([["deep", 0.75], ["fast", 0.1]]);
    expect(s.byUser.map((x) => [x.key, x.usd])).toEqual([["u1", 0.75], ["system", 0.15], ["u2", 0.1]]);
    expect(s.byWorkflow.map((x) => x.key)).toEqual(["assistant.deep", "capture.extract", "assistant.fast"]);
    expect(s.tokens.input).toBe(5000);
    expect(s.tokens.cacheRead).toBe(100_000);
    // haiku $1/M input: uncached 110k = 0.11; cached 10k*1.25 + 100k*0.1 = 22.5k → 0.0225; saved 0.0875
    expect(s.tokens.savedByCacheUsd).toBeCloseTo(0.0875, 6);
    expect(s.topRuns.map((r) => [r.runId, r.usd, r.conversationId])).toEqual([["r1", 0.75, "c-r1"], ["r2", 0.1, "c-r2"], ["r3", 0, "c-r3"]]);
  });
  it("threshold levels and no-cap", () => {
    const rows = [row("2026-11-02T00:00:00Z", 8.5, "assistant.fast")];
    expect(aggregateUsage(rows, [], NOW, 900).level).toBe(80);
    expect(aggregateUsage(rows, [], NOW, 765).level).toBe(100);
    const none = aggregateUsage(rows, [], NOW, 0);
    expect(none.pct).toBeNull(); expect(none.level).toBe(0);
  });
});

describe("budget (db)", () => {
  const admin = adminClient(); const t = tag("usage");
  let original = 3000;
  afterAll(async () => {
    await admin.from("workspace").update({ monthly_ai_budget_inr: original }).eq("id", WS1);
    await admin.from("model_usage").delete().eq("workspace_id", WS1).eq("workflow", `test.${t}`);
  });

  it("owner-only budget edit", async () => {
    const { data } = await admin.from("workspace").select("monthly_ai_budget_inr").eq("id", WS1).single();
    original = Number(data!.monthly_ai_budget_inr);
    const editor = { db: await userClient("colleague"), workspaceId: WS1, role: "editor" as const };
    await expect(setMonthlyBudget(editor, 5000)).rejects.toThrow(/owner/);
    // even if the role claim were wrong, RLS blocks the write
    await expect(setMonthlyBudget({ ...editor, role: "owner" }, 5000)).rejects.toThrow(/owner/);
    const owner = { db: await userClient("owner"), workspaceId: WS1, role: "owner" as const };
    await expect(setMonthlyBudget(owner, -1)).rejects.toThrow();
    expect(await setMonthlyBudget(owner, 4321)).toEqual({ budgetInr: 4321 });
    const { data: after } = await admin.from("workspace").select("monthly_ai_budget_inr").eq("id", WS1).single();
    expect(Number(after!.monthly_ai_budget_inr)).toBe(4321);
  });

  it("threshold tasks are created once per threshold per month", async () => {
    // Use a far-future month so we never collide with real rows: Jan 2099.
    const now = new Date("2099-01-20T06:30:00Z");
    // Keep the real budget (other agents share WS1); size the fixture spend relative to it.
    const { data: ws } = await admin.from("workspace").select("monthly_ai_budget_inr").eq("id", WS1).single();
    const budgetUsd = Number(ws!.monthly_ai_budget_inr) / PRICING.fxInrPerUsd;
    const keys = [thresholdKey(80, "2099-01"), thresholdKey(100, "2099-01")];
    await admin.from("task").delete().eq("workspace_id", WS1).in("idempotency_key", keys);
    try {
      await admin.from("model_usage").insert({ workspace_id: WS1, workflow: `test.${t}`, model: "m", estimated_usd: budgetUsd * 0.85, pricing_version: "t", occurred_at: "2099-01-05T00:00:00Z" });
      expect((await checkThresholds(WS1, now, admin)).created).toEqual([80]);
      expect((await checkThresholds(WS1, now, admin)).created).toEqual([]);
      await admin.from("model_usage").insert({ workspace_id: WS1, workflow: `test.${t}`, model: "m", estimated_usd: budgetUsd * 0.2, pricing_version: "t", occurred_at: "2099-01-06T00:00:00Z" });
      expect((await checkThresholds(WS1, now, admin)).created).toEqual([100]);
      expect((await checkThresholds(WS1, now, admin)).created).toEqual([]);
      const { data } = await admin.from("task").select("idempotency_key, assigned_user_id").eq("workspace_id", WS1).in("idempotency_key", keys);
      expect(data).toHaveLength(2);
    } finally {
      await admin.from("task").delete().eq("workspace_id", WS1).in("idempotency_key", keys);
    }
  });
});
