# brief module — Today, 08:00 brief, scheduler, scoring, lease radar, tasks, watchdog

Spec: Part I §7 (daily operating model, brief format, watchdog, urgent alerts), §8 (priority adviser, lease radar,
capacity controller, reverse planning), §9 (100-pt rubric), §13 (120/170 cohort); Part III scheduled jobs + acceptance
tests *Brief delivery*, *Calendar reschedule*, *Spend cap*, *Lease chronology*.

## What's built
| Area | Files | Notes |
|---|---|---|
| Settings | `settings.ts`, `db.ts#loadSettings` | Defaults: brief 08:00, debrief 20:30, weekly Fri 18:00, DND 22:00–07:00, no urgent opt-ins, cohort 120/170, capacity. Reads admin Settings keys `brief_time`, `cohort_targets`, `size_rules`, then workspace key `brief` (full shape), then `user_preference.prefs` (personal keys; `urgent_categories` alias accepted). |
| Scheduler | `scheduler.ts` (pure), `jobs.ts#schedule` | tz-aware slots, dedupe keys `brief.<job>:<ws>:<user>:<local date>`; existing keys in any state are skipped; queued T-60 jobs for cancelled/deleted/rescheduled meetings are cancelled each tick. |
| Scoring v1 | `scoring.ts` (pure), `scoring-data.ts` | timing 25 / fit 15 / trigger 20 / relationship 15 / engagement 15 / budget 10. Unverified (non-contractual) dates capped at 10 timing pts; expired lease = 0 + "status needs confirmation"; missing dates → enrichment; tracking opens ignored; disqualified/suppressed → 0 + tier `suppressed`; verified notice/decision ≤90 d → tier `act_this_week`. Writes `lead_score` (new `is_current` row only when changed). |
| Lease radar | `lease-radar.ts` (pure), `radar-data.ts` | expiry ≠ lock-in ≠ notice ≠ break; EDATE month-end clamp; fractional tenure quarantined; notice derived only with length + business/calendar rule; reverse plan from occupation; call windows; landlord concentration. Raises idempotent tasks (`brief.radar:<lease>:<key>`), max 25 enrichment tasks per run. |
| Priority adviser | `priority.ts` (pure), `plan.ts` | Capacity controller (meetings + travel buffers + approvals backlog → call minutes, target cap, research/draft level); deadline override first; score/effort ratio; 10–20 % exploration for never-approached prospects; every pick states what it displaced. `daily_plan` keyed by user + date + input version. Target snoozes in `user_preference.prefs.snoozedTargets`. |
| Brief | `builder.ts` (pure), `data.ts`, `brief-service.ts`, `synthesis.ts` | Sections in spec order + targets/capacity. Hot replies only when the inbox is healthy, otherwise "unavailable since X" (never "no replies"). `fallbackText` always present. Optional AI headline via gateway (`brief.synthesis`, mock in dev); any AI failure → `synthesis_status = fallback_no_ai` + notice. New version only when content hash changes. |
| Delivery / watchdog | `brief-service.ts#deliverBrief`, `watchdog.ts` | 08:00 delivery marks `delivered_at` + one private `outbox` `brief_ready` per user/date. 07:55 builds a no-AI fallback if missing; 08:05 delivers late/fallback and alerts user + owners (`brief_alert`). Runs recorded in `brief_health_run`. |
| Other briefs | `other-briefs.ts` | T-60 pre-meeting (re-validates meeting version at run time), 20:30 reconciliation (wakes snoozes, marks long-overdue tasks `stale`, previews tomorrow), Friday weekly review. |
| Tasks | `tasks-service.ts` | list/filter; complete **requires evidence**; snooze; reopen; manual create (Idempotency-Key); optimistic concurrency via `row_version` (409). States open / overdue / snoozed / stale / done are distinct. |
| Urgent alerts | `urgent.ts` | Decision helper (opt-in, verified sender, active opp, DND deferral, dedupe by source). The integrations module raises the actual `urgent_alert` outbox rows; /today shows them. |

## Job types (`jobs.ts`)
`brief.recalc` (07:00, per workspace) · `brief.plan` (07:20) · `brief.generate` (07:40) · `brief.health_check` (07:55) ·
`brief.deliver` (08:00) · `brief.health_alert` (08:05) · `brief.reconcile` (20:30, workdays) · `brief.weekly` (Fri 18:00, ISO week) ·
`brief.pre_meeting` (T-60, key = meeting id + external id@start). Times shift with the user's `briefTime`.
Handlers use the service-role client with explicit `workspace_id` filters and filter every row through the member's access (`visibility.ts`, mirror of `app.can_read`).

## Routes
Pages: `/today` (mobile: summary, top 3 actions, cohort, approvals, pipeline, targets with score breakdown/why/displaced + Open / Add to tasks / Snooze, overdue with complete-with-evidence + snooze, meetings by locality + conflicts + pre-meeting brief, urgent alerts, expiry/notice, hot replies, intel with source, sources, plain-text fallback; live preview when no brief exists yet), `/tasks` (state tabs, scope/source/search filters, complete/snooze/reopen, new task), `/leases` (windows, search, date-basis labels, reverse plan, call window, issues, concentration).

API (all via `route()`; mutations need `Idempotency-Key`):
- `GET /api/v1/briefs/today?date=&kind=daily|reconciliation`
- `POST /api/v1/briefs/generate` (editor) → `{created, brief}`
- `GET /api/v1/briefs/:id` (own briefs only)
- `GET /api/v1/tasks?state=&scope=&q=&source=` · `POST /api/v1/tasks` (editor)
- `POST /api/v1/tasks/:id/complete` `{expectedVersion, evidence}` · `/snooze` `{expectedVersion, until}` · `/reopen` `{expectedVersion}`

## Exported services (for other modules)
- `generateDailyBrief(loadCtx, settings, {date})`, `latestBrief(db, ws, user, date, kind?)` — `brief-service.ts`
- `createTargetTask`, `listTasks` — `tasks-service.ts`
- `scoreLead`, `explain`, `TIER_LABEL` — `scoring.ts`; `analyseLease`, `runRadar` — `lease-radar.ts` (pure)
- `decideUrgentAlert` — `urgent.ts`

## Tables (migration `20261031001200_brief.sql`, re-runnable)
`daily_plan`, `brief_health_run` (both `make_business_table`). Uses core `brief`, `lead_score`, `task`, `outbox`, `user_preference`.

## Tests
`npx vitest run src/modules/brief` — scoring rubric edges/tiers/overrides, lease chronology, scheduler dedupe + IST midnight + T-60 reschedule + DND, stale labelling, AI fallback (budget/paused/provider), priority/capacity, task states (pure); DB: brief generation under RLS, job-mode visibility, one notification per user/date, 07:55/08:05 watchdog, T-60 reschedule/cancel, task evidence/concurrency/cross-tenant, recalc + plan in an isolated workspace.

## Env
None beyond core (`OPENAI_API_KEY` empty ⇒ mock synthesis).

## Known gaps
- No holiday calendar (business-day notice maths skips weekends only).
- Briefs/plans are readable by workspace owners/admins (RLS `can_read`), not only the user.
- Hot-reply detection = meaningful inbound email/WhatsApp/LinkedIn since the previous brief; no model-based "hotness" yet.
- Cohort count = distinct orgs whose first outbound by this user (last 2 years) falls in the month, from logged interactions.
- Light/weekend mode is a flag only; no separate holiday list. Weekly/reconciliation content is deterministic only (no AI).
- Push/email delivery of outbox notifications is out of scope (in-app only, S3).
