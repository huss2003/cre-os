# Module 9 — Workflows (orchestrator)

Chains existing module services so that a trigger leads to visible, reviewable next steps. Each chain is one
`workflow_run` (unique `dedupe_key` per workspace → never runs twice for the same trigger) with one `workflow_step` per
step: `queued / running / done / skipped / failed / waiting_approval`, a plain-language reason and output refs.
**Nothing is sent** (S3): outreach stops at a draft awaiting approval. Requirement creation is material
(`classifyRisk`) and goes through `proposeChange`; the run waits and resumes after approval.

## Chains
**Workflow 1 — signal → action** (`runSignalChain`, dedupe `signal:<id>:strong|weak`, so a weak signal later
confirmed/strengthened gets one more run):
1. Match company — already linked, or exact/alias match via `signals.resolveOrg` + `actOnSignal("correct_company")`. Fuzzy never auto-links.
2. Find decision-makers — if < 2 current `decision_maker`/`economic_buyer` assessments: `contacts.discoverCompany` (skip if a company_discovery job ran in the last 14 days; its own per-day idempotency and AI budget apply).
3. Recalculate scores — `scoring.recalcOrg`.
4. Outreach draft — only if: signal strong (verification `fact` or confidence medium/high, per the signals engine), lead band `High`/`Very High` (scoring model bands), no outreach for the company in 30 days, a non-do-not-contact decision-maker with a verified/likely channel. One channel only, via `outreach.createOutreach` with `scenarioFor(signal)`. `OutreachError` (suppression etc.) → skipped with its message.

**Workflow 7 — lease → renewal/relocation** (`runLeaseChain`, dedupe `lease:<id>:<window>`; window = lock-in end or notice deadline within 6 months, else expiry within 12 months; earliest wins). Tenant must be an organisation in the workspace.
1. Requirement `Renewal or relocation — <company>`: reuse an open one with that title, else a `requirement` create proposal (`idempotencyKey workflows:lease:<id>:requirement`) prefilled from the lease: area + basis (status `reported`), current micro-market + sibling micro-markets (same parent), current lease/building/expiry in `constraints.values`. Seats, budget, decision/occupation dates are left out (null). Run → `waiting_approval` until applied.
2. Match alternatives — `deals.runShortlist` (trigger `workflow`).
3. Renewal vs relocation — if lease rent and area known and a shortlisted alternative has an asking rent per sq ft: `toolkit.compareRenewalRelocation` + `saveAnalysis`. Explicit assumptions (renewal rent = current; alternative = lower asking rent × same area; 60 months; 0 % discount) are stored in `inputs.workflow_assumptions` and the version note; every other cost stays unknown and is listed in `missing`.
4. Task `Discuss renewal vs relocation with <company>` for the owner (idempotency key `workflows:lease:<id>:<window>:discuss`, source `workflow`, linked to the requirement, related org/lease/analysis).
5. Outreach draft (`lease_renewal`) under the same gates as Workflow 1.

## Round 2 — event chains (`events.ts`, spec §10.2, §14.2, Workflows E and G)
Picked up by the same sweep (lookback 14 days), each with its own toggle.

**Reply → meeting** (`runReplyChain`, `reply_chain`, dedupe `reply:<outreach_item>`). Trigger: `outreach.recordResponse` set status `meeting` or outcome `meeting_scheduled`/`interested`.
1. Meeting record — an upcoming meeting already on record for the person (attendee) or linked to the person/company is linked (a `meeting_prep` is attached via `meetings.createMeeting` if missing). Otherwise a **"Schedule meeting with …" task (to schedule)** — `meeting_visit.start_at` is NOT NULL, so no meeting row is created without an agreed time; no time is ever invented.
2. Pause planned follow-ups — remaining open/planned items for the person via `outreach.pauseItem` (usually already paused by `recordResponse` → skipped with that reason).
3. Opportunity next action — `proposeChange(opportunity, next_action/next_action_due)` (idempotency `workflows:reply:<id>:opp`); risk decided by `classifyRisk`.
4. Meeting preparation — when a time exists: queued (meetings `autoBriefs` builds the brief 60–75 min before); skipped otherwise.

**Job change → re-engagement** (`runEmployerChain`, `employer_chain`, dedupe `employer:<employment>`). Trigger: a current `employment` row created in the lookback for a person who has another employment (i.e. an approved `proposePersonMove` / `recordJobMove` / contacts enrichment move). Steps: history kept (reported) → new employer must already be a company (the move proposal carries the org; never auto-created) → open signals at the new employer → `recalcOrg` → ONE draft via `intelligence/network.draftReconnect` (uses only name, new employer, new title — nothing from the old employer) when: not do-not-contact / suppressed, prior relationship (outreach `relationshipLevel` ≥ spoke on call, or a `relationship_edge`), not "not interested", and no outreach item or draft to the person in 30 days.

