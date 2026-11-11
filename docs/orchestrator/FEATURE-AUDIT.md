# Module 9 Orchestrator — feature audit against FEATURES.txt (2026-11-11)

Scope: `src/modules/orchestrator/**`, `src/app/(app)/automation/**`, `src/app/(app)/approvals/outdated`, README, docs.
Method: code read + `npx vitest run src/modules/orchestrator` (before: 14 files / 74 tests passing; after: **16 files / 88 tests passing**)
+ UI visited on the running production build (http://localhost:3100, owner, Demo workspace; screenshots in `/tmp/orch-audit/`:
`overview.png, overview-375.png, daily.png, weekly.png, budgets.png, notifications.png, wf.png, run.png, outdated.png`).

**Important:** the app on :3100 is a production build made *before* this audit, so the screenshots show the **before** state.
UI added here (status switch, 7 counts, System alerts, Delayed card, History tab, Background jobs tab, category usage,
"Triggered by" on run pages) is type-checked (`npx tsc --noEmit` clean for these files) but only renders after the next build.

Legend — DONE / PARTIAL / MISSING. "→" = after this change. Abbrev.: `orch/` = `src/modules/orchestrator/`,
`auto/` = `orch/automation/`, `mig1800` = `supabase/migrations/20261111001800_orchestrator_audit_gaps.sql`.

## 2.1 Automated workflow scheduling
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Schedule and run source updates | DONE | DONE | integrations/meetings.calendar jobs; `integration_health` (`orch/reassess/marks.ts:41`) |
| Schedule and execute signal checks | DONE | DONE | `signals.scan` job (budget-guarded `orch/budget/rules.ts` JOB_MAP) |
| Trigger account/opportunity scoring updates | DONE | DONE | `reassess.requirement` rescore step; new `reassess.record_changed` rescore (`orch/reassess/records.ts`) |
| Schedule meeting preparation briefs | DONE | DONE | `scheduleMeetingPreps` (`orch/schedule/meetings.ts:40`); test "Test 2 / 3 — Meeting brief scheduling" |
| Trigger post-meeting processing | DONE | DONE | `runPostMeeting` (`meetings.ts:165`); test "Post-meeting processing (§4.4)" |
| Schedule reminders and follow-ups | DONE | DONE | `runOverdueCommitments` (`schedule/commitments.ts:16`), meetings.remind |
| Generate weekly business reviews | DONE | DONE | `runWeeklyReview` (`schedule/weekly.ts:61`); weekly.png |
| Execute recurring background research | DONE | DONE | intelligence.research/patrol jobs (budget + pause guarded) |
| Manage multiple workflows simultaneously | DONE | DONE | `advanceExecution` waves + `Promise.all` (`engine/runner.ts`) |
| View upcoming, running, completed, failed | DONE | DONE | overview.png (Scheduled / Running now / Recently finished / Needs attention) + new History tab |
| Pause and resume workflows | DONE | DONE | `setWorkflowStatus`, run pause/resume; test "Test 12 — pause and resume a recurring workflow" |
| Prevent duplicate scheduled execution | DONE | DONE | slot dedupe in `startDueScheduled` (`engine/controls.ts`); test "Test 10 — duplicate event" |

## 2.2 Automated 08:00 daily plan
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Review scheduled meetings | DONE | DONE | `buildDailySections` (`schedule/plan-builder.ts:33`); test "has all ten sections" |
| Urgent client-related activities | DONE | DONE | plan-builder `urgent_client` section; `urgentProposals` (`schedule/data.ts:70`) |
| Pending follow-ups and commitments | DONE | DONE | `loadOverdueCommitments` (`data.ts:78`) |
| Overdue tasks | DONE | DONE | plan-builder overdue section |
| High-priority accounts/opportunities | DONE | DONE | brief targets + `dealsNeedingAttention` (`data.ts:59`) |
| Important new signals | DONE | DONE | `loadSignals` (`data.ts:41`) |
| Upcoming meetings needing prep | DONE | DONE | `loadPrepStatus` (`data.ts:28`) |
| Tasks that need attention | DONE | DONE | plan-builder |
| Prioritise by urgency and importance | DONE | DONE | `recommend` (`plan-builder.ts:64`), `classifyTask` (`capacity/capacity.ts:42`) |
| Consider calendar commitments | DONE | DONE | capacity: meetings fixed (`planCapacity`, `capacity.ts:109`) |
| Consider travel requirements | DONE | DONE | travel between in-person meetings, conflict warning (`capacity.ts:120-129`); travel time is *unknown* (no routing service — S6, never invented); test "travel time is never invented" |
| Consider daily working capacity | DONE | DONE | free/demand minutes, over-capacity rescheduling; daily.png "675 min in meetings · 0 min free" |
| Present most important activities | DONE | DONE | recommended actions; daily view |
| Plan without AI (fallback) | DONE | DONE | test "Test 7 — AI provider unavailable" |

