# Module 9 — Orchestrator core (engine, events, reassessment)

Coordination layer only: it decides *when* and *in what order* existing module services run; it owns no business
data. Contract for other agents/UI: `docs/orchestrator/CONTRACT.md`. Gap analysis: `docs/orchestrator/GAP.md`.
Scheduling / daily plan / weekly review / notifications / capacity / budgets live in sibling folders
(`schedule/ notify/ capacity/ budget/`, built separately).

## What's built
- **Engine** (`engine/`): code-registered `WorkflowDefinition`s (trigger, steps with `dependsOn`, conditions, module,
  retry, timeout, consequential flag, priority, permissions/approvals metadata); per-workspace state in
  `workflow_definition` (status draft/active/paused, priority, schedule, versions in `workflow_definition_version`).
  Executions reuse `workflow_run` (`kind='orchestrated'`) + `workflow_step`. `advanceExecution` runs dependency waves,
  independent steps in parallel, each done step exactly once; temporary errors → exponential backoff
  (`next_attempt_at`), permanent errors stop dependants, exhausted retries → `dead` (dead letter). Consequential steps
  are never auto-retried. Status derivation: completed / partially_completed / failed / waiting_* / queued.
  Controls: pause, resume, cancel, retry (failed steps only), change priority; recurring workflows via
  `startDueScheduled` (one execution per slot; paused definitions start nothing). Timeouts per step and per execution.
  `workflow_audit_log` holds the execution history; `getExecution` returns the §11.3 failure report.
- **Events** (`events/`): transactional outbox `event_outbox` (unique dedupe, `duplicate_count`) written by DB triggers in
  the same transaction as the business write, plus `publishEvent()` for modules. `processEvents` delivers to consumers
  with an idempotent inbox (`event_processing_log`, unique event × consumer; failed consumers re-claimable, 5 attempts).
  Events already covered by existing processes are routed, not re-implemented (signal → workflows.signal_chain,
  meeting completed → meeting_chain, scheduled/rescheduled → meetings autobrief/remind).
- **Reassessment** (`reassess/`): workflows `reassess.quote`, `reassess.requirement`, `reassess.meeting_cancelled`,
  `reassess.employment`, `reassess.integration_failed`, `reassess.integration_recovered` (spec §7 ex. 1–5).
  Recalculation goes through toolkit `runComparison` (new immutable `deal_analysis_version`; old versions kept) and
  scoring `recalcOrg`. Approved analyses and approved/released documents are never overwritten → `outdated_warning`.
  Everything else is flagged in `reassessment_mark` (`needs_refresh`/`stale`/`review`). `integration_health` tracks
  last success, consecutive failures, next retry.

## DB triggers → events
| Table | Event |
|---|---|
| meeting_visit insert / status / start_at | `meeting.scheduled`, `meeting.cancelled`, `meeting.completed`, `meeting.rescheduled` |
| quote insert | `commercial.quote_received` |
| requirement update (area, seats, budget, geography, occupation date, constraints) | `commercial.requirement_changed` (payload: old/new values) |
| employment insert (person has another employer) | `contact.employment_changed` |
| signal_claim insert | `research.signal_detected` |
| connector_account status | `integration.failed` / `integration.recovered` |

## Exported services
See `index.ts` / CONTRACT.md: `registerWorkflow, listWorkflows, getWorkflow, setWorkflowStatus, editSchedule,
changeWorkflowPriority, startExecution, advanceExecution, runWorkflow, listExecutions, getExecution, pauseExecution,
resumeExecution, cancelExecution, retryExecution, changePriority, affectedRecords, exportLog, startDueScheduled,
publishEvent, processEvents, registerConsumer, markEntity, listMarks, resolveMark, isStale, recordIntegrationFailure,
recordIntegrationSuccess, listIntegrationHealth, notifyUser, TemporaryError, PermanentError, classifyError`.

## Jobs
`orchestrator.dispatch` (`jobs.ts`, registered in `src/lib/jobs/registry.ts`): every tick per active workspace, dedupe
per 5-min bucket; events → due recurring workflows → runnable executions (priority order) → timeouts. Service-role
client with explicit `workspace_id` filters (S2).

