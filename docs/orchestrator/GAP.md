# Module 9 core — gap analysis (spec → existing → gap → plan/built)

| Spec | Existing piece | Gap | Plan (built in `src/modules/orchestrator`) |
|---|---|---|---|
| §3 workflow engine, definitions | `workflows/*`: hard-coded chains on `workflow_run`/`workflow_step` (dedupe_key, steps with reason/refs) | No definitions, deps, conditions, retry cfg, priority, timeout, versions | Code registry `registerWorkflow` + per-ws `workflow_definition` (+`_version`); same run/step tables, `kind='orchestrated'` |
| §3 states | run: running/done/skipped/failed/waiting_approval | queued, waiting_dependency, partially_completed, completed, cancelled, paused | Widened CHECKs (legacy values kept) |
| §3/§6 dependency order, parallel, no duplicate | `Run.step` sequential, replays stored steps | Explicit `depends_on`, waves, parallel | `planWaves` / `readySteps`; `advanceExecution` runs waves with `Promise.all`; unique dedupe_key |
| §10 jobs, dedupe, dead | `mudar.job`, `claim_jobs` (SKIP LOCKED), dedupe unique, `fail_job` → dead after max_attempts, runner timeouts | Step-level retry/resume, error classes | Step attempts, `classifyError` temporary/permanent, exp. backoff (`next_attempt_at`), `dead` step = dead letter; jobs table reused for the dispatcher |
| §11 partial failure, controls | none per step | resume from failed step, pause/resume/cancel/retry/priority, failure report, export | `controls.ts` (+ `failureReport`, `affectedRecords`, `exportLog`) |
| History / audit | `audit_event` (row diffs via make_business_table) | execution-level actions | `workflow_audit_log` (started, duplicate_trigger, step_*, retry_scheduled, dead_letter, paused, …) |
| §5 events, §15 outbox/inbox | `mudar.outbox` = user notifications only; workflows **sweep** polls tables | No event bus | `event_outbox` (unique dedupe, duplicate_count) + `event_processing_log` (unique event×consumer); DB triggers publish in the same transaction (meeting_visit, quote, requirement, employment, signal_claim, connector_account) |
| §7 ex.1 new quote | toolkit `runComparison`/`saveAnalysis` (immutable versions), `quote.superseded_by` | Nothing finds dependants | `reassess.quote`: identify → recalc (toolkit) ∥ flag proposals → warn |
| §7 ex.2 requirement change | change proposals + approval apply; audit history | No downstream reassessment | `reassess.requirement`: identify → recalc ∥ `scoring.recalcOrg` ∥ flag → notify owner |
| §7 ex.3 meeting cancelled | `meetings.cancelMeeting` (status only); `remind` skips cancelled | Prep tasks/jobs left open | `reassess.meeting_cancelled`: cancel reminder tasks + queued jobs, keep commitments, notify |
| §7 ex.4 employer change | `workflows.employer_chain` (re-engagement draft) | No relationship review / flags | `reassess.employment`: flag stakeholders + opps (`review`), one review task; never moves opps |
| §7 ex.5 outage | `connector_account.status/last_error`, admin supervisor alerts | No health table/stale marks | `integration_health` + `stale` marks; recovery resolves |
| needs_refresh | `deal_analysis.status` has no such value; `document_version.status='stale'` | Can't flag without touching other modules' rows | `reassessment_mark` (needs_refresh / stale / outdated_warning / review) — flagged rows never edited |
| Notifications | `mudar.outbox` | — | Reused (kind `notification`); scheduling/aggregation belongs to the notify agent |

Not in core (other agent): §4 scheduling/daily plan/weekly review, §8 capacity, §9 notifications engine, §12 budgets.
