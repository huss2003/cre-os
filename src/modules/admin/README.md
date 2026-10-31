# admin module

Search, entity pages (Company / Person / Building), tenant settings, platform (agency) onboarding, health,
kill switch, owner MFA, backups and retention. Spec: Part I §4, §6, §7, §14–§17; Part III screens/API/tests.

## Security fixes (docs/security-review.md)
- **H3 fixed** (`20261031001600_admin.sql`): `app.alias_matches` stays SECURITY DEFINER (so a colleague matches the
  aliases of a record *shared* with them), but every match now passes `app.alias_target_readable()` →
  `app.can_read()` on the **target** organisation/person/asset, plus the alias's own classification. Unknown entity
  types never match. Covered by `tests/security/rpc.test.ts` and `extra.test.ts`.
- **H1**: logical exports are written only under `<ws>/backups/<stamp>/` (core hardening makes that prefix admin-only
  in storage). Template uploads go to `<ws>/templates/`.
- **M1-compatible**: tenant owners edit name/timezone/currency only. AI budget and status are changed by platform
  admins (`updateTenantSettings`, `setTenantStatus`); `ai_paused` only via `app.set_ai_paused` (audited).

## System Supervisor (workflow 22, round 2) — migration `20261101000100_system_supervisor.sql`
- **Durable queue fix**: `claim_jobs` first sweeps expired leases (worker crashed / serverless timeout): attempts left ⇒
  re-queued with exponential back-off; attempts exhausted ⇒ `dead` (`last_error` "lease expired after N attempts").
  Previously such jobs were re-claimed forever. `complete_job`/`fail_job` record `started_at`/`finished_at`/`duration_ms`.
- **Latency/drift**: `mudar_app.job_latency_stats(ws)` (SECURITY INVOKER ⇒ job RLS) → p50/p95/max per job type (24 h)
  vs the previous 7 days' p95; `latencyDrift()` flags > 2x and > 1 s slower. `/admin` lists it plus the slowest runs.
- **Scheduler heartbeat**: every tick inserts `mudar.scheduler_run` (platform-level, service role + platform-admin read,
  last ~2000 rows) via `begin_scheduler_run` (returns the gap since the previous tick) and updates ran/failed/errors/ms.
  `scheduler_heartbeat()` gives tenants aggregates only. `/admin` shows a red banner when the last tick is > 15 min old
  (or the heartbeat could not be read — never shown as healthy). A gap > 15 min raises a `scheduler_gap` alert from the
  next tick that runs — at the latest the daily Vercel cron (`vercel.json`, 00:30 UTC) — so a stopped pg_cron is noticed.
- **Private owner alerts** (`supervisor.ts`, run inside every tick, 10 s cap): dead jobs, backup missed (no successful
  `logical_export` in 26 h), latest export failed/stuck, restore test failed, AI spend ≥ 80% / ≥ 100% of
  `monthly_ai_budget_inr`, connectors expired/revoked/error, cursor failing or stale > 26 h, scheduler gap.
  Failure queue = `mudar.supervisor_alert` (one open row per workspace/kind/subject; auto-resolved only for checks that
  actually ran). New alerts → `notify()` (outbox `urgent_alert` for critical, `brief_alert` for warnings) to every
  owner/admin, grouped per kind, deduped by alert ids; shown in Today's "Urgent (private alerts)" and on `/admin`.
  Titles are actionable and contain no error text/stack traces. Admins can acknowledge (stops notifications).
