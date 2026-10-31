# CRE OS

**CRE OS is an evidence-linked operating workbench for commercial-real-estate advisers**, run by the agency as a
multi-tenant SaaS. Each tenant is one adviser's (or small team's) private workspace: their companies, people,
buildings, leases, requirements, deals, captures and drafts — every fact linked to its source and labelled
*confirmed / reported / historical / AI inference / unknown*.

What it does for the adviser, every day:

- **08:00 brief** — top actions, overdue promises, meetings, lease notice dates, hot replies, pending approvals.
- **Capture** after calls in English/Hindi/Hinglish (voice, text, photo) → tasks, interactions, proposed changes.
- **Approvals** — material changes never apply silently; every change can be undone.
- **Requirements → shortlist → financials → editable deck**, with deterministic finance maths.
- **Lease radar, research dossiers, network/intro paths, legal clause comparison, content queue.**
- **Drafts only** — CRE OS never sends a message; the adviser sends from their own app and marks it sent.

Agency staff are **platform admins** who onboard tenants manually (no self-serve signup, no billing in v1). The first
tenant is a Pune occupier-services manager; anything tenant-specific (partners, templates, licensed data sources,
data-processing lanes) is per-tenant configuration.

Product spec: [`docs/spec.txt`](docs/spec.txt). Engineering contract for contributors: [`AGENTS.md`](AGENTS.md).

---

## Documentation

| Doc | Reader | What |
|---|---|---|
| [docs/operator-guide.md](docs/operator-guide.md) | Adviser (non-technical) | Daily use: Today, Capture, Approvals, Drafts, deals, lease radar, research, labels, evening debrief |
| [docs/admin-runbook.md](docs/admin-runbook.md) | Agency / tenant admin | Onboarding, members & roles, kill switch, AI budget, reconnects, failed jobs, backups & restore, incidents, retention, deletion, admin recovery |
| [docs/deploy.md](docs/deploy.md) | Agency owner + developer | Supabase cloud (Mumbai) + Vercel (bom1) step by step, cron, domain, rollback, go-live checklist |
| [docs/security-model.md](docs/security-model.md) | Developer / security reviewer | Threat & access model: tenancy, RLS helpers, classifications, service-role rules, approval hashing, no-send, prompt injection, token encryption, scopes, DPDP note, known gaps |
| [docs/costs.md](docs/costs.md) | Agency owner | Monthly cost model, per-tenant marginal cost, pricing worksheet |
| [docs/launch-dependencies.md](docs/launch-dependencies.md) | Agency owner | Launch dependency register (platform + per tenant) with fallbacks |
| [docs/traceability.md](docs/traceability.md) | Everyone | Spec's 72 requirements → module/route/table, with build status |
| [docs/setup-oauth.md](docs/setup-oauth.md) | Developer | Microsoft Entra & Google OAuth app setup (integrations module) |
| [docs/demo-data.md](docs/demo-data.md) | Developer / sales | Opt-in synthetic `demo-pune` workspace for demos and UI testing (local only) |

---

## Architecture

```mermaid
flowchart LR
  subgraph Users["Users (phone / laptop)"]
    ADV["Adviser & colleagues"]
    PA["Agency platform admin"]
  end

  subgraph Vercel["Vercel — region bom1 (Mumbai)"]
    PROXY["src/proxy.ts<br/>session check"]
    APP["Next.js 16 App Router<br/>Server Components + Server Actions<br/>/api/v1/* routes"]
    CRON["/api/cron/tick<br/>(Vercel Cron every 5 min,<br/>Bearer CRON_SECRET)"]
    RUNNER["Job runner<br/>schedulers + handlers<br/>src/lib/jobs"]
    GW["AI gateway<br/>src/lib/ai/gateway.ts<br/>budget · kill switch · mock mode"]
  end

  subgraph Supabase["Supabase — ap-south-1 (Mumbai)"]
    AUTH["Auth<br/>email+password, TOTP MFA"]
    PG[("Postgres<br/>RLS on every business table<br/>app.* helpers, job queue,<br/>audit_event")]
    ST[("Storage<br/>workspace-files/&lt;ws&gt;/…<br/>originals, audio, outputs,<br/>nightly exports")]
  end

  subgraph External["External processors"]
    OAI["OpenAI API<br/>gpt-6-luna · gpt-6.1-sol<br/>transcribe · web search"]
    MS["Microsoft Graph<br/>(read-only, delegated)"]
    GG["Google Gmail/Calendar<br/>(read-only)"]
  end

  ADV -->|HTTPS| PROXY --> APP
  PA -->|/platform| PROXY
  APP -->|user JWT, RLS enforced| PG
  APP --> AUTH
  APP --> ST
  CRON --> RUNNER
  RUNNER -->|service role, explicit workspace_id| PG
  RUNNER --> ST
  APP --> GW
  RUNNER --> GW
  GW --> OAI
  RUNNER -->|encrypted OAuth tokens| MS
  RUNNER --> GG
  APP -.->|"drafts only — user sends from own mail/WhatsApp/LinkedIn"| ADV
```