## Migration
`supabase/migrations/20261111001700_orchestrator_core.sql` (re-runnable; mudar/mudar_app only).

## Tests
`npx vitest run src/modules/orchestrator` — `plan.test.ts` (pure), `engine.db.test.ts` (§18 tests 6, 10, 11, 12 +
execution pause/cancel), `reassess.db.test.ts` (tests 3, 4, 5, 8 + source outage).

## UI (`ui/`)
- **Pages**: `/automation` (tabs: Overview · Daily plan · Weekly review · Budgets & usage · Notifications; overview = needs
  attention, running, start a job, scheduled + next runs, all workflows, recently finished, connections health, usage,
  capacity warnings). `/orchestrator/schedule` redirects here. `/automation/[workflowId]` (key; purpose, trigger in
  plain words, steps + dependencies, last/next run, controls: run now, pause/resume run, cancel (admin), retry last failed,
  pause workflow / schedule / priority (admin), recent runs + export log, affected records, change history).
  `/automation/runs/[runId]` (progress, steps, §11.3 "What went wrong", retry/pause/resume/cancel, flags, history, export).
  `/approvals/outdated` ("Outdated proposals" tab in Review nav: open `reassessment_mark` rows with Refresh/Dismiss).
  Nav: one entry "Automation" (More; tabs Automation + Chains `/workflows`).
- **Elsewhere**: Today card `AutomationAttentionCard` (failed/stuck/waiting runs, broken connections, outdated outputs);
  `ReassessBanner` on toolkit analysis pages (compare/renewal/managed/fitout/financing/negotiation/investment/bts `[id]`),
  each generated deliverable, and the requirement page — Refresh runs workflow `assist.refresh_record`
  (comparison → `runComparison` new version; requirement → `recalcOrg`; approved outputs never overwritten; mark resolved
  only when refreshed). Notification bell in the app shell (`ui/bell.tsx`, notify `listInbox`/`actOnNotification`).
- **User workflows** (`ui/workflows.ts`): `assist.prepare_meetings` (day's meetings → `generateBrief` for preps without a
  brief → open tasks due by that day) and `assist.refresh_record`.
- **Service** (`ui/service.ts`): `loadDashboard, loadAttention, listExceptions, marksFor, loadWorkflow, loadRun,
  workflowControl, runControl, markControl, startWorkflow, startableWorkflows, workflowForRequest, dateForRequest`.
  Roles: workflow pause/resume/schedule/priority + run cancel/priority = admin; start (per definition role, default
  editor), run pause/resume/retry, refresh/dismiss = editor. Server actions in `ui/actions.ts`.
- **Routes** (`/api/v1/orchestrator`): `GET /` dashboard · `GET|POST workflows/:key` · `GET runs` · `GET|POST runs/:id` ·
  `GET runs/:id/log` · `POST marks/:id` · `POST start` ({request|workflowKey, date}). Mutations require Idempotency-Key.
- **Assistant (Module 12)**: `assistant/tools/orchestrator.ts` — `start_workflow` (B), `list_workflow_runs`,
  `get_workflow_run`, `list_pending_approvals` (A), `pause_workflow_run` (B), `cancel_workflow_run` (C, admin). Group
  `automation` in `select.ts`; intent `automation` in `engine/router.ts` + mock plan.
- meeting.scheduled/rescheduled/cancelled also run consumer `prep_schedule` → `scheduleMeetingPreps(admin, ws, {prepId})`.
- Tests: `ui/ui.db.test.ts`.

## Routes / env
See UI above. No env vars.

## Known gaps
- Steps run inline in the dispatcher (time-boxed); very long steps should enqueue their own module job and return
  `waiting_dependency`-style results — no step uses that yet.
- Meeting-cancel cancels queued jobs only when their payload carries `prepId|prep_id|meetingId|meeting_id`; with a user
  client the job update is a no-op (RLS) — the dispatcher uses the service role.
