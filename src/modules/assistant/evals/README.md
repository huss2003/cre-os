# Assistant quality evals (Module 12)

A regression suite for the assistant: a seeded fixture world, about 35 realistic broker turns with checks a machine can verify, and one runner you can use in two ways.

## Run it

```bash
# CI gate: mock planner, no API key, every case must pass
npx vitest run src/modules/assistant/evals
EVALS_WRITE=1 npx vitest run src/modules/assistant/evals     # also write results/<timestamp>.{json,md}

# CLI, mock mode (same cases, prints a scorecard, writes results/)
npx tsx scripts/assistant-evals.ts

# CLI, live mode: real Claude (needs ANTHROPIC_API_KEY) + a cheap Claude grader for the free-text `judge` criteria
npx tsx scripts/assistant-evals.ts --live
#   --filter=<regex on case id>   --threshold=0.8 (case pass rate; default 1.0 mock / 0.8 live)   --no-write
```

The CLI exits with code 1 when the case pass rate is below the threshold, and with code 2 when you pass `--live` without a key. It runs only against a local Supabase. It re-runs itself with `scripts/assistant-evals.preload.cjs`, which stubs `server-only` the same way vitest does.

## What is in it

| File | Purpose |
|---|---|
| `fixtures.ts` | `seedWorld()` builds a fixed-name world in WS1 and is idempotent: it finds rows by name, then updates or inserts. Each seed resets the state the evals change (memories, opportunity stage, draft state). The world has: Quillon Analytics / Quillon Biotech (an ambiguous name), Marrowind Logistics (a lease with no expiry), Tavish Rendell / Inara Kotwal, three Kharadi buildings with coordinates, spaces and availability, a metro station, leases, a requirement with two rejected options and their reasons, a stalled opportunity (stage history, overdue next action, an overdue task), a meeting with a prep and a commitment note, an interaction with a promise, a planned outreach item plus an unsent draft, an active memory and an outdated one, and an attachment (board memo text that contains a prompt-injection line). WS2 holds one secret company, used for the permission probes. |
| `cases.ts` | The cases. `expect` applies in both modes, `mock` and `live` add checks for one mode only, `judge` holds free-text criteria (graded only in live mode), and `after` holds DB post-conditions (draft still unsent, stage unchanged, memory history kept). Turns that share a `thread` run in one conversation, for pronoun and deictic follow-ups. |
| `runner.ts` | Runs the cases through `runAssistant`. It reads the stored message and the `assistant_tool_execution` rows, then applies the checks plus these global invariants: no other-workspace data, no category C tool executed, no "sent/approved/archived" claims, and no failed run. It estimates input tokens as chars/4 of the exact `buildRequestBody()` payload (the same method as `engine/token-bench.test.ts`) and also produces the scorecard and report. |
| `evals.test.ts` | The vitest gate (mock mode). It seeds twice to prove the seed is idempotent. |

Coverage of spec §21 tests 1–10 is marked in the `§21` column of the scorecard. Variants cover pronoun follow-ups, ambiguous names, permission probes (by focus, by name and by search), "send" requests (with focus, without focus, and an injected instruction), memory correction (with focus, via a pronoun, and an unknown subject), numbers questions, and stage-change / archive requests that must need approval.

## Check vocabulary

`tools`, `toolsAny`, `toolsNot`, `toolStatus` (ok, needs_approval, denied…), `toolInput` (substrings of the tool input JSON), `include`, `exclude` (strings or regexes over the answer text and blocks), `status` (run status), `blocks` (required block kinds), `coverage`, `maxSteps`, `maxInputTokens` (defaults are in `DEFAULT_LIMITS`).

**Tool renames:** tool ids are checked against `TOOLS` at runtime. A check that names a missing tool is reported as **skipped**, not as failed. Update `cases.ts` when tools are renamed.

## Adding a case

Add an object to `CASES`. Keep the base `expect` true for the mock planner (`engine/mock.ts`, `engine/router.ts`). Put stricter checks that only a real model can meet under `live`, and qualitative criteria under `judge`.

## Notes

- Results go to `results/`, which git ignores.
- The live grader uses `callStructured` (Claude when `ANTHROPIC_API_KEY` is set). The assistant's answer is passed as untrusted `evidence`. If the grader fails, judge checks are marked skipped rather than failed.
- The engine enforces the WS1 monthly AI budget. If other suites push WS1 spend over its budget, runs fail with "AI budget reached". That is an environment problem, not an assistant regression.