## 2.3 Meeting workflow automation
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Detect upcoming meetings | DONE | DONE | meeting.scheduled trigger + `scheduleMeetingPreps` |
| Prep brief ~1 h before | DONE | DONE | `prepDueAt` (`meetings.ts:30`); test "about one hour before…" |
| Route prep to specialist module | DONE | DONE | reuses `meetings.generateBrief` (Module 7) |
| Ensure company/contact/property/requirement info | DONE | DONE | brief "missing information" (notifications.png) |
| Trigger post-call processing | DONE | DONE | `detectCompletedMeetings`/`runPostMeeting` |
| Outcomes processed, records updated | DONE | DONE | outcome → change proposals (S4) |
| Follow-up tasks from commitments | DONE | DONE | meetings.applyOutcome commitment tasks |
| Reminders for agreed actions | DONE | DONE | hourly overdue-commitment reminders |
| Weekly review of meeting outcomes + commitments | DONE | DONE | weekly sections `meetings_completed`, `overdue_commitments`, follow-ups (`weekly.ts:38-44`); weekly.png |
| Cancel: cancel reminders | DONE | DONE | `reassess.meeting_cancelled`; test "Test 3 — cancelled meeting" |
| Cancel: prevent obsolete prep | DONE | DONE | prep jobs cancelled via `prep_schedule` consumer |
| Cancel: preserve history | DONE | DONE | same test |

## 2.4 Specialist module routing
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Source updates → source/research | DONE | DONE | `reassess.integration_*`, intelligence jobs |
| Signal checks → Module 2 | DONE | DONE | `research.signal_detected` → workflows.signal_chain (now tracked) |
| Scoring → Module 3 | DONE | DONE | `recalcOrg` steps |
| Contact reviews → Module 4 | DONE | DONE | `reassess.employment` review task; contacts.reverify |
| Outreach → Module 5 | DONE | DONE | chains create drafts only (S3) |
| Meetings → Module 7 | DONE | DONE | generateBrief / structureOutcome |
| Commercial reassessments → Module 8 | DONE | DONE | `runComparison` in `reassess.quote/requirement` |
| AI/retrieval with Module 12 | DONE | DONE | `assistant/tools/orchestrator.ts` |
| Updates with Module 1 | DONE | DONE | change proposals + marks |
| Track status of every routed task | PARTIAL | DONE | routed consumers were logged "skipped"; now `status='routed'` + `routed_status` (`orch/events/process.ts` `handledBy`, mig1800 §2) |
| Track whether receiving module completed | MISSING | DONE | `trackRouted` (`auto/service.ts`) maps chain run → completed/failed/running/delayed/untracked; dispatcher calls it each tick; test "tracks whether the receiving module completed routed work" |
| Handle failed or delayed module operations | PARTIAL | DONE | engine retries existed; added delayed detection + failure/delay notifications (`notifyDelayed`, `notifyFailures`) and routed failures in System alerts |
| Avoid workflows when nothing relevant changed | DONE | DONE | triggers emit only on relevant columns (requirement, new lease/company triggers); `comparisonInputsHash` skip; `record_changed` skips when nothing linked (test "person with no current employer → workflow skips") |

## 2.5 Event-driven automation
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Newly created records | PARTIAL | DONE | before: meeting/quote/signal/employment only; now + `company.created`, `contact.created`, `lease.created` triggers (mig1800 §3) |
| Updated company information | MISSING | DONE | `orch_org_event` → `company.updated` → `reassess.record_changed` |
| New contact information | MISSING | DONE | `orch_contact_method_event` → `contact.info_added`; test "new contact detail → event" |
| Changes in lease details | MISSING | DONE | `orch_lease_event` → `lease.changed` (+ routed lease_chain); test "lease change → event → re-score tenant" |
| New rent quotations | DONE | DONE | test "Test 4 — new rent quotation" |
| Property requirement changes | DONE | DONE | test "Test 5" |
| Meeting creation/cancellation | DONE | DONE | `orch_meeting_event` |
| Contact employment changes | DONE | DONE | test "Test 8" |
| Research information changes | DONE | DONE | `signal_claim` trigger; research.* publishable event types |
| Trigger relevant workflows | DONE | DONE | `CONSUMERS` (`events/process.ts`) |
| Reassess affected outputs | DONE | DONE | reassess.* + lease analyses flagged `needs_refresh` (`records.ts` flag step) |
| Modules receive updated info | DONE | DONE | routed + now tracked |

