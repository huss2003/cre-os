# Orchestrator core — contract (Module 9)

Import from `@/modules/orchestrator` (server-only). All functions take `(db, ws, ...)`: `db` = `ctx.db` (RLS) for
user actions, or `createAdminClient()` inside jobs only (S2 — every query filters `workspace_id`). Nothing sends (S3).

## Types
```ts
type ExecStatus = "queued" | "running" | "waiting_dependency" | "waiting_approval" | "partially_completed"
  | "completed" | "failed" | "cancelled" | "paused";           // legacy workflow_run values "done"/"skipped" still exist
type DefStatus = "draft" | "active" | "paused";
type StepState = "queued" | "running" | "waiting_dependency" | "waiting_approval" | "done" | "skipped" | "failed" | "cancelled" | "dead";
type TriggerType = "event" | "schedule" | "user" | "condition";
interface StepDef { key; label; module; dependsOn?: string[]; condition?(c): boolean | string;
  run(c: StepCtx): Promise<StepOutcome>; retry?: { maxAttempts; baseMs; maxMs }; timeoutMs?; consequential?: boolean }
interface StepOutcome { status: "done" | "skipped" | "waiting_approval"; reason: string; refs?: Ref[]; output?: unknown }
interface WorkflowDefinition { key; name; description; trigger: { type: TriggerType; events?: string[]; everyMinutes?: number };
  steps: StepDef[]; permissions: { role: "viewer"|"editor"|"admin" }; approvals: string[]; retry; timeoutMs; priority (0-100); module }
class TemporaryError / PermanentError   // throw from a step; anything else is classified by classifyError()
```

## Definitions
- `registerWorkflow(def)` — add a code definition (key unique). Other agents (schedule/notify/…) register their
  recurring workflows here (`trigger.type = "schedule"`, `everyMinutes`).
- `listWorkflows(db, ws)` / `getWorkflow(db, ws, key)` — code definition + per-workspace row `workflow_definition`
  (status, priority, schedule override, version, next_run_at, last_run_at, owner) + `versions`.
- `setWorkflowStatus(db, ws, key, "active"|"paused"|"draft", actor)`, `editSchedule(db, ws, key, { everyMinutes?, nextRunAt? }, actor)`,
  `changeWorkflowPriority(db, ws, key, priority, actor)` — each bumps the definition version (row in `workflow_definition_version`).

## Executions (`workflow_run` kind `orchestrated` + `workflow_step`)
- `startExecution(db, ws, key, { input, dedupeKey, trigger, subjectType?, subjectId?, orgId?, priority?, actor? })`
  → `{ id, duplicate }`. Same dedupeKey = same execution (duplicate recorded in `workflow_audit_log`).
- `advanceExecution(db, ws, runId, { now? })` — runs every ready step (dependency waves, independent steps in parallel).
- `listExecutions(db, ws, { status?, key?, limit? })`, `getExecution(db, ws, runId)` → run + steps + audit + `failure` report
  (what failed, affected records, earlier steps ok, stale?, will retry?, user action).
- Controls: `pauseExecution`, `resumeExecution`, `cancelExecution`, `retryExecution` (failed/dead steps only; done steps kept),
  `changePriority(db, ws, runId, n)`. All `(db, ws, runId, actor?)`, all audited.
- `affectedRecords(db, ws, runId)` → `Ref[]` from step outputs + reassessment marks.
- `exportLog(db, ws, runId)` → JSON string.

## Events (transactional outbox `event_outbox` + idempotent inbox `event_processing_log`)
- `publishEvent(db, ws, { type, subjectType, subjectId, payload?, dedupeKey? })` → `{ id, duplicate }`.
  DB triggers already publish: `meeting.scheduled|rescheduled|cancelled|completed` (meeting_visit),
  `commercial.quote_received` (quote insert), `commercial.requirement_changed` (requirement area/seats/budget/geo/dates update),
  `contact.employment_changed` (employment insert for a person with another employment), `research.signal_detected`
  (signal_claim insert), `integration.failed|recovered` (connector_account status).
- `processEvents(db, ws, { limit? })` — consumers per event type (see `events/consumers.ts`); each (event, consumer)
  processed once.
- `EVENT_TYPES` constant lists all types (spec §5.1–5.6).

## Reassessment / staleness
- `reassessment_mark` rows: `{ entity_type, entity_id, mark: "needs_refresh"|"stale"|"outdated_warning"|"review", reason, cause_event_id, state: open|resolved|dismissed }`.
- `listMarks(db, ws, { entityType?, entityId?, state? })`, `resolveMark(db, ws, id, "resolved"|"dismissed")`,
  `isStale(db, ws, entityType, entityId)` → mark | null.
- `recordIntegrationFailure(db, ws, source, error, { affects? })`, `recordIntegrationSuccess(db, ws, source)`,
  `listIntegrationHealth(db, ws)` → rows with `last_success_at`, `consecutive_failures`, `next_retry_at`, `status`.

## Jobs
`orchestrator.dispatch` (per workspace each tick): process events → start due scheduled workflows (skips paused) →
advance runnable executions (queued / retry due) → time out overdue runs. Registered in `src/lib/jobs/registry.ts`.

## Notifications
Core writes plain rows to the existing `mudar.outbox` (kind `notification`, dedupe per cause). The notify agent may
render/aggregate them; the core never sends anything outside the app.
