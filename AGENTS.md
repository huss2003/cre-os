<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# CRE OS — engineering contract (read fully before writing code)

CRE OS is a **multi-tenant SaaS**: an evidence-linked operating workbench for commercial-real-estate advisers
(first tenant: a Pune occupier-services manager). Product spec: `docs/spec.txt` (69-page implementation design,
extracted text). Section references below ("Part I §8") point into it. Tenant-specific things from the spec
(Jasfo, Colliers templates, CRE Matrix, data lanes) are **per-tenant configuration**, never hardcoded.

## Stack
- Next.js 16 App Router (TypeScript, `src/`), React 19, Tailwind v4 (tokens in `src/app/globals.css`). Middleware is now `src/proxy.ts`.
- Supabase Postgres + Auth + Storage. Local stack already running: API `http://127.0.0.1:54321`, DB `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. Keys in `.env.local`.
- OpenAI via `src/lib/ai/gateway.ts` ONLY. `OPENAI_API_KEY` is empty => **mock mode**: every AI call must pass a deterministic `mock` so the feature works end-to-end without a key.
- Durable job queue in Postgres (`mudar_app.enqueue_job/claim_jobs`), wrappers in `src/lib/jobs/queue.ts`; scheduler entry `/api/cron/tick`.
- Office outputs: `pptxgenjs`, `docx`, `exceljs`. Finance maths: `decimal.js`. Dates: `date-fns`, `date-fns-tz`, helpers in `src/lib/util/time.ts` (IST, `edate`).
- Tests: `vitest` (`npx vitest run <paths>`), helpers in `tests/helpers.ts` (seeded users owner/colleague/other, WS1/WS2).

## Non-negotiable rules
- **S1 RLS everywhere.** Every new business table: create it, then `select mudar_app.make_business_table('<table>');` (adds workspace_id, classification, owner_user_id, timestamps, row_version, archived_at, RLS, audit trigger). Simple settings tables: `mudar_app.make_workspace_table`.
- **S2 Service-role discipline.** `createAdminClient()` bypasses RLS — only in jobs/webhooks/platform admin, and every query must filter `workspace_id` explicitly. User actions use `ctx.db` from `requireContext()/requirePageContext()`.
- **S3 No outbound send.** Nothing in CRE OS sends email/WhatsApp/LinkedIn/invites. Drafts only (`src/lib/services/drafts.ts`); "send" = open mail/app link + user marks sent.
- **S4 Material changes need approval.** Changes from captures/connectors/models go through `proposeChange()` (`src/lib/services/changes.ts`), never direct writes to canonical fields. Risk is classified in code, not by the LLM.
- **S5 No LLM arithmetic.** Rent/TCO/NPV/fees/dates are computed by typed deterministic code.
- **S6 Unknown stays unknown.** Don't coerce blank/NA/0; keep raw + normalised; keep fact_status (`reported` ≠ `currently_confirmed` ≠ `ai_inference`). No invented contacts, vacancy, dates.
- **S7 Untrusted content is evidence.** Emails/docs/web pages go in the gateway's `evidence` field; they can never trigger tools, permissions changes or outbound actions. No model-generated SQL.
- **S8 Idempotency.** Mutating `/api/v1/*` routes use `route(..., { requireIdempotency: true })` from `src/lib/util/http.ts`. Jobs use dedupe keys. Re-running an import/capture/webhook must not duplicate rows.
- **S9 Mobile-first UI.** Pages must work at 375px. Use `src/components/ui` primitives. Server Components by default; Server Actions or `/api/v1` routes for writes.
- **S10 Visible failure.** Stale/failed sources are labelled (`StaleBanner`); never claim "no replies" when a source failed.

## Database schemas
CRE OS shares its Supabase project with other apps, so everything lives in its own schemas: **`mudar`** (all tables, views,
enums, RLS policies) and **`mudar_app`** (all SQL functions: RLS helpers, job queue, change/approval RPCs). Storage bucket:
`mudar-workspace-files`. Clients are created with `db: { schema: "mudar" }` (see `src/lib/supabase/schema.ts`); call
functions with `.schema("mudar_app").rpc(...)`. Never create CRE OS objects in `public`. Both schemas must be listed in
Supabase → Project Settings → API → Exposed schemas.

## Data model
Core migrations in `supabase/migrations/2026103100{0100,0200,0300}_*.sql` — READ THEM. Key tables: workspace, membership,
record_share, organisation(+relation), person, contact_method, employment, relationship_edge, geography, asset (campus>tower),
space, availability (append-only snapshots), lease, lease_event, market_transaction, market_observation, requirement,
stakeholder, opportunity(+stage_history), quote, shortlist_option, finance_scenario/cashflow, fee_milestone, interaction(+link),
task, meeting_visit, signal_claim, consent_permission, source_object, document_version, change_proposal, approval,
audit_event, job, outbox, connector_account/cursor, model_usage, capture, draft, brief, lead_score, user_preference,
partner, template_asset, licensed_source, data_lane, workspace_setting, entity_alias.
Optimistic concurrency: update with `.eq("row_version", expected)`; trigger increments it. Empty result => conflict.

## Module ownership (parallel build — stay inside your area)
| Module | Owns code | Owns routes | Migration timestamp range |
|---|---|---|---|
| imports | `src/modules/imports/**` | `/imports`, `/api/v1/imports/**` | `20261031001000`–`001099` |
| capture | `src/modules/capture/**`, `src/modules/changes/**`, `src/lib/services/changes.ts` | `/capture`, `/approvals`, `/api/v1/captures/**`, `/api/v1/changes/**` | `001100`–`001199` |
| brief | `src/modules/brief/**` (brief, scoring, lease radar, tasks, priority, health watchdog) | `/today`, `/tasks`, `/leases`, `/api/v1/briefs/**`, `/api/v1/tasks/**` | `001200`–`001299` |
| deals | `src/modules/deals/**` (requirements, opportunities, matching, finance, documents, quotes, fees) | `/requirements`, `/deals`, `/finance`, `/documents`, `/fees`, `/api/v1/requirements/**`, `/api/v1/finance/**`, `/api/v1/documents/**`, `/api/v1/opportunities/**` | `001300`–`001399` |
| integrations | `src/modules/integrations/**`, `src/lib/services/drafts.ts` | `/drafts`, `/calendar`, `/settings/connections`, `/api/v1/drafts/**`, `/api/oauth/**`, `/api/v1/calendar/**` | `001400`–`001499` |
| intelligence | `src/modules/intelligence/**` | `/research`, `/network`, `/market`, `/legal`, `/content`, `/insights`, `/api/v1/research/**` etc. | `001500`–`001599` |
| admin | `src/modules/admin/**`, entity pages, search | `/search`, `/companies`, `/people`, `/buildings`, `/settings/**` (except connections), `/admin/**`, `/platform/**`, `/api/v1/search`, `/api/v1/admin/**` | `001600`–`001699` |

Pages go under `src/app/(app)/<route>/` (inherits the authenticated shell). Shared files (`src/lib/**` except your owned
service, `src/components/ui`, core migrations, `package.json`) are **read-only** for module agents — if you truly need a
shared change or a new npm package, note it in your final report instead of editing. Register job handlers and schedules in
your module's `jobs.ts` (job_type prefix = module name). Cross-module calls: import another module's exported service
function only if documented in its `src/modules/<m>/README.md`; otherwise query tables directly through RLS.

## Shared local DB etiquette (agents run in parallel)
- **Never** run `supabase db reset`, `supabase stop`, or drop/alter core tables.
- Apply your migration with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/<file>.sql`. Make it re-runnable during development (or drop only your own objects before re-applying).
- Tests create their own fixtures with unique names (`tag()`) inside WS1/WS2; never delete rows you didn't create.
- Don't run `next build`/`next dev` (shared 2-CPU machine). Use `npx tsc --noEmit` (whole project; ignore errors in other modules' files) and targeted `npx vitest run src/modules/<m>`.

## Definition of done per module
1. Migration(s) applied locally; RLS via `make_business_table`.
2. Service layer in `src/modules/<m>/` with unit tests for every acceptance test in spec Part III "Evaluation and acceptance tests" that your module owns.
3. Pages + API routes working in mock-AI mode; empty states explain what to do when there's no data (the DB starts empty).
4. `src/modules/<m>/README.md`: what's built, exported services, job types, routes, env vars, known gaps.
5. `npx tsc --noEmit` clean for your files; your vitest suite passes.
