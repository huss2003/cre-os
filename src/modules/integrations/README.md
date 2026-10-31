# integrations module

Microsoft 365 + Google **read-only** connectors, inbox triage, calendar & visits, the draft queue (manual send),
outreach sequences, account touch calendar and consent & rights operations. Spec: Part I §5, §7, §8, §9, §14; Part III
integration contracts.

## Rules this module enforces
- **No outbound send (S3).** Scopes are `User.Read offline_access Mail.Read Calendars.Read` (+ optional
  `Files.SelectedOperations.Selected`) and Gmail/Calendar `*.readonly`. `FORBIDDEN_SCOPES` is checked before any auth URL.
  "Send" = Open to send (mailto:/wa.me/LinkedIn link + copy) -> user sends -> **Mark sent** (user assertion) -> Sent Items
  reconciliation (`reconciled_sent`).
- **Approval binds to content (M2 fix, migration `001410`).** `content_hash` is computed in SQL
  (`app.draft_content_hash`, byte-identical with `draftHash()` in `src/lib/services/drafts.ts`). `approved`,
  `opened_for_send`, `marked_sent` are reachable only via SECURITY DEFINER `app.approve_draft`, `app.open_draft_for_send`,
  `app.mark_draft_sent` (editor role, hash, approval row, suppression). Column grants stop `authenticated` writing
  `approved_*`, `marked_sent_*`, `sent_evidence` or `channel`. Draft `approval` rows can only be created by `approve_draft`.
  Any content change, pause or discard drops the approval. `reconciled_sent` is service-role (job) only.
- **Untrusted email (S7).** Bodies are sanitised to plain text (`sanitize.ts`), passed as gateway `evidence`, and triage
  only proposes. Effects are decided in code. Injection is detected heuristically and overrides the model.
- **Idempotent.** One `inbound_message` per (provider, id) and per Message-ID across sync/backfill/manual import. Dedupe keys
  for interaction (`source_message_id`), task (`integrations.triage:<key>`), reply draft (`reply:<hash>`), touches and alerts.
  Backfill (> 48 h old) is logged only: no task, draft, alert or sequence change. Opt-outs are honoured anyway.
- **Kill switch.** `assertIngestionAllowed` runs first in every sync. **Visible failure (S10):** `connector_cursor` keeps
  `last_success_at/last_error`, and auth failures set `connector_account.status` to `expired|revoked`. Pages show `StaleBanner`.

## Files
| File | Exports |
|---|---|
| `types.ts`, `config.ts` | Provider-neutral shapes, scopes, cadence, stale thresholds |
| `providers/{microsoft,google,mock,http}.ts` | `ProviderAdapter` (messages delta, get, sent items, events delta/cancellations); 429 Retry-After; 410/404 => `CursorExpiredError` |
| `tokens.ts` | `sealTokens/openTokens` (AES-GCM), `exchangeCode`, `refreshTokens`, `getValidAccessToken` (refresh, revoked/expired detection) |
| `oauth.ts` | `startOAuth` (PKCE S256, hashed single-use state bound to user+ws, 10 min), `completeOAuth`, `connectMock`, `disconnect` |
| `sync.ts` | `syncResource(admin, account, "inbox"\|"calendar"\|"sent")`, `reconcileSentMessage`, `matchSentToDraft`, `staleness` |
| `inbox.ts` | `ingestMessage`, `processMessage` (triage effects), `importEml` (manual selected-thread import), `matchPersons` |
| `triage.ts` | `TriageSchema`, `mockTriage` (deterministic), `enforceTriageSafety`, `looksLikeInjection` |
| `calendar.ts` | `upsertCalendarEvent` (external id, version_key, reschedule/cancel), `agenda`, `findConflicts`, `clusterByLocality`, `saveVisitFeedback`, `draftInvite` |
| `sequences.ts` | 3-touch/21-day default, caps, `proposeEnrollment` (collision check), `pauseEnrollment`, `pauseForPerson`, `onSequenceDraftSent`, `sequenceTick` |
| `touches.ts` | Account touch calendar, `checkCollision` (RPC `integrations_touch_collisions`), `evaluateCollisions` |
| `consent.ts` | `suppressContact`, `revokeConsent`, `correctContact`, `erasePerson` (tombstones survive erasure) |
| `alerts.ts` | `decideUrgentAlert` (opt-in categories, work hours, DND deferral, never backfill) |
| `drafts-view.ts`, `http.ts`, `client-api.ts` | Read helpers, `afterMarkedSent`, error mapping, browser POST with Idempotency-Key |
| `src/lib/services/drafts.ts` | `createDraft`, `updateDraft`, `approveDraft`, `openDraftForSend`, `markDraftSent`, `reconcileDraftSent`, `setDraftPaused`, `discardDraft`, `buildSendLink`, `draftHash`, suppression asserts |

