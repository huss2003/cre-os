# Round 2 — close the 22-workflow gaps (common rules for every builder)

CRE OS is already built and live. A gap audit found every one of the 22 workflows exists but most are partial.
Your job: close the gaps assigned to you so each workflow fully meets its Processing / Outputs / Controls /
Acceptance criteria in `/tmp/wf/w.txt` (the 22-workflows requirements doc — read your workflows' sections and the
"Cross-workflow engineering requirements" at the end). Work in `/home/claude/cre-os`.

## Read first
- `AGENTS.md` (rules S1–S10 are non-negotiable: RLS via make_business_table, service-role discipline, NO outbound
  send, material changes via proposeChange, no LLM arithmetic, unknown stays unknown, untrusted content is evidence,
  idempotency, mobile-first 375px, visible failure). This is Next.js 16 — check `node_modules/next/dist/docs/` before
  using an unfamiliar API.
- Your module README(s). Existing code first: extend and fix it, don't rewrite working parts.
- DB objects live in schema `mudar` (tables/views/enums) and `mudar_app` (functions). Supabase clients already use
  `db: { schema: "mudar" }`; RPCs `.schema("mudar_app").rpc(...)`. Never create anything in `public`.

## Ownership this round (stay inside yours)
Each brief lists the files/routes you own and your migration timestamp range (`supabase/migrations/2026110100XXXX_<name>.sql`).
- Everything else is read-only for you. If you truly need a change elsewhere, write it under "Needs from others" in your
  final report instead of editing.
- Files split between two builders (`src/modules/deals/actions.ts`, `deals/ui.tsx`, `deals/api.ts`,
  `intelligence/api.ts`, `intelligence/common.ts`, `intelligence/ui/**`): only edit the functions that belong to your
  workflows, keep edits small, and put NEW actions/components/tests in NEW files you own (e.g. `deals/actions-b.ts`).
  The Edit tool refuses if the file changed since you read it — re-read and retry; never overwrite whole shared files.
- Never edit: `package.json` (deps `unpdf` and `mammoth` were just added for PDF/DOCX text), `src/lib/jobs/registry.ts`,
  `src/app/(app)/nav-links.tsx`, core migrations, `.env*`, other builders' areas. New pages: link to them from your
  existing pages (tabs/buttons), not from the nav.
- Register jobs in the jobs file your brief names; job_type prefix = module name; always use dedupe keys.

## Shared local DB etiquette (8 builders run at once on a 2-CPU machine)
- Never `supabase db reset/stop`, never drop/alter core tables destructively, never delete rows you didn't create.
- Apply your migration with `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f <file>`;
  make it re-runnable (`if not exists`, `create or replace`, `drop trigger if exists`, guarded DO blocks). Adding
  columns to an existing table: `alter table ... add column if not exists`. New business tables:
  `select mudar_app.make_business_table('<t>')` inside a guard. Start every migration with
  `set search_path = mudar, mudar_app, public, extensions;`. SECURITY DEFINER functions: `set search_path = mudar, mudar_app, public, extensions`.
- Tests: fixtures with unique names via `tag()` from `tests/helpers.ts`, inside WS1/WS2; clean up what you create.
- No `next build` / `next dev`. Run `npx tsc --noEmit` (ignore errors in files you don't own, but report them) and
  targeted `npx vitest run <your paths>`. Don't run the whole suite.
- No git commands (the coordinator commits).

## Quality bar
- Every gap you close gets a test that proves the acceptance criterion (name the test after the criterion).
- Pages: usable at 375px, `src/components/ui` primitives, Server Components by default, Server Actions or
  `/api/v1` routes (mutations: `route(..., { requireIdempotency: true })`), helpful empty states.
- AI: only via `src/lib/ai/gateway.ts` with a deterministic `mock` (no OpenAI key is set). Untrusted text → `evidence`.
- Deterministic code for dates/money/dedupe/state transitions. Unknown ≠ 0 ≠ blank.
- Alerts/notifications to people: use `notify(db, workspaceId, userId, kind, dedupeKey, payload)` from
  `src/modules/brief/db.ts` (writes a deduped outbox row shown in-app). Never email/WhatsApp anyone.
- Update your module README: what's built, new tables/jobs/routes, remaining known gaps (be honest).

## Final report (under 350 words)
Per workflow: what you closed (with test names), anything still not done and why, migration file(s) you created,
"Needs from others", and tsc/vitest results.