Key design rules (full list in [AGENTS.md](AGENTS.md)): RLS everywhere (S1); service role only in jobs/webhooks/platform
admin with explicit `workspace_id` filters (S2); **no outbound send** (S3); material changes via
`proposeChange()` + approval (S4); no LLM arithmetic (S5); unknown stays unknown (S6); untrusted content is evidence
(S7); idempotent mutations and jobs (S8); mobile-first (S9); visible failure (S10).

### Repository layout

```
src/
  app/                 Next.js routes. (app)/ = authenticated shell; api/cron/tick = scheduler; api/v1/* = JSON API
  proxy.ts             Next 16 middleware replacement: redirects signed-out users to /login
  lib/
    ai/                gateway.ts (only way to call OpenAI), pricing.ts (rates + PRICING_VERSION)
    auth/context.ts    requireContext()/requirePageContext(): user, workspace, role, classifications
    jobs/              queue.ts (enqueue/claim), registry.ts (module handlers), runner.ts (tick)
    services/          changes.ts (proposeChange + risk), drafts.ts (draft lifecycle), tasks.ts
    supabase/          server (user, RLS) / admin (service role) / browser clients
    util/              crypto (AES-GCM, stable hash), http (route wrapper, idempotency), time (IST helpers)
  modules/<name>/      Feature modules — services, jobs.ts, README.md
  components/ui/       Shared UI primitives
supabase/
  migrations/          2026103100{0100,0200,0300}_core_* then one file per module (001000–001699)
  seed.sql             LOCAL ONLY: 3 users, 2 empty tenants
  config.toml          LOCAL ONLY Supabase config
scripts/               worker.ts (local scheduler loop), smoke.mjs (Playwright route smoke test)
tests/                 helpers.ts (seeded users, WS1/WS2), rls.test.ts
docs/                  spec + handover docs
```

## Modules

Each module owns its code under `src/modules/<name>/`, its routes, its migration and its README (services it exports,
job types, routes, env vars, known gaps).