## 2.6 Dependency management — all DONE before and after
Identify dependencies, correct order, block until info available, incomplete/pending dependencies, resume when available,
reassess dependants, stop obsolete tasks: `planWaves/readySteps/deriveStatus` (`engine/plan.ts`), `waiting_dependency`
state, reassessment marks; tests "dependency waves; cycles and unknown deps rejected", "Test 11 — partial failure",
"Test 3/4/5". (8 bullets: DONE → DONE.)

## 2.7 Priority and daily capacity
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Urgent client work over routine research | DONE | DONE | priority-ordered `runnableExecutions`; now `dispatchOrder` (`auto/rules.ts`) |
| Time-sensitive client commitments | DONE | DONE | capacity priority classes |
| Meetings and travel | DONE | DONE | capacity (see 2.2) |
| Daily working capacity | DONE | DONE | capacity |
| Conflicting scheduled activities | DONE | DONE | overlap conflicts; test "overlapping appointments are conflicts" |
| Background work must not interfere | PARTIAL | DONE | budget guard only; now routine runs (<40) held while urgent (≥70 or user-started) work waits + global pause; test "runs urgent/user work first and holds routine background runs" |
| Activities that cannot fit capacity | DONE | DONE | test "over capacity → realistic rescheduling" |
| Track delayed and pending work | PARTIAL | DONE | `delayReason/isDelayedRun/isDelayedJob` (`auto/rules.ts`); Delayed count + card + History filter |
| Reprioritise when urgent work arrives | PARTIAL | DONE | every dispatcher tick re-sorts and holds background runs (`orch/jobs.ts` `dispatch`) |

## 2.8 Reminders and notifications
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Reminders for meetings | DONE | DONE | meeting prep notification |
| Reminders for pending commitments | DONE | DONE | test "Workflow F — overdue commitment" |
| Reminders for follow-ups | DONE | DONE | follow_up category |
| Notify important workflow failures | MISSING | DONE | `notifyFailures` (`auto/service.ts`), urgent, once per run; test "notifies once about … a run that cannot recover" |
| Notify delayed processes | MISSING | DONE | `notifyDelayed` (after 60 min, once per run); same test |
| Notify important info changes | DONE | DONE | reassess notices (notifications.png) |
| Notify quote affects comparison | DONE | DONE | test "Test 4" |
| Notify stale source info | DONE | DONE | `reassess.integration_failed` alert step |
| Avoid repetitive notifications | DONE | DONE | dedupe + grouping; tests "never notifies twice", "group keys" |
| Meaningful over routine | DONE | DONE | severity/quiet hours; delayed = info, unrecoverable = urgent |

## 2.9 Background job management
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Source updates / signal checks / scoring / research in background | DONE | DONE | job registry (`src/lib/jobs/registry.ts`) |
| Coordinate enrichment | DONE | DONE | contacts.reverify (budget resource `enrichment`) |
| Coordinate transcription | DONE | DONE | capture.process (resource `transcription`, critical) |
| Trigger AI processing | DONE | DONE | plan_ai retry, gateway |
| Track job execution status | DONE | DONE | `mudar.job.state` |
| Track job completion time | PARTIAL | DONE | Background jobs tab: due / finished / seconds (`listBackgroundJobs`) |
| Track failed and delayed jobs | PARTIAL | DONE | failed jobs page existed; delayed jobs now flagged (`isDelayedJob`) |
| Track resource and service usage | DONE | DONE | `resource_usage`, `model_usage` |
| Users inspect job details | PARTIAL | DONE | only failed jobs at `/approvals/jobs`; now `/automation?view=jobs` (all states, filters) |
| Prevent duplicate background actions | DONE | DONE | job dedupe index; pause deferral dedupe per job+slot (test "defers … (once)") |

## 2.10 Failure recovery and retry
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Detect failed jobs; identify temporary; auto-retry; no duplicates on retry; count attempts; failure reason; manual-intervention; keep completed steps; resume eligible | DONE (9) | DONE | `classifyError`, backoff, dead letter, `failureReport`; tests "Test 6", "Test 11" |
| Notify when cannot recover automatically | MISSING | DONE | `notifyFailures` (dispatcher each tick) |

