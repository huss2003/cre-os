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
| `health.ts` | `getHealth`, `spendSummary`, `backupStatus`, `retryJob`, `listAudit` |
| `killswitch.ts` | `setAiPaused`, `pauseState`, `assertIngestionAllowed`, `IngestionPausedError` |
| `backup.ts` | `exportWorkspace`, `restoreSampleCheck`, `deleteExportFiles` (service role only) |
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
`POST /api/v1/admin/jobs/:id/retry` (mutations require `Idempotency-Key`).

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

## Known gaps
- Adding employment / contact methods / spaces / availability from entity pages is not built (they arrive via
  imports/captures); pages display them with fact status, verification and suppression.
- `restore_drill` (quarterly full restore into a scratch project) is logged manually; no automation.
- Production must also enable Supabase managed daily backups/PITR and replicate `<ws>/backups/` to a separate store.
- Deleting a workspace that has business rows fails (audit trigger fires during cascade) — platform offers suspend/archive, not delete.