**Visit feedback → comparison** (`runFeedbackChain`, `feedback_chain`, dedupe `feedback:<id>:v<row_version>` so an edited form re-runs). Trigger: `meetings.saveFeedback` (`meeting_property_feedback`) on a meeting linked to a requirement.
1. Shortlist option (latest version, same building) → `deals.setOptionStatus`: `rejected` only for an explicit rejection (reason = the feedback text, kept in the step); anything else (e.g. "rent is high") → `visited`; rejected/selected/visited never downgraded. Not on the shortlist → skipped.
2. Saved `property_comparison` for the requirement → re-rated with toolkit `loadRequirement/loadAssetProperties/loadModel/rateProperties` and saved with `saveAnalysis(id)` = new version. Explicitly rejected buildings are removed (listed in `inputs.removed_rejected`); overall 1–5 becomes custom factor `client_feedback` (0–1) — it only changes scores if the rating model has that factor (said in the note); all feedback in `inputs.visit_feedback`.
3. Task "Review updated comparison" (idempotency `workflows:feedback:<analysis>:v<n>`).

**Meeting completed → rescore + follow-ups** (`runMeetingChain`, `meeting_chain`, dedupe `meeting:<prep>`). Check result: `meetings.applyOutcome` already creates commitment tasks (`meeting:<prep>:<n>`) and, if chosen, a `meeting_followup` outreach draft, but did **not** rescore (its `interaction_link` insert enqueues `scoring.recalc` without an org → scores nothing). This chain wires `recalcOrg` for the meeting's company and reports the tasks/draft/proposals; it creates no follow-ups of its own.

## Exported services (`service.ts`)
`runSignalChain(db, ws, signalId, {ai?})`, `runLeaseChain(db, ws, leaseId, {ai?, today?})`, `sweep(db, ws, opts)`,
`listRuns`, `runStats`, `getSettings`, `setSettings`. Pure rules in `rules.ts`.

## Jobs (`jobs.ts`, register in `src/lib/jobs/registry.ts`)
`workflows.sweep` — scheduled every tick (dedupe per 5-minute bucket per workspace). Finds signals updated in the last
14 days and leases in window without a run, starts up to 25 of each, and resumes runs `waiting_approval`.
A sweep (not a DB trigger) was chosen: missed ticks catch up, and the unique dedupe key makes overlap harmless.

## Settings
`workspace_setting` key `workflows` → `{ "signal_chain", "lease_chain", "reply_chain", "employer_chain", "feedback_chain", "meeting_chain" }` booleans (missing = on). Switch on `/workflows` (admin).

## Routes
`/workflows` — Automation card (toggles, 30-day counts, "Check now" enqueues a sweep), recent runs with per-step status, reasons and links.

## Migration
`supabase/migrations/20261111001000_workflows.sql` (re-runnable): `workflow_run`, `workflow_step` via `make_business_table`.
`supabase/migrations/20261111001500_workflow_events.sql`: widens `workflow_run.kind` for the four new chains + a lookup index.

## Tests
`npx vitest run src/modules/workflows` — rules; signal chain happy path + idempotency + 30-day quiet period,
do-not-contact, no decision-maker, weak signal; lease chain approval wait/resume, unknowns null, shortlist, comparison,
single task, idempotency, missing rent.

Round 2: `events.db.test.ts` — happy path, idempotent re-run, skip reasons and "nothing sent" for every chain.

## Known gaps
- "Client/prospect" = any non-archived organisation in the workspace (there is no client/prospect flag).
- Adjacent micro-markets = siblings under the same parent geography (no adjacency table).
- Manual lead-priority overrides (`score_override`) are not consulted; the calculated band is used.
- Deals services are called with the service-role client inside the job (they normally take a user client); every query still filters workspace_id.
- Signal chain does not resume after contact research results are approved (new decision-makers are picked up by the next signal or the lease chain).
- Reply chain: no time is parsed from reply text (outreach's classifier has no time field) — only meetings already on record count as "time known".
- Feedback chain: `shortlist_option` has no notes column, so the score/reason live in the workflow step and the comparison's `inputs.visit_feedback`.
- Employer chain: the reconnect draft is created through `draftReconnect` (a `draft`, not an `outreach_item`), so it appears in Drafts/Approvals rather than the Outreach list; with the service-role client its owner is unset (draftReconnect passes no owner).
- Employer sweep re-checks recent first employments each tick (they never start a run); cheap but not free.
