# Module 12 — round 2 build brief (14 upgrades)

Read first: `AGENTS.md`, `src/modules/assistant/BUILD_BRIEF.md` (security rules still apply), `types.ts`, `TOOLS.md`,
`CONTEXT_AND_MEMORY.md`, and the files you touch. Current state: engine (`engine/run.ts`, `provider.ts` with prompt caching +
`buildRequestBody`, `execute.ts` with `compactForModel`), tool registry (`tools/index.ts`, groups in `tools/select.ts`),
memory, saved/scheduled commands, UI (`ui/chat.tsx`, `ui/blocks.tsx`, `ui/assistant-page.tsx`, `ui/panel.tsx`).
Local DB: `postgresql://postgres:postgres@127.0.0.1:54322/postgres` (pgvector extension available). Live Supabase also has pgvector.

## Shared-file rules (several agents run at once)
- **Do NOT edit** `tools/index.ts`, `tools/select.ts`, `src/lib/jobs/registry.ts`, `package.json`. New tools go in YOUR OWN new
  file `tools/<yourname>.ts` exporting `export const <name>Tools: ToolDef[]` and a suggested group name; the lead registers them.
  Need an npm package? Install is allowed ONLY for the packages named in your task; otherwise report it.
- `types.ts`: only the map agent may add Block kinds (it adds `map`). Others: report needed type changes instead.
- `ui/blocks.tsx`: only the deliverables/map agent edits it. `ui/chat.tsx` + `engine/run.ts` + `engine/provider.ts`: only the engine agent.
- Migrations: your own file in your timestamp range, re-runnable, `make_business_table` for business tables, apply locally with psql.
- Tests: vitest in your own folder/files; unique fixture names via `tag()`. No `next build/dev`, no git commits.
- Mock mode must still work with no `ANTHROPIC_API_KEY`. Never send anything externally. No LLM arithmetic.
- Finish with a short report: files, migrations, new tool exports + suggested group, packages installed, test results, gaps.

## Migration timestamp ranges
engine 20261111000100–0199 · evals 0200–0299 · data 0300–0399 · briefs 0400–0499 · documents 0500–0599 · outputs 0600–0699 · usage 0700–0799
