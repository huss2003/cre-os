/**
 * Assistant quality evals (Module 12) — CLI runner.
 *
 *   npx tsx scripts/assistant-evals.ts                 # mock planner (no key needed)
 *   npx tsx scripts/assistant-evals.ts --live          # real Claude (needs ANTHROPIC_API_KEY) + Claude grader for judge criteria
 *   options: --filter=<regex on case id>  --threshold=0.8 (case pass rate)  --no-write
 *
 * Prints a scorecard, writes src/modules/assistant/evals/results/<timestamp>.{json,md}, exits 1 below threshold.
 * Seeds the fixture world idempotently in the local WS1 workspace; refuses non-local Supabase.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// The engine imports "server-only"; re-exec once with a preload that stubs it (as vitest does).
if (!process.env.__ASSISTANT_EVALS_CHILD) {
  const r = spawnSync("npx", ["tsx", "--require", `${process.cwd()}/scripts/assistant-evals.preload.cjs`, process.argv[1], ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, __ASSISTANT_EVALS_CHILD: "1" } });
  process.exit(r.status ?? 1);
}

if (existsSync(".env.local")) for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const args = process.argv.slice(2);
const opt = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const LIVE = args.includes("--live");
const THRESHOLD = Number(opt("threshold") ?? (LIVE ? 0.8 : 1));
const FILTER = opt("filter") ? new RegExp(opt("filter")!) : undefined;

async function main() {
  const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error(`refusing to seed eval fixtures into non-local Supabase ${host}`);
  if (LIVE && !process.env.ANTHROPIC_API_KEY) { console.error("--live needs ANTHROPIC_API_KEY"); process.exit(2); }
  if (!LIVE) delete process.env.ANTHROPIC_API_KEY;
  process.env.ASSISTANT_RUNS_PER_MIN ??= "1000";

  const { userClient, adminClient, WS1, USERS } = await import("../tests/helpers");
  const { seedWorld } = await import("../src/modules/assistant/evals/fixtures");
  const { runCases, scorecard, score, writeReport } = await import("../src/modules/assistant/evals/runner");

  const db = await userClient("owner");
  const ctx = { db, userId: USERS.owner.id, email: USERS.owner.email, workspaceId: WS1, workspaceName: "WS1", timezone: "Asia/Kolkata", role: "owner",
    allowedClassifications: ["public", "permitted_personal", "corporate_confidential"], isPlatformAdmin: false, workspaces: [] } as never;
  const world = await seedWorld(db, adminClient());
  const mode = LIVE ? "live" : "mock";
  console.log(`Running assistant evals (${mode})…`);
  const results = await runCases({ ctx, world, mode, filter: FILTER, onCase: (r) => console.log(`${r.pass ? "PASS" : "FAIL"} ${r.id} (${r.status}, ${r.steps} steps, ~${r.inputTokens} tok, ${r.ms} ms)`) });
  console.log("\n" + scorecard(results));
  if (!args.includes("--no-write")) { const f = writeReport(results, mode); console.log(`\nWrote ${f.json}\n      ${f.md}`); }
  const s = score(results);
  if (s.caseRate < THRESHOLD) { console.error(`\nCase pass rate ${(s.caseRate * 100).toFixed(0)}% is below threshold ${(THRESHOLD * 100).toFixed(0)}%`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
