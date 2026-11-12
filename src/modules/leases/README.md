# Module 15 — Lease Lifecycle Management (`src/modules/leases`)

Spec: `docs/lease-lifecycle/SPEC.md`, user rules `docs/integration/USER-RULES.md`, gap analysis `docs/lease-lifecycle/GAP.md`,
Module 16 hand-off `docs/lease-lifecycle/CONTRACT.md`. Migration `supabase/migrations/20261112000200_lease_lifecycle.sql`.

## Principles
- **Code first for contractual dates** (USER-RULES #1). `extract.ts` finds clauses + page refs with patterns; `dates.ts` does
  all arithmetic with explicit conventions. AI is backup only (`runWithPolicy`, feature `capture.lease_terms`): it may only
  point to page + verbatim snippet; snippets are verified against the page and re-parsed by code.
- Every date row (`mudar.lease_date`) stores: source clause text, document + page, method, convention, calculated date,
  alternatives, verification status `extracted | calculated | needs_review | confirmed | conflicting`.
- **Only `confirmDate` (a human action, audited) makes a confirmed contractual deadline.** Needs-review/conflicting dates
  require the reviewer to pick the date. Confirmed dates are mirrored to `mudar.lease_event` (contractual, confirmed) so the
  brief radar and signal engine use them.
- Evidence-gated statuses (`status.ts`): never auto-executed (needs signed/executed doc + execution date) or auto-active
  (needs a confirmed commencement/possession date). Drafts/unsigned proposals never become executed; their dates are needs_review.
- History is never overwritten: `lease_term_version` (proposed → current → superseded), document versions (`supersedes_id`),
  superseded dates kept (`superseded_by`), `lease_status_history`, audit triggers on every table.
- Unknown stays unknown: costs/portfolio totals use known compatible values only and list exclusions; payment status only
  from `lease_financial_record` (user-verified / connected).
- Expiry ≠ relocation: opportunities are `label: "potential"` events; no requirement is ever created.

## Files
| File | What |
|---|---|
| `dates.ts` | addMonths (EOM clamp / EOM-to-EOM), periodEnd, effectiveAfter, noticeDeadline (before / within / clear days / business days), periodFromClause, parseDuration |
| `escalation.ts` | compounding / on_original / fixed_amount / schedule / unknown basis; expected vs actual |
| `extract.ts` | statedDates, findClauses, obligations + responsible party, buildExtraction, extractWithPolicy |
| `status.ts` | 14 statuses, categories (+ per-category tracked dates), transitions, evidence gate |
| `planning.ts` | reminders plan, conflicts, portfolio aggregates, cost overview, opportunities, default handover checklist |
| `service.ts` | DB layer (see exported services) |
| `assist.ts` | `answerLeaseQuestion` — grounded answers for the §16 assistant questions |
| `jobs.ts` | `leases.daily` |
| `actions.ts`, `ui.tsx` | server actions, tabs/badges |

## Exported services (other modules may call)
- `receiveExecutedLease(w, transactionId, input)` — **Module 16** (CONTRACT.md).
- `getLease`, `listLeases`, `upcomingDates`, `portfolioView`, `renewalPipeline`, `obligationTracker`, `escalationView`, `leaseCost`.
- `leaseContextForOrg(w, orgId, today)` — Module 7 meeting briefs / Module 5 outreach context (confirmed flags + sources).
- `renewalDecisionSupport(w, leaseId, …)` — reuses Module 8 `compareRenewalRelocation` (rvr-1.0); `recommendation` is always null.
- `alternativeProperties(w, leaseId)` — Module 14 supply (availability → space → asset via RLS).
- `addDocument(w, leaseId, {pages|text, docType, executionState})` — **Module 10 input engine** should call this for documents
  linked to an existing lease (creates lease_document + proposed lease_date/obligation/term rows).
- `answerLeaseQuestion(w, question, today, {leaseId?})` — Module 12 assistant tool.
- `scanOpportunities(w, today)` — publishes `lease.opportunity_identified` events (deduped).

## Events (orchestrator `event_outbox`)
`lease.created` / `lease.changed` (existing DB trigger), `lease.executed_received`, `lease.renewal_agreed`,
`lease.termination_notice_recorded`, `lease.opportunity_identified`. Notifications: category `lease_deadline` via
`orchestrator/notify` (`notifyUser`, dedupe = reminder key, `cancelObsolete` on cancelled reminders).

## Job types
`leases.daily` (06:30 local): resync reminders, dispatch due reminders, publish potential opportunities.
**Not yet registered** — `src/lib/jobs/registry.ts` is shared: add `import * as leases from "@/modules/leases/jobs"` and include it in `modules`.

## Routes
`/leases` (dashboard; old `?lease=`/`?id=` links redirect to detail, `?window=`/`?review=` to the radar tab), `/leases/new`,
`/leases/[id]`, `/leases/calendar`, `/leases/renewals`, `/leases/obligations`, `/leases/portfolio`, `/leases/radar`
(the brief module's radar, moved unchanged into a tab).

## Settings
`workspace_setting` key `leases.reminder_offsets` — `{ "<date_type>": [days…] }` overrides `DEFAULT_OFFSETS`.

## Tests
`calc.test.ts` (date matrix, escalation, extraction, status, planning — pure) and `lifecycle.db.test.ts` (the 30 §18
scenarios + Module 16 hand-off; WS1, mock AI). `npx vitest run src/modules/leases`.

## Known gaps
- PDF/scan text comes from Capture (OCR) — the lease page accepts text/paste only.
- Public-holiday calendars are not modelled: business-day results are always `needs_review`.
- Assistant/registry/nav wiring lives in shared or other-module files (see report); `answerLeaseQuestion` is ready to register.
- Canonical `mudar.lease` material fields (start_date, contractual_expiry…) are not rewritten by confirmations (approval
  guard); `lease_date` + the mirrored `lease_event` are the source of truth for lifecycle dates.