| Module | What it covers | Routes | Migration | README |
|---|---|---|---|---|
| **imports** | File intake (xlsx/csv), adapters, hashing, staging, reconciliation, quarantine, identity candidates, lease-event derivation | `/imports`, `/api/v1/imports/**` | `20261031001000_imports.sql` | [src/modules/imports/README.md](src/modules/imports/README.md) |
| **capture** (+ changes) | Voice/text/photo capture, transcription, extraction, ambiguity questions, change proposals, approvals, apply/reverse | `/capture`, `/approvals`, `/api/v1/captures/**`, `/api/v1/changes/**` | `20261031001100_changes_apply_reverse.sql` | [src/modules/capture/README.md](src/modules/capture/README.md) |
| **brief** | 08:00 brief, pre-meeting briefs, health check & fallback, lead scoring, priority/daily plan, lease radar, tasks, urgent alerts | `/today`, `/tasks`, `/leases`, `/api/v1/briefs/**`, `/api/v1/tasks/**` | `20261031001200_brief.sql` | [src/modules/brief/README.md](src/modules/brief/README.md) |
| **deals** | Requirements, opportunities/pipeline, property matching & shortlist, finance engine (TCO/NPV), documents, quotes, fees, CRM export | `/requirements`, `/deals`, `/finance`, `/documents`, `/fees`, `/api/v1/requirements/**`, `/api/v1/finance/**`, `/api/v1/documents/**`, `/api/v1/opportunities/**` | `20261031001300_deals.sql` | [src/modules/deals/README.md](src/modules/deals/README.md) |
| **integrations** | Microsoft 365 & Google read-only connectors, inbox triage, calendar & visits, drafts & manual send, outreach sequences, touch calendar, suppression | `/drafts`, `/calendar`, `/settings/connections`, `/api/v1/drafts/**`, `/api/v1/calendar/**`, `/api/oauth/**` | `20261031001400_integrations.sql` | [src/modules/integrations/README.md](src/modules/integrations/README.md) |
| **intelligence** | Research dossiers & evidence patrol, network/intro paths, market, legal desk, content queue, insights/experiments | `/research`, `/network`, `/market`, `/legal`, `/content`, `/insights`, `/api/v1/research/**` | `20261031001500_intelligence.sql` | [src/modules/intelligence/README.md](src/modules/intelligence/README.md) |
| **admin** | Search, company/person/building pages, settings, members, retention, health, kill switch, backups, platform (tenants) | `/search`, `/companies`, `/people`, `/buildings`, `/settings/**`, `/admin/**`, `/platform/**`, `/api/v1/search`, `/api/v1/admin/**` | `20261031001600_admin.sql` | [src/modules/admin/README.md](src/modules/admin/README.md) |

## API conventions

- All JSON endpoints are under `/api/v1/*` and use the signed-in user's session cookie (RLS applies). Wrapped by
  `route()` in `src/lib/util/http.ts`.
- **Mutations require an `Idempotency-Key` header** (S8); replays return the original result instead of duplicating.
- Every response carries `x-request-id` (send your own to correlate logs).
- Errors: `{ "error": "<message>", "details"?: …, "requestId": "…" }` with 400 (validation — zod issues in
  `details`), 401, 403, 404, 409 (row-version conflict), 500.
- Optimistic concurrency: updates send the `row_version` they read; a mismatch is 409.
- Endpoint contracts from the spec (Part III "Interfaces"), each owned by a module above:
  `POST /v1/captures`, `GET /v1/captures/{id}/review`, `POST /v1/imports`, `GET /v1/imports/{id}/reconciliation`,
  `GET /v1/search`, `POST /v1/changes`, `POST /v1/changes/{id}/approve|apply|reverse`, `POST /v1/drafts`,
  `POST /v1/drafts/{id}/approve|mark-sent`, `GET /v1/briefs/today`, `POST /v1/requirements/{id}/shortlist`,
  `POST /v1/finance/evaluate`, `POST /v1/documents/generate`, `GET /v1/admin/health`, `POST /v1/admin/pause`.
  Exact request/response shapes are documented in each module README.
- Non-versioned system routes: `GET /api/health` (liveness, public), `GET|POST /api/cron/tick` (Bearer `CRON_SECRET`),
  `/api/oauth/{provider}/start|callback`, `/auth/callback`, `/auth/signout`.

---

## Local development

Prerequisites: Node 22+, Docker (for the local Supabase stack), ~4 GB free RAM.

```bash
npm i
cp .env.example .env.local          # then fill in from the next step

npm run db:start                    # starts local Supabase (API :54321, DB :54322, mail :54324)
                                    # prints the Publishable key and Secret key → paste into .env.local

npm run db:reset                    # DESTRUCTIVE: recreates the local DB, runs all migrations + supabase/seed.sql
npm run dev                         # http://localhost:3000
npm run worker                      # second terminal: calls /api/cron/tick every 60 s (scheduler + job queue)
```

Minimal `.env.local` for local work (everything else can stay empty → mock mode):

```dotenv
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...   # from db:start output
SUPABASE_SECRET_KEY=sb_secret_...                          # from db:start output
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
CRON_SECRET=local-dev-secret
TOKEN_ENCRYPTION_KEY=...                                   # openssl rand -base64 32
APP_URL=http://localhost:3000
```

