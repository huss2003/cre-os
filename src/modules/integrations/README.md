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
| `inbox.ts` | `ingestMessage`, `processMessage` (triage effects incl. links, commitments, contrary pause, thread refresh), `importEml`, `matchPersons` |
| `triage.ts` | `TriageSchema` (+ `commitments[]` {kind, who, what, due_text}, `contrary_info`), `mockTriage`, `detectContrary`, `enforceTriageSafety`, `looksLikeInjection` |
| `commitments.ts` | `resolveDueDate` (deterministic; ambiguous => null), `extractCommitmentsMock`, `commitmentKey`, `commitmentTaskTitle` |
| `links.ts` | `resolveLinks` / pure `decideLinks` (org via single current employment or unique sender domain; opportunity via stakeholder or the org's single open opp; ambiguous => `link_suggestions`, not linked), `ensureInteractionLink` |
| `threads.ts` | `refreshThreadSummary` (one `inbound_thread` per thread id; rebuilt only when `basis_hash` of message keys changes; failure keeps last summary, status `failed`), `mockThreadSummary` |
| `push.ts` | `handleGraphNotifications` (clientState hash check, lifecycle events), `handleGmailPush` (verification token), `ensureGraphSubscription`, `ensureGmailWatch`, `ensurePush`, `pushConfigured` |
| `travel.ts` | `haversineKm`, `estimateTravelMinutes` (haversine × 1.4 ÷ 20 km/h, ≥ 10 min, 5-min steps — always labelled an estimate) |
| `calendar.ts` | `upsertCalendarEvent`, `agenda`, `withPoints`, `findConflicts`, `findTravelConflicts`, `planRoutes`, `conflictAlerts`, `detectConflictsAndNotify`, `createPlannedVisit`, `updatePlannedVisit`, `checklistFor`, `setChecklistItem`, `saveVisitFeedback` (interaction + follow-up task), `draftInvite` |
| `sequences.ts` | templates (default, WhatsApp follow-up), caps, `proposeEnrollment`, `activateEnrollment` (refuses during negotiation), `pauseEnrollment(…, detail)`, `pauseForPerson`, `pauseForOrg`, `cancelEnrollment`, `negotiationFor`, `contrarySignalFor`, `onContrarySignal`, `onSequenceDraftSent`, `sequenceTick` |
| `touches.ts` | Account touch calendar, `checkCollision` (RPC `integrations_touch_collisions`), `evaluateCollisions` |
| `consent.ts` | `suppressContact`, `revokeConsent`, `correctContact`, `erasePerson` (tombstones survive erasure) |
| `alerts.ts` | `decideUrgentAlert` (opt-in categories, work hours, DND deferral, never backfill) |
| `drafts-view.ts`, `http.ts`, `client-api.ts` | Read helpers, `afterMarkedSent`, error mapping, browser POST with Idempotency-Key |
| `src/lib/services/drafts.ts` | `createDraft`, `updateDraft`, `approveDraft`, `openDraftForSend`, `markDraftSent`, `reconcileDraftSent`, `setDraftPaused`, `discardDraft`, `buildSendLink`, `draftHash`, suppression asserts |

Other modules may call `createDraft` (and the other exports of `src/lib/services/drafts.ts`), `suppressContact`, `checkCollision`,
`agenda`, and `onContrarySignal(db, ws, { subjectType: "person" | "organisation", subjectId, detail })` (pauses that target's
sequences with reason `contrary_info`; the hourly tick also detects contrary `signal_claim`s — `job_move`, `not_in_market`,
`lease_renewed`, … — recorded after enrolment).

## Jobs (`jobs.ts`)
`integrations.inbox_sync` (10 min), `integrations.calendar_sync` (15 min; then writes deduped conflict alerts),
`integrations.sent_reconcile` (30 min), all with `{account_id}`; `integrations.sequence_tick` (hourly);
`integrations.push_subscribe` `{account_id}` (every 6 h for live connectors when push is configured: create/renew Graph
subscriptions for inbox + calendar, Gmail `users.watch`); `integrations.calendar_conflicts` (after manual visit changes).
Dedupe keys use time buckets. A 429 re-enqueues after Retry-After.

## Push sync (workflow 04)
`POST /api/webhooks/microsoft` answers Graph's `validationToken` handshake and accepts change/lifecycle notifications only
when `clientState` matches the stored SHA-256 (`push_subscription.client_state_hash`). `POST /api/webhooks/google?token=…`
accepts Pub/Sub pushes only with `GMAIL_PUSH_VERIFICATION_TOKEN`. A notification never supplies content: it records a
`webhook_receipt` (unique per notification => duplicates are dropped) and enqueues the normal delta sync with a per-minute
coalescing dedupe key. Polling stays on as the fallback. Push is used only when `APP_URL` is https and credentials exist
(Gmail also needs `GMAIL_PUBSUB_TOPIC`, whose topic must grant `gmail-api-push@system.gserviceaccount.com` publish rights).
Google Calendar push (`events.watch`) is not implemented — Google calendars are polled.

## Routes and pages
- Pages: `/drafts` (channel tabs, Needs action/Sent/Discarded; **Inbox triage** tab with thread view — thread summary, key
  points, deadlines & commitments, evidence-backed org/opportunity links, ambiguous "possible links not made" — plus the
  per-message view and .eml import; **Sequences** tab — find one person, choose sequence (default or WhatsApp follow-up),
  opportunity, persona and a one-line value proposition, enrol; list live/finished enrollments with pause reason + detail;
  Activate / Pause / Resume / Cancel via server actions in `drafts/sequence-actions.ts`), `/calendar` (agenda, conflict
  alerts incl. tight travel, provisional routes with travel estimates, "Plan a visit" linked to a building, Confirm/Cancel
  for hand-planned visits, per-visit checklist with large tap targets, visit feedback from the start of the visit, invite
  drafts), `/settings/connections` (… plus push status per resource).
- API: `GET/POST /api/v1/drafts`, `GET/PATCH /api/v1/drafts/:id`, `POST /api/v1/drafts/:id/{approve,open,mark-sent,discard}`,
  `GET /api/v1/calendar` (items, conflicts, travelConflicts, routes), `POST /api/v1/calendar` (plan a visit),
  `PATCH /api/v1/calendar/:id` (confirm/cancel/reschedule a hand-planned visit), `POST /api/v1/calendar/:id/checklist`,
  `POST /api/v1/calendar/:id/feedback`, `POST /api/v1/calendar/invites`, `POST /api/webhooks/{microsoft,google}`,
  `GET /api/oauth/:provider/start`, `GET /api/oauth/:provider/callback`. Mutations require `Idempotency-Key`.

## Migrations
`20261031001400_integrations.sql` (tables; re-running it drops this module's tables) and
`20261031001410_integrations_draft_security.sql` (draft guard, definer functions, grants; re-runnable without data loss),
`20261101000500_integrations_round2.sql` (re-runnable, additive): `inbound_thread`, `push_subscription` (members read,
service role writes), `webhook_receipt` (service role only), `visit_checklist_item`; columns `inbound_message.{matched_org_ids,
matched_opportunity_ids, link_evidence, link_suggestions, commitments}` and `sequence_enrollment.pause_detail`.

## Env vars
`TOKEN_ENCRYPTION_KEY` (32-byte base64), `APP_URL`, `MICROSOFT_CLIENT_ID/SECRET`, optional `MICROSOFT_TENANT_ID`,
`MICROSOFT_ENABLE_SELECTED_FILES=1`, `GOOGLE_CLIENT_ID/SECRET`, and for Gmail push `GMAIL_PUBSUB_TOPIC`
(`projects/<p>/topics/<t>`) + `GMAIL_PUSH_VERIFICATION_TOKEN` (put it in the Pub/Sub push URL `?token=`). Without credentials, "Use mock data" creates a connector
with status `mock` and deterministic fixtures. See `docs/setup-oauth.md`.

## Tests
`npx vitest run src/modules/integrations tests/security/drafts.test.ts` (round 2: `round2.unit.test.ts`, `round2.db.test.ts`). Coverage: inbox replay and full re-sync,
Message-ID dedupe across manual import, backfill, prompt injection, opt-out suppression, approval invalidation and the
lifecycle event trail, suppression at open-to-send, sequence pause on reply, erasure tombstones, calendar
reschedule/cancel/replay, Sent Items reconciliation, token refresh round trip, revoked token -> `auth_failed`, OAuth state
single-use and user binding, kill switch, and DB-level forgery attempts.

## Known gaps
- `/api/webhooks/*` must be listed as public in `src/proxy.ts` (shared file) or unauthenticated provider calls get 401.
- Push handlers are tested with mocked payloads/fetch; never exercised against a real tenant / Pub/Sub topic. Google Calendar push not implemented.
- Live Graph/Gmail adapters are unit-shaped but not exercised against real tenants. Attachment download is not implemented (metadata only).
- Urgent and conflict alerts are written to `outbox`. Delivery (push/email to the owner) belongs to the notification worker.
- Travel times are a deterministic straight-line estimate (no traffic, no routing API). Coordinates come from the linked
  building, else the locality centroid; synced events without either get no travel check.
- Link suggestions are shown but cannot yet be accepted with one click (the user links via the entity pages).
- Mock commitment extraction is regex-based (English, simple phrasings); "next Friday"-style dates stay unresolved by design.
- Relationship caretaker and LinkedIn compliance checks rely on drafts being individual and sent manually. There is no LinkedIn automation by design.