- Non-comparison analyses (lease economics, occupancy, …) are flagged `needs_refresh`, not recalculated (their inputs are user-entered).
- "Requirement readiness" = scoring `requirement` model via `recalcOrg`; toolkit brief snapshots are flagged, not re-saved.
- Event history: processed events are kept; no retention job yet.
- Reassessment banners are not yet on `/documents` (document_version marks show only in Review → Outdated proposals).

## Scheduling, notifications, capacity, budgets (`schedule/`, `notify/`, `capacity/`, `budget/`)
Spec §4, §8, §9, §12 (phases 2 and 5). Gap analysis: `docs/orchestrator/SCHEDULE-GAP.md`. Migration
`supabase/migrations/20261111001710_orchestrator_schedule.sql` (re-runnable): `notification_state`, `orch_plan`,
`task_schedule`, `resource_budget`, `resource_usage`. Reuses `outbox`, `task`, `brief`, `model_usage`, `user_preference`.

**Settings** (`schedule/settings.ts`): brief settings (brief time, weekly slot, workdays, DND, working hours) +
`workspace_setting.orchestrator` + `user_preference.prefs.orchestrator` `{ timezone, dailyPlanTime, weeklyReview, prepLeadMinutes,
quietHours, workingHours, notifications:{muted, urgentCategories, groupWindowMinutes}, capacity:{maxMeetings, …} }`. Default tz Asia/Kolkata.

