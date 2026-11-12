# E2E integration results — MASTER-SPEC Parts 5, 8, 12 (2026-11-12)

Run: `npx vitest run tests/integration` (local stack, WS1/WS2 seeded users, RLS user clients, admin client only for
job entry points, `OPENAI_API_KEY` empty ⇒ mock AI, synthetic Part 9 data tagged with `tag()`).

**Totals: 40 checks — 37 PASS, 3 FAIL.**

| File | Tests | Pass | Fail |
|---|---|---|---|
| `tests/integration/golden-path.test.ts` | 17 | 16 | 1 |
| `tests/integration/workflows.test.ts` | 9 | 7 | 2 |
| `tests/integration/global.test.ts` | 14 | 14 | 0 |

Raw per-step evidence is written to `/tmp/e2e-golden.json`, `/tmp/e2e-workflows.json`, `/tmp/e2e-global.json` on every run.

## Failures (route these)

| ID | Check | Failure detail | Suspected file(s) |
|---|---|---|---|
| G17 | Ask answers a lease question grounded in records | `runAssistant("When does the lease for Helios Software … expire?")` routes to `find_leases_expiring` with the default 12-month window and **whole-workspace** scope ("49 lease(s) expiring by 2027-11-12 … Not filtered by place"). It ignores the named company and never mentions the confirmed 2031-12-31 expiry. Also, after a human confirms the expiry in Module 15, `lease.contractual_expiry` stays **NULL** (only `lease_date` + `lease_event` are updated), so column-based tools can't see it. (`answerLeaseQuestion` and `transaction_question` are grounded and pass.) | `src/modules/assistant/tools/database.ts` (`find_leases_expiring`: no company filter, reads `lease.contractual_expiry`); `src/modules/assistant/engine/router.ts`/`tools/select.ts` (company-specific lease question should resolve the company / use Module 15 `answerLeaseQuestion`); `src/modules/leases/service.ts` `confirmDate` (mirror confirmed expiry to `lease.contractual_expiry`) |
| W6 | Revised quotation → affected transaction identified (Part 5 W6 steps 10–11) | Both versions kept (v1 superseded, v2 current), `commercial.quote_received` published, requirement/analysis dependants marked `needs_refresh` — but the **open transaction on the same requirement/space gets no reassessment mark, no `tx_event`, no notification**. | `src/modules/orchestrator/reassess/workflows.ts` (`reassess.quote` doesn't include `tx_transaction` dependants); `src/modules/transactions/integrations.ts` / `events.ts` (no consumer for `commercial.quote_received`) |
| W13 | Daily plan includes Transaction Execution blockers (W13 step 7) | `runDailyPlan` sections = `todays_meetings, meetings_needing_prep, followups_due_today, overdue_commitments, priority_accounts, new_signals, lease_alerts, deals_attention, pending_approvals, recommended_actions` — **no transaction blockers section** (and `deals_attention` doesn't read `tx_*`). | `src/modules/orchestrator/schedule/plan-builder.ts` (`DAILY_SECTIONS`), `src/modules/orchestrator/schedule/data.ts` (load `transactions.commandView`/blocking issues, overdue approvals, deposits due) |

## Observations (passing, but worth a look)

- **G4 signal chain skips outreach** for a signal ingested from a single press release: `ingestText` grades it `hypothesis / low` evidence, so `workflows.signal_chain` skips the draft ("signals rules need medium/high evidence"). The golden path continued via a direct `createOutreach` (pass). If a company press release should count as medium evidence, look at `src/modules/signals/pipeline.ts` grading.
- **G6 reconfirmation tasks only cover the top 10 ranked options.** Without a hard filter, a stale option ranked behind ~400 unrelated WS1 spaces (needs-verification tier sorts after every eligible one) and got no task. The test now uses `constraints.hard_filters.preferred_only` so the shortlist is realistic; behaviour by design in `src/modules/deals/matching/verify-tasks.ts` (`MAX_VERIFY_OPTIONS`).
- **G13** Module 15 creates two `proposed` term versions on hand-off (`transaction` + `extracted`) — both await human confirmation (correct), but the user sees two.
- **GOV2** four POST routes have no idempotency wrapper; verified read-only calculators (`finance/compare|concessions|financing`, `opportunities/funnel`) and allow-listed.
- **SEC4** direct writes are blocked by DB guards; a colleague's raw `lease_date` update affects 0 rows (RLS ownership), and the owner's direct `tx_approval` status write fails ("decision needs a human decider").

## Golden path — `golden-path.test.ts`

| ID | Step | Result | Evidence |
|---|---|---|---|
| G1 | Signal detected, evidence kept, matched to existing company (no duplicate org) | PASS | signal → existing org, evidence ≥1, org count 1 |
| G2 | Lead score with explanation factors | PASS | score/band + factors |
| G3 | Buying-group roles; Ask `find_decision_makers` | PASS | decision-maker returned |
| G4 | Outreach draft not sent → approve → `mailto:` → user marks sent; follow-up scheduled | PASS (see observation) | draft not sent until user; step-2 follow-up created |
| G5 | Meeting brief → notes → requirement **proposals** → approved → requirement updated; no duplicate requirement; follow-up draft unsent | PASS | seats null → 300 after approval; 1 requirement |
| G6 | Supply match (hard filter, tiered ranking), stale availability → reconfirmation task; re-run no duplicates | PASS | 8 verify tasks, same after re-run; stale option `availability_stale` |
| G7 | Toolkit comparison + Ask `compare_properties` reproducible | PASS | identical ranks/scores across runs |
| G8 | Transaction offer → counter → landlord counter; immutable versions; points agreed with evidence | PASS | v1/v2/v3, `immutable` guard, agreed rent ₹85 |
| G9 | Approvals bound to document version (new version invalidates; only assigned reviewer; stale hash 409) | PASS | owner decide 403, invalidated, reassessment on v2, rent mismatch flagged |
| G10 | Deposit due ≠ paid (paid needs evidence); unapproved commercial figures can't be drafted | PASS | 400 without evidence; comm 409 |
| G11 | Execution → Module 15 hand-off (real); executed ≠ possession ≠ occupancy | PASS | hand-off `delivered`, one lease; possession/occupied false; occupied w/o evidence 400 |
| G12 | Closure blocked while conditions remain; completes after evidence | PASS | 409 early → `completed` |
| G13 | Lease `executed` (not active); dates proposed with clause + method; none confirmed; no reminders; active needs confirmed commencement | PASS | expiry/lock-in/notice dates `extracted`/`calculated` with `edate` method |
| G14 | Human confirms → `confirmed`; reminders via orchestrator notify (in-app `notification`), idempotent | PASS | 7 reminders; sent 1 then 0 |
| G15 | Orchestrator consumes `lease.*` / `transaction.*` events | PASS | 17 processed, 0 failed; notify/dependants/lease_handoff/renewal consumers |
| G16 | Expiry → *potential* opportunity + renewal record; **no requirement created**; no auto-recommendation | PASS | requirements before = after |
| G17 | Assistant answers grounded (lease, transaction, Ask) | **FAIL** | see table above |

## Part 5 workflows

| Workflow | Where | Result |
|---|---|---|
| W1 New company discovery | golden G1–G4 (+ G17 Ask) | PASS (chain outreach-skip observation) |
| W2 New contact discovery | workflows W2 | PASS — duplicate found, matched to company, role, score, unsent draft |
| W3 New information capture | workflows W3 | PASS — same capture on retry key, nothing written before Review, 1 interaction + requirement/proposal after Review, no external outbox |
| W4 Meeting prep & follow-through | workflows W4 + golden G5 | PASS — prep job due exactly 1 h before start, idempotent; brief has company, requirement, signal, attendee |
| W5 New property requirement | golden G5–G7 | PASS |
| W6 New property quotation | workflows W6 | **FAIL** (transaction not flagged) |
| W7 Client shortlist | golden G6–G7 | PASS |
| W8 Property rejection | workflows W8 | PASS — option `rejected`, comparison re-versioned without it, review task |
| W9 Negotiation | golden G8–G10 | PASS |
| W10 Agreement execution | golden G9, G11–G12 | PASS |
| W11 Lease expiry & renewal | golden G13–G16 + workflows W11 | PASS — lease chain proposes requirement (waiting approval), unknowns null, idempotent |
| W12 Contact employment change | workflows W12 | PASS — old employment kept (not current), opportunity stays, review task, draft unsent |
| W13 Daily business plan | workflows W13 | **FAIL** (no transaction blockers) |
| W14 Failed background process | workflows W14 | PASS — temporary retried after backoff, done steps kept, no duplicate rows, permanent → failed with "Fix the cause shown, then use Retry." |

## Part 8 global checks — `global.test.ts`

| ID | Check | Result |
|---|---|---|
| SEC1 | Cross-workspace reads (org, person, requirement, transaction, lease, draft) | PASS — 0 rows for WS2 user |
| SEC2 | Cross-workspace insert/update | PASS — RLS violation; row unchanged |
| SEC3 | Search + assistant retrieval permissions | PASS — no WS1 hits/ids for WS2 user |
| SEC4 | Approval bypass (direct tx_approval / lease_date writes) | PASS |
| SEC5 | Audit history integrity (no edit/delete) | PASS |
| SEC6 | Malicious source content stays evidence | PASS — no drafts sent, no membership, no external outbox |
| GOV1 | No external send API anywhere in `src` | PASS (976 files scanned) |
| GOV2 | Mutating `/api/v1` routes idempotent | PASS (129 routes; 4 read-only calculators allow-listed) |
| AUT1 | Duplicate event delivery, re-ingest, re-score | PASS |
| AI1 | Mock mode + deterministic comparison | PASS |
| DQ1 | Unknown stays unknown (CAM null; missing area basis ⇒ needs verification) | PASS |
| DQ2 | Alternate company names (alias) → existing company | PASS |
| DQ3 | Offers never deleted; timeline append-only | PASS |
| PERF1 | List/search ≤ 2 s, shortlist ≤ 15 s on WS1 (3.3k orgs, 945 spaces, 779 leases, 9k tasks) | PASS — orgs 122 ms, search 786 ms, leases 113 ms, tx 5 ms, tasks 327 ms, shortlist 380 ms |

## Part 12 acceptance criteria → checks

| Criterion | Covered by | Status |
|---|---|---|
| DATA: stable identities, no uncontrolled duplicates | G1, G5, W2, DQ2, AUT1 | PASS |
| DATA: history preserved; source-linked; unknown represented | G8, G13, W6 (versions), W12, DQ1, DQ3 | PASS |
| INTELLIGENCE: signals evidenced; scoring explained; facts vs assumptions | G1, G2, G16 (no auto-recommendation), W11 | PASS |
| PROPERTY: matching explainable; availability traceable; comparisons reproducible; quotations preserved; lease calcs validated | G6, G7, AI1, W6, G13 | PASS |
| TRANSACTIONS: offers versioned; approvals enforced; executed terms reconciled; lease transferred | G8–G12 | PASS |
| AUTOMATION: schedules, events, retries, duplicates, failures visible, pause/resume | G14, G15, W4, W14, AUT1 | PASS (pause/resume only on running executions — a failed run can't be paused, by design) |
| USER EXPERIENCE: Today works | W13 | **FAIL** (transaction blockers missing) |
| USER EXPERIENCE: Ask works | G3, G7, G17 | **PARTIAL** — tools pass, company-specific lease question fails |
| USER EXPERIENCE: Capture / Review works | W3, G5 | PASS |
| GOVERNANCE: permissions, approvals, manual external comms, audit | SEC1–6, GOV1–2, G4, G10 | PASS |
| TESTING: all 14 workflows pass | this file | 12/14 PASS (W6, W13 fail) |

## Not covered at service level
UI at 375 px, voice/OCR accuracy measurement (8.6), large uploads, concurrent multi-user load and external connector
outages beyond the orchestrator's simulated temporary/permanent errors.