## 2.11 System health and execution monitoring
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Completed workflows | DONE | DONE | Recently finished + Completed count |
| Running workflows | DONE | DONE | Running now |
| Delayed workflows | MISSING | DONE | Delayed count/card/History filter (`auto/rules.ts` `delayReason`) |
| Failed workflows | DONE | DONE | Needs attention; Failed count |
| Workflows requiring attention | DONE | DONE | Needs attention card (overview.png) |
| Source availability | DONE | DONE | Connections card, `integration_health` |
| Unavailable services | DONE | DONE | StaleBanner per unhealthy source |
| Stale info from outages | DONE | DONE | `stale` marks; test "Source outage" |
| Background processing activity | DONE | DONE | JobBacklogBanner (overview.png), Background jobs tab |
| Clear execution history | PARTIAL | DONE | per-run history only; now History tab across runs |
| What succeeded / delayed / needs attention | PARTIAL | DONE | 7 counts + System alerts |

## 2.12 AI and operational budgets — all DONE before and after (10 bullets)
`resource_budget`/`resource_usage`, `checkBudget`, `guardHandlers`, `budgetAlerts`, `usageReport` (`orch/budget/service.ts`);
tests "Test 9 — budget limit" (RLS, pause non-critical, notify, provider kept); budgets.png.

## 2.13 Pause and resume controls
| Bullet | Before | After | Evidence |
|---|---|---|---|
| One-click pause | PARTIAL | DONE | before: per-workflow pause (admin) and admin kill switch that stops *all* jobs incl. critical; now `AutomationSwitch` (`orch/ui/overview.tsx`) → `automationAction` → `setAutomationPaused` |
| One-click resume | PARTIAL | DONE | same; resume releases deferred work via `mudar_app.release_automation_deferred` |
| User can pause background automation | PARTIAL | DONE | `automation_control` (editor+, RLS); test "only editors+ … can pause" |
| User can resume | PARTIAL | DONE | as above |
| No new eligible jobs while paused | PARTIAL | DONE | `guardHandlers` defers pausable job types (`isPausableJob`); dispatcher starts no scheduled/event runs, events stay pending; tests "defers pausable background jobs…", "dispatcher: while paused…" |
| Preserve workflow states | DONE | DONE | nothing cancelled; queued runs stay queued |
| Resume pending without duplicates | PARTIAL | DONE | same dedupe keys; test asserts one step row, consumer ran once |
| Clearly show active/paused | MISSING | DONE | "Automation active / Automation paused" badge on every Automation tab + System alert |
User-initiated / critical work never pauses: captures, imports, assistant commands, meeting reminders/briefs, daily plan,
admin/backups, user-started workflow runs, jobs with `payload.userInitiated`.

## 3 Automation rules
| Rule | Before | After | Evidence |
|---|---|---|---|
| 1 New rent quotation | DONE | DONE | Test 4 |
| 2 Cancelled meeting | DONE | DONE | Test 3 |
| 3 Employment change (no opp transfer) | DONE | DONE | Test 8 |
| 4 Source outage → stale | DONE | DONE | "Source outage" test |
| 5 New records/contacts/lease → dependants | PARTIAL | DONE | mig1800 triggers + `reassess.record_changed`; tests in `auto/automation.db.test.ts` |
| 6 AI unavailable → plan still built | DONE | DONE | Test 7 |
| 7 No independent external send | DONE | DONE | drafts only; no send code in orchestrator |
| 8 Duplicate prevention | DONE | DONE | Test 10; pause deferral dedupe |
| 9 Priority management | PARTIAL | DONE | `dispatchOrder` |
| 10 Information dependency | DONE | DONE | reassess.* + marks |

