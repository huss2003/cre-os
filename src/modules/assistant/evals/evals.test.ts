// Assistant quality regression suite — mock mode CI gate. Run: npx vitest run src/modules/assistant/evals
// Live mode (real Claude + grader): npx tsx scripts/assistant-evals.ts --live   (see evals/README.md)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { userClient, adminClient, WS1, USERS } from "../../../../tests/helpers";
import type { AppContext } from "@/lib/auth/context";
import { seedWorld, type World } from "./fixtures";
import { CASES } from "./cases";
import { runCases, scorecard, writeReport, type CaseResult } from "./runner";

delete process.env.ANTHROPIC_API_KEY;
process.env.ASSISTANT_RUNS_PER_MIN = "1000";

let ctx: AppContext;
let world: World;
const results = new Map<string, CaseResult>();

beforeAll(async () => {
  const db = await userClient("owner");
  ctx = { db, userId: USERS.owner.id, email: USERS.owner.email, workspaceId: WS1, workspaceName: "WS1", timezone: "Asia/Kolkata", role: "owner",
    allowedClassifications: ["public", "permitted_personal", "corporate_confidential"], isPlatformAdmin: false, workspaces: [] } as AppContext;
  world = await seedWorld(db, adminClient());
  world = await seedWorld(db, adminClient()); // idempotent: second seed must not duplicate
  for (const r of await runCases({ ctx, world, mode: "mock" })) results.set(r.id, r);
}, 600_000);

afterAll(() => {
  const all = [...results.values()];
  console.log(scorecard(all));
  if (process.env.EVALS_WRITE) console.log(writeReport(all, "mock"));
});

describe("fixture world", () => {
  it("is idempotent (one row per fixture name)", async () => {
    const { data } = await ctx.db.from("organisation").select("id").eq("workspace_id", WS1).eq("display_name", "Quillon Analytics");
    expect(data!.length).toBe(1);
    const { data: so } = await ctx.db.from("shortlist_option").select("id").eq("workspace_id", WS1).eq("requirement_id", world.req.id);
    expect(so!.length).toBe(3);
  });
});

describe("assistant evals (mock mode)", () => {
  it.each(CASES.map((c) => [c.id, c.request] as const))("%s — %s", (id) => {
    const r = results.get(id)!;
    const failed = [...r.checks, ...r.judge].filter((c) => c.pass === false).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`);
    expect(failed, `answer: ${r.answer.slice(0, 400)}`).toEqual([]);
  });
});