Other modules may call `createDraft` (and the other exports of `src/lib/services/drafts.ts`), `suppressContact`, `checkCollision`
and `agenda`.

## Jobs (`jobs.ts`)
`integrations.inbox_sync` (10 min), `integrations.calendar_sync` (15 min), `integrations.sent_reconcile` (30 min), all with
`{account_id}`; `integrations.sequence_tick` (hourly). Dedupe keys use time buckets. A 429 re-enqueues after Retry-After.

## Routes and pages
- Pages: `/drafts` (channel tabs, Needs action/Sent/Discarded, Inbox triage tab with .eml import), `/calendar`
  (agenda, conflicts, locality clusters, visit feedback, invite drafts), `/settings/connections` (connect/reconnect/disconnect,
  mock clearly labelled, scopes, last sync per resource, errors, Sync now, urgent-alert opt-in + DND).
- API: `GET/POST /api/v1/drafts`, `GET/PATCH /api/v1/drafts/:id`, `POST /api/v1/drafts/:id/{approve,open,mark-sent,discard}`,
  `GET /api/v1/calendar`, `POST /api/v1/calendar/:id/feedback`, `POST /api/v1/calendar/invites`,
  `GET /api/oauth/:provider/start`, `GET /api/oauth/:provider/callback`. Mutations require `Idempotency-Key`.

## Migrations
`20261031001400_integrations.sql` (tables; re-running it drops this module's tables) and
`20261031001410_integrations_draft_security.sql` (draft guard, definer functions, grants; re-runnable without data loss).

## Env vars
`TOKEN_ENCRYPTION_KEY` (32-byte base64), `APP_URL`, `MICROSOFT_CLIENT_ID/SECRET`, optional `MICROSOFT_TENANT_ID`,
`MICROSOFT_ENABLE_SELECTED_FILES=1`, and `GOOGLE_CLIENT_ID/SECRET`. Without credentials, "Use mock data" creates a connector
with status `mock` and deterministic fixtures. See `docs/setup-oauth.md`.

## Tests
`npx vitest run src/modules/integrations tests/security/drafts.test.ts`. Coverage: inbox replay and full re-sync,
Message-ID dedupe across manual import, backfill, prompt injection, opt-out suppression, approval invalidation and the
lifecycle event trail, suppression at open-to-send, sequence pause on reply, erasure tombstones, calendar
reschedule/cancel/replay, Sent Items reconciliation, token refresh round trip, revoked token -> `auth_failed`, OAuth state
single-use and user binding, kill switch, and DB-level forgery attempts.

## Known gaps
- No push webhooks (Graph subscriptions / Gmail watch). Polling every 10–15 min only.
- Live Graph/Gmail adapters are unit-shaped but not exercised against real tenants. Attachment download is not implemented (metadata only).
- Urgent alerts are written to `outbox`. Delivery (push/email to the owner) belongs to the notification worker.
- Route clustering is locality-based. It does not use travel times.
- Relationship caretaker and LinkedIn compliance checks rely on drafts being individual and sent manually. There is no LinkedIn automation by design.
