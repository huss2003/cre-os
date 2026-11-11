# Orchestrator — scheduling / notifications / capacity / budget: what existed vs what was added

| Spec | Already in CRE OS (reused) | Gap closed in `src/modules/orchestrator/{schedule,notify,capacity,budget}` |
|---|---|---|
| §4.2 Daily 08:00 plan | brief module: tz-aware 07:00–08:05 pipeline, `brief` (daily), `daily_plan` day order, no-AI fallback, `brief_ready` | `orchestrator.daily_plan` at the user's time/timezone → `orch_plan` (one row per user+date) with the 10 §4.2 sections, linked to (and generating if missing) the brief. AI headline optional → `delayed` + `orchestrator.plan_ai` retry. Creates no tasks. |
| §4.3 Meeting prep | meetings `autoBriefs` (60–75 min window sweep), brief `brief.pre_meeting` (T-60 pre-meeting brief) | Durable per-(prep, start) job ~1 h before, rescheduled/cancelled on change; reuses `meetings.generateBrief`; notification "brief ready" with missing info. |
| §4.4 Post-meeting | `meetings.structureOutcome/applyOutcome` (proposals → Review, commitment tasks, follow-up draft), workflows `meeting_chain` (rescore) | Trigger only on `completed` status or user confirmation (`POST …/meetings/:id/complete`); runs outcome structuring; notifies "review outcome" / "add notes". |
| §4.5 Weekly review | brief `brief.weekly` (cohort/pipeline snapshot only) | `orchestrator.weekly_review` with all 13 §4.5 sections → `orch_plan` kind weekly. |
| Workflow F | brief caretaker (overdue promise → task + `promise_overdue`, daily) | Hourly; same task key + same outbox key as the caretaker → never duplicated; importance from active deals. |
| §8 Capacity | brief `agenda.ts` day order (flat prep/travel buffers) | Priority classes, free time from meeting_visit + working hours, overlaps, warnings (meetings, overdue commitments, urgent proposals, prep time, travel), reschedule suggestions, user overrides (`task_schedule`). Travel time: always "unknown" (no routing service). |
| §9 Notifications | `outbox` (dedupe per key, in-app only), `user_preference` DND | `notification_state` side table: severity, quiet/working-hour deferral, grouping, record links, dismiss/snooze/complete, auto-cancel; prefs in `user_preference.prefs.orchestrator.notifications`. |
| §12 Budgets | gateway monthly INR cap + `ai_paused`, `model_usage`, supervisor 80/100 % alerts | `resource_budget` (daily/monthly per resource/provider/module), `resource_usage` (non-model usage with user/module/workflow), job guard in the registry (pause → defer, critical continues), admin alerts, admin adjust. |

Known gaps: model_usage has no user column (per-user AI cost unavailable); no holiday calendar; no routing service; the
brief module still sends its own `brief_ready` at the same time as the plan notification; nav link not added (`src/lib/nav.ts` is shared).