- **Pause background jobs** (separate from `ai_paused`): `mudar.job_pause` + `mudar_app.set_jobs_paused(ws|null, paused,
  reason)` — admin+ per workspace, platform admin for `null` (platform-wide). `claim_jobs` skips paused work except
  `admin.export` / `admin.restore_sample` (`job_pause_exempt`). Audited (`pause_jobs`/`resume_jobs`, platform pause in
  every tenant's audit log). UI on `/admin`; API `POST /api/v1/admin/jobs-pause {paused, reason?, scope?}`.
- **Real restore test**: `restoreSampleCheck` now restores up to 200 rows per non-empty table into a TEMP table
  `LIKE mudar.<t> INCLUDING DEFAULTS INCLUDING CONSTRAINTS` (`mudar_app.restore_sample_table`, service role), compares
  value by value (`restore_value_eq`: numbers by value, timestamps by instant), checks counts/duplicate ids, drops it.
  Findings in `backup_run.findings.restore`; insert/cast failures or changed values fail the check (⇒ alert); columns
  missing from the live schema are a hazard (warning). 8-way parallel, 30 s deadline (rest listed as skipped).

## Kill switch: `assertIngestionAllowed` (imports / integrations / intelligence MUST call it)
```ts
import { assertIngestionAllowed, IngestionPausedError } from "@/modules/admin/killswitch";
await assertIngestionAllowed(db, workspaceId); // throws IngestionPausedError('paused'|'suspended')
```
Call it before any external fetch (connector sync, import of a remote file, web research). Works with the
service-role client (filters by workspace id). The AI gateway already refuses with `AiUnavailableError('paused')`.
Internal records, tasks, approvals, backups and the deterministic brief keep working while paused.

## Exported services
| File | Exports |
|---|---|
| `search.ts` | `searchEntities(db, ws, params)`, `parseSearchQuery(urlParams)`, `entityHref(type,id)`, `SEARCH_TYPES` |
| `entities.ts` | `getCompany/getPerson/getBuilding(db, ws, id, asOf?)` (null ⇒ 404, incl. direct URLs), `listEntities`, `createEntity`, `saveEntity` (routine fields direct w/ row_version; material fields → `proposeChange`), `setArchived` (archive = proposal; restore = admin direct), `shareRecord/unshareRecord`, `memberDirectory`, `vacancyState` |
| `settings.ts` | `getSettings` (keys `size_rules`, `cohort_targets`, `brief_time` in `workspace_setting` — other modules read these), `saveGeneral`, `saveRules`, `getRetention/saveRetention`, `RETENTION_DEFAULTS` |
| `config.ts` | partners / templates / licensed sources / data lanes CRUD (`listConfig`, `createConfig`, `updateConfig`, `archiveConfig`), `verifyTemplatePath` |
| `members.ts` | `addMember` (service role, explicit owner/platform check; temp password or invite link shown once — nothing is emailed), `updateMember`, `removeMember` |
| `platform.ts` | `createTenant`, `setTenantStatus`, `updateTenantSettings`, `tenantUsage`, `listTenants` (all assert `platform_admin`) |
| `health.ts` | `getHealth` (+ alerts, scheduler, latency, slowest, pause), `spendSummary`, `backupStatus`, `latencySummary`, `latencyDrift`, `schedulerHeartbeat`, `acknowledgeAlert`, `retryJob`, `listAudit` |
| `killswitch.ts` | `setAiPaused`, `pauseState`, `assertIngestionAllowed`, `IngestionPausedError`, `setJobsPaused`, `jobsPauseState` |
| `backup.ts` | `exportWorkspace`, `restoreSampleCheck`, `restoreTableSample`, `summariseRestore`, `sampleRows`, `deleteExportFiles` (service role only) |
| `supervisor.ts` | `runSupervisor`, `evaluateWorkspace`, `reconcileAlerts`, `notifyPending`, pure rules (`deadJobCandidates`, `backupCandidates`, `budgetCandidates`, `connectorCandidates`, `gapCandidate`, `heartbeatState`), `SUPERVISOR` thresholds |
| `retention.ts` | `purgeWorkspace(admin, ws, {dryRun})` |
| `guard.ts` | `requireAdminPage/Api`, `requirePlatformPage/Api` (role + owner/platform AAL2) |

## Jobs (`jobs.ts`, service role, workspace filtered)
- `admin.export` nightly 01:30 local — every workspace table → `<ws>/backups/<stamp>/*.json(.enc)` + manifest; `backup_run` row (RPO 24 h).
- `admin.restore_sample` monthly 03:00 — re-reads latest export, checks counts/hashes, flags restore hazards (suppressions/revocations newer than the export, removed members).
- `admin.retention_purge` nightly 02:30 — only categories with an **admin-approved** policy; legal hold overrides; raw audio files and working transcripts of reviewed captures, stored research downloads (provenance rows kept); audit is append-only → report only.

## Routes
Pages: `/search`, `/companies`(+`/new`, `/[id]`, `/[id]/edit`), `/people`(…), `/buildings`(…), `/settings`,
`/settings/{members,partners,templates,sources,lanes,retention,security}`, `/admin` (health + kill switch + job retry),
`/admin/audit`, `/platform`, `/platform/[id]`, `/platform/security` (platform pages sit outside the tenant shell).
API: `GET /api/v1/search`, `GET /api/v1/admin/health`, `POST /api/v1/admin/pause` `{paused, reason?}`,
`POST /api/v1/admin/jobs-pause` `{paused, reason?, scope: workspace|platform}`, `POST /api/v1/admin/alerts/:id/ack`,
`POST /api/v1/admin/jobs/:id/retry` (mutations require `Idempotency-Key`). `/api/cron/tick` (CRON_SECRET) records the
heartbeat, runs schedulers + supervisor, drains jobs.

## Migration
`supabase/migrations/20261031001600_admin.sql` (re-runnable): `backup_run`, `retention_policy`, `tenant_invite`,
`app.alias_matches` + `app.alias_target_readable`, `app.search_entities` (SECURITY INVOKER), `app.set_ai_paused`,
`app.retry_job`, `app.member_directory`, service-only `app.user_id_by_email/workspace_tables/export_table`.

## Env
`OWNER_MFA_ENFORCE` (`true`/`false`; default: enforced in production), `APP_URL` (invite redirect),
`TOKEN_ENCRYPTION_KEY` (32-byte base64; exports are encrypted when set — set it in production).

## Tests
`npx vitest run src/modules/admin` — search isolation (colleague / other tenant / licensed_restricted / direct object
URL), identity ambiguity + as-of, kill switch → `AiUnavailableError('paused')`, platform-only tenant creation,
export/restore round trip, H3 alias RPC, retention purge, config records, archive-as-proposal, platform-only budget.
Round 2: `queue.db.test.ts` (dead-letter via fail_job, expired-lease loop → dead, retry_job reset, timing + latency
stats, workspace/platform pause, heartbeat + pruning — all in rolled-back transactions), `supervisor.test.ts` (rules),
`supervisor.db.test.ts` (alerts, dedupe, resolve, ack, getHealth), `restore.db.test.ts` (real restore, failure on an
unrestorable export, numeric-scale mismatch, full pass over every table < 40 s).

## Known gaps
- A job claimed late in a tick can still be killed by the 60 s serverless limit; it now retries (lease expiry) and
  dead-letters after `max_attempts`, but the runner does not yet reserve time per job type.
- Succeeded jobs are never pruned, so `job` grows; latency stats only read the last 8 days (indexed).
- Supervisor checks run every tick for every active/paused workspace (fine for tens of tenants; batch if it grows).
- Adding employment / contact methods / spaces / availability from entity pages is not built (they arrive via
  imports/captures); pages display them with fact status, verification and suppression.
- `restore_drill` (quarterly full restore into a scratch project) is logged manually; no automation.
- Production must also enable Supabase managed daily backups/PITR and replicate `<ws>/backups/` to a separate store.
- Deleting a workspace that has business rows fails (audit trigger fires during cascade) — platform offers suspend/archive, not delete.