**Jobs** (`schedule/jobs.ts`, registered in `src/lib/jobs/registry.ts` as `orchestratorSchedule`):
`orchestrator.daily_plan` (user's 08:00, key ws:user:local date) · `orchestrator.plan_ai` (retry of a delayed AI headline) ·
`orchestrator.weekly_review` (configured weekday/time, key ISO week) · `orchestrator.sweep` (15 min: prep (re)scheduling, completed-meeting
detection, obsolete notifications) · `orchestrator.hourly` (Workflow F + budget alerts) · `orchestrator.meeting_prep` (key prep:start, ~1 h before) ·
`orchestrator.post_meeting` (once per completed meeting). Existing keys in any state are never re-created.

**Exported services**
- `runDailyPlan(admin, ws, user, {now, ai})`, `retryPlanAi`, `savePlan` — `schedule/daily-plan.ts`; `runWeeklyReview` — `schedule/weekly.ts`
- `scheduleMeetingPreps(admin, ws, {prepId?})` (call on meeting create/update/cancel events), `runMeetingPrep`, `detectCompletedMeetings`,
  `confirmMeetingCompleted(db, ws, prepId)`, `runPostMeeting` — `schedule/meetings.ts`
- `runOverdueCommitments(admin, ws)` — `schedule/commitments.ts` (task key shared with the brief caretaker → no duplicates)
- `notifyUser(admin, ws, {userId, category, eventKey, title, severity?, record?, href?, groupKey?, triggerKey?, sharedOutbox?})`,
  `notifyAdmins`, `listInbox`, `actOnNotification(db, ws, user, outboxId, dismiss|snooze|complete)`, `cancelObsolete(admin, ws, triggerKey)`,
  `sweepObsolete` — `notify/service.ts`. In-app only (S3).
- `planCapacity` (pure), `classifyTask`, `PRIORITY_CLASSES` — `capacity/capacity.ts`; `loadCapacity`, `setTaskSchedule` — `capacity/service.ts`
- `checkBudget(admin, ws, {resource, provider?, module?, critical?})`, `recordUsage`, `budgetStates`, `budgetAlerts`, `setBudget`,
  `usageReport`, `guardHandlers(handlers)` (wraps the job registry; budgeted non-critical job types pause → deferred to the reset) — `budget/service.ts`

**Routes**: page `/orchestrator/schedule` (`?view=daily|weekly|budgets`). API: `GET /api/v1/orchestrator/notifications`,
`POST /api/v1/orchestrator/notifications/:id` `{action, until?}`, `GET /api/v1/orchestrator/plan?kind=&period=`,
`GET /api/v1/orchestrator/capacity?date=`, `GET|PUT /api/v1/orchestrator/budgets` (admin), `POST /api/v1/orchestrator/meetings/:prepId/complete`,
`PUT /api/v1/orchestrator/tasks/:id/schedule`. Mutations need `Idempotency-Key`.

**Tests**: `npx vitest run src/modules/orchestrator/{schedule,notify,capacity,budget}` — §18 Test 1 (local-time slot, plan, no duplicate tasks),
Test 2/3 (prep ~1 h before, brief linked, reschedule/cancel), Test 7 (AI outage → basic plan, AI delayed + retry), Test 9 (budget pause/notify/no
provider switch), Workflow F, post-meeting (status not end time), notifications (dedupe, quiet hours, urgent, grouping, mute, dismiss/snooze RLS,
obsolete cancel), capacity warnings.

**Known gaps**: AI cost per user not available (`model_usage` has no user column); travel time always "unknown" (no routing service);
no holiday calendar; the brief module also emits `brief_ready` at plan time; meeting events from the core (`meeting.*`) are not yet wired
to `scheduleMeetingPreps(…, {prepId})` — the 15-minute sweep covers it; no nav entry for `/orchestrator/schedule` (shared `src/lib/nav.ts`).

### Retest fixes (Module 9)
- Reassessment notices go through `notify/service.notifyUser` (severity, quiet hours, dedupe). Requirement/quote notices use a group key per subject (`reassess:requirement:<id>`): one open notice, text refreshed, count increased. Notice text uses plain labels (`reassess/labels.ts`, e.g. "Maximum area 28,000 → 30,000 sq ft").
- Comparison recalculation skips when the inputs hash (requirement, quotes on its buildings, model, manual rows) is unchanged since the last orchestrator recalculation (`output.unchanged`). A newer mark on a record supersedes older open marks of the same kind.
- Already-recalculated needs-refresh marks show "Recalculated — review" with Review / Dismiss (no Refresh).
- Budget usage matching is normalised (`budget/rules.usageRowMatches`); "Brief ready" meeting notices are informational; Overview "Scheduled" lists daily plan / weekly review with next run (`schedule/next-runs.ts`); capacity kinds and the run-history "advance" entry have plain labels.

## Automation controls & monitoring (feature audit, `automation/`; see docs/orchestrator/FEATURE-AUDIT.md)
- **Global pause/resume** (`automation/service.ts` `setAutomationPaused`, table `automation_control`, editor+): pausable
  background job types (`automation/rules.ts` `isPausableJob`: signals/research/scoring/sweeps/weekly review …) are
  deferred by the job guard (`budget/service.ts` `guardHandlers`, re-queued +30 min, dedupe per job+slot); the
  dispatcher leaves events pending, starts no scheduled runs and only advances user-started runs. Never paused:
  captures, imports, assistant commands, meeting reminders/briefs, daily plan, admin/backups, `payload.userInitiated`.
  Resume → `mudar_app.release_automation_deferred` (deferred jobs due now; queued runs nudged; no new rows).
- **Priorities**: `dispatchOrder` — urgent (≥70 or user-started) first; routine (<40) held while urgent work waits.
- **Routed work**: `handledBy` consumers log `status='routed'`; `trackRouted` follows the receiving chain run
  (completed/failed/running/delayed/untracked).
- **Delays/failures**: `delayReason` (retry backoff, queued >30 min, waiting on dependency >2 h); `notifyDelayed` (info,
  after 60 min) and `notifyFailures` (urgent, unrecoverable) — once per run.
- **New events** (migration 20261111001800): `lease.created/changed`, `company.created/updated`, `contact.created`,
  `contact.info_added` → workflow `reassess.record_changed` (`reassess/records.ts`: affected companies → `recalcOrg`;
  lease change → flag analyses using that lease) + routed `workflows.lease_chain`.
- **UI** (`ui/overview.tsx`): status switch on every tab, 7 overview counts, System alerts, Delayed card, `?view=history`
  (trigger, start/finish, done/failed actions, retries, errors; filters), `?view=jobs` (job, module, status, timing,
  reason, retry; routed module work), usage per research/enrichment/transcription/AI with limit/used/remaining,
  "Triggered by" on run pages.
- Tests: `automation/rules.test.ts`, `automation/automation.db.test.ts` (pause tests use WS2 and always resume).