### Seeded logins (local only — `supabase/seed.sql`, never push to production)

| Email | Password | Role |
|---|---|---|
| `owner@cre-os.local` | `password123` | Platform admin + owner of *Tenant One (Pune occupier services)*; all classifications; sees all accounts |
| `colleague@cre-os.local` | `password123` | Editor in Tenant One; no `licensed_restricted`; sees only assigned/shared accounts |
| `other@cre-os.local` | `password123` | Owner of *Tenant Two* (for cross-tenant isolation tests) |

The database starts with **no business data**. Import files at `/imports` or create records by hand; every empty screen
explains what to do. For a populated synthetic workspace, see [docs/demo-data.md](docs/demo-data.md).

### Mock mode

- `OPENAI_API_KEY` empty → every AI call returns a deterministic mock (logged in `model_usage` as `mock:<model>`), so all
  flows work end to end without a key.
- `MICROSOFT_*` / `GOOGLE_*` empty → connectors run against built-in mock fixtures (status `mock`).

### Tests and checks

```bash
npm test                            # vitest: all src/**/*.test.ts and tests/**/*.test.ts (needs local Supabase + seed)
npx vitest run tests/rls.test.ts    # tenancy / RLS isolation
npx vitest run src/modules/deals    # one module
npm run typecheck                   # tsc --noEmit
npm run lint
node scripts/smoke.mjs              # with `npm run dev` running: logs in as owner, visits every nav route at 390px and 1366px
                                    # (needs Playwright: npm i -D playwright && npx playwright install chromium)
```

Tests create their own uniquely-tagged fixtures inside the seeded tenants and never delete rows they didn't create.

### Adding a migration

```bash
npx supabase migration new <module>_<what>     # keep inside your module's timestamp range (see AGENTS.md)
# every business table: create table ...; select app.make_business_table('<table>');
npm run db:reset                                # re-run everything locally
```

Never edit a migration that has been pushed to a cloud project — add a new one (forward-fix; see
[docs/deploy.md](docs/deploy.md#11-rollback)).

---

## Environment variables

| Variable | Required | Used by | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | everything | Supabase API URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | browser + server | Publishable (anon) key; safe to expose |
| `SUPABASE_SECRET_KEY` | yes | jobs, platform admin, AI usage logging | **Service role — bypasses RLS.** Server only |
| `DATABASE_URL` | local tooling | psql, tests | Not needed on Vercel |
| `CRON_SECRET` | yes | `/api/cron/tick`, `scripts/worker.ts` | Bearer token; Vercel Cron sends it automatically |
| `TOKEN_ENCRYPTION_KEY` | yes | OAuth token storage, encrypted backup exports | 32 bytes base64 (`openssl rand -base64 32`). **Escrow it** |
| `APP_URL` | yes | OAuth redirect URIs, invite links, worker | No trailing slash |
| `OPENAI_API_KEY` | no | AI gateway | Empty = mock mode |
| `OPENAI_MODEL_LUNA` / `OPENAI_MODEL_SOL` / `OPENAI_MODEL_TRANSCRIBE` | no | AI gateway | Override model pins (defaults `gpt-6-luna`, `gpt-6.1-sol`, `gpt-4o-mini-transcribe`) |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | no | Outlook/Calendar connector | Empty = mock connector |
| `MICROSOFT_TENANT_ID` | no | Microsoft auth endpoints | Default `common` |
| `MICROSOFT_ENABLE_SELECTED_FILES` | no | Microsoft scopes | `1` adds `Files.SelectedOperations.Selected` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | Gmail/Google Calendar connector | Empty = mock connector |
| `OWNER_MFA_ENFORCE` | no | admin MFA guard | `true`/`false`; default enforced when `NODE_ENV=production` |

## Deployment

Supabase cloud (Mumbai `ap-south-1`) + Vercel (region `bom1`, cron every 5 minutes → requires **Vercel Pro**), from
GitHub `huss2003/cre-os`. Step-by-step: [docs/deploy.md](docs/deploy.md). Costs: [docs/costs.md](docs/costs.md).