## 4 Main UI
| Item | Before | After | Evidence |
|---|---|---|---|
| A Total workflows | MISSING | DONE | `overviewCounts` → Stat "Total workflows" (`automation/page.tsx`) |
| A Active | DONE | DONE | "Running now" (overview.png) → "Active" |
| A Scheduled | PARTIAL | DONE | list only → count |
| A Completed | PARTIAL | DONE | list only → count |
| A Failed | DONE | DONE | count (overview.png "Failed 1") |
| A Delayed | MISSING | DONE | count |
| A Requiring attention | PARTIAL | DONE | card only → count |
| A Automation status | MISSING | DONE | `AutomationSwitch` badge |
| A Pause/resume control | MISSING | DONE | `AutomationSwitch` button |
| B Daily 08:00 plan, meetings, priority activities, follow-ups, urgent commitments, overdue tasks, new signals, needing attention (8) | DONE | DONE | `?view=daily` (daily.png; "Build now", capacity) — sections from `buildDailySections` |
| C Workflow name | DONE | DONE | run page (run.png) + History tab |
| C Triggering event | PARTIAL | DONE | only in audit log; now "Triggered by" on run page and History (`triggerLabel`) |
| C Start / completion time | DONE | DONE | run.png header |
| C Current status | DONE | DONE | run.png |
| C Executed / failed actions | DONE | DONE | run.png steps; History lists Done/Failed |
| C Retry attempts | DONE | DONE | "3 attempts" in run.png; History retries |
| C Error details | DONE | DONE | "What went wrong" (run.png) |
| D Job name | PARTIAL | DONE | failed jobs only → `JobsView` |
| D Assigned specialist module | MISSING | DONE | `moduleLabel` |
| D Job status | PARTIAL | DONE | all states + Delayed / Held badges |
| D Execution time | MISSING | DONE | due / finished / seconds |
| D Completion status | PARTIAL | DONE | Completed / Failed / Waiting |
| D Failure reason | DONE | DONE | `last_error` |
| D Retry status | PARTIAL | DONE | "retry n of m at …" |
| E Important information changes | PARTIAL | DONE | Notifications tab only → `AlertsCard` info_change |
| E Failed workflows | DONE | DONE | Needs attention → also in alerts |
| E Delayed activities | MISSING | DONE | alerts `delayed` |
| E Source outages | DONE | DONE | banners → also alerts |
| E Stale information warnings | DONE | DONE | outdated link → alerts `stale` |
| E Budget-related warnings | PARTIAL | DONE | usage card / notifications → alerts `budget` |
| E Actions requiring attention | DONE | DONE | alerts `attention` (proposals + approvals) |
| F Research / Enrichment / Transcription / AI usage | PARTIAL (4) | DONE | only configured budgets on overview → `UsageCategories` always lists all four (`categoryUsage`) |
| F Configured limits | DONE | DONE | budgets.png |
| F Current usage | DONE | DONE | budgets.png usage |
| F Remaining budget | MISSING | DONE | `remaining` per category |

## 5 End-to-end workflows
| Workflow | Before | After | Evidence |
|---|---|---|---|
| 1 Daily business plan | DONE | DONE | Test 1 |
| 2 New business signal (scoring + contact review + follow-up) | DONE | DONE | routed to workflows.signal_chain (match → contacts → scoring → draft); completion now tracked |
| 3 Upcoming meeting | DONE | DONE | Test 2/3 |
| 4 Post-meeting | DONE | DONE | §4.4 test |
| 5 New rent quotation | DONE | DONE | Test 4 |
| 6 Cancelled meeting | DONE | DONE | Test 3 |
| 7 Overdue commitment | DONE | DONE | Workflow F test |
| 8 Weekly business review | DONE | DONE | weekly test + weekly.png |
| 9 Temporary service failure | DONE | DONE | Test 6 |
| 10 Contact employment change | DONE | DONE | Test 8 |

## Summary
| | Bullets | DONE before | PARTIAL before | MISSING before | DONE after |
|---|---|---|---|---|---|
| §2.1–2.13 features | 142 | 116 | 17 | 9 | 142 |
| §3 rules | 10 | 8 | 2 | 0 | 10 |
| §4 UI A–F | 47 | 25 | 14 | 8 | 47 |
| §5 workflows | 10 | 10 | 0 | 0 | 10 |
| **Total** | **209** | **159** | **33** | **17** | **209** |

Known limits (unchanged by design): travel time is never estimated (no routing service); background job details are
admin-only (RLS on `mudar.job`); routed lease/signal/employer chains that decide no work is needed show as
"Module decided no work was needed" (`untracked`); UI must be rebuilt to appear on :3100.

## Files changed
- New: `supabase/migrations/20261111001800_orchestrator_audit_gaps.sql` (applied locally with psql; re-runnable),
  `orch/automation/{rules.ts,service.ts,rules.test.ts,automation.db.test.ts}`, `orch/reassess/records.ts`, `orch/ui/overview.tsx`.
- Edited: `orch/events/process.ts` (routed status, record consumers), `orch/events/publish.ts` (event types),
  `orch/budget/service.ts` (`guardHandlers` pause check), `orch/jobs.ts` (`dispatch`: pause, priority hold, tracking,
  notifications), `orch/ui/service.ts` (counts, alerts, delayed, categories, `automationControl`), `orch/ui/actions.ts`
  (`automationAction`), `src/app/(app)/automation/page.tsx`, `src/app/(app)/automation/runs/[runId]/page.tsx`,
  `orch/README.md`, `orch/engine.db.test.ts` (Test 12 now deletes its future-dated fixture runs, which had been crowding
  the "newest runs" list used by the assistant test).
