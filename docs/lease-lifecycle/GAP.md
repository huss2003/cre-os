# Module 15 — gap analysis (spec item → existing before → gap → after this build)

| Spec | Existing before (2026-11-12) | Gap | After |
|---|---|---|---|
| §2.1 lease record | `mudar.lease` (tenant/landlord/asset/space, area, rent psf, start, tenure, lock-in, expiry, import `status`) | no reference, category, floor/unit, micro-market, execution/possession/rent-commencement, renewal/termination status, transaction, assignee, contacts | nullable columns added; `createLease`, detail page |
| §2.2 categories | none | 7 categories, per-category tracking | `lease.category` + `CATEGORY_TRACKS` |
| §2.3 14 statuses, evidence | `lease.status` free text (import), radar "active/expired_needs_confirmation" | lifecycle + evidence gate + history | `lifecycle_status`, `checkTransition`, `lease_status_history` |
| §3 terms + history | rent psf/area on lease; toolkit `LeaseTerms` for analyses | full terms, versions, amendments, never overwrite | `lease_term_version` proposed→current→superseded, `diffTerms` |
| §4 critical dates | `lease_event` (expiry/lockin/notice/break/escalation/option, date_basis, confirmed, formula) + brief radar EDATE calc | provenance (clause, doc+page, convention), 5 verification states, human approval, conflicts, alternatives | `lease_date`, `dates.ts`, `confirmDate` (audited) mirrors to `lease_event` |
| §4.2 calculation conventions | `edate` (clamp) in util/time; radar calculated events | from vs after, inclusive, clear/business days, ambiguity → needs_review | `dates.ts` matrix-tested |
| §4.3 dashboard + filters | radar windows | event/company/property/status/owner filters | `/leases` dashboard, `/leases/calendar` |
| §5 renewals | toolkit rvr-1.0 calc; nothing persisted per lease | renewal records, workflow, pipeline, decision support | `lease_renewal`, task on open, `renewalPipeline`, `renewalDecisionSupport` (no recommendation) |
| §6 escalation | toolkit escalation (compounding only in rvr) | basis per clause, schedule, expected vs actual | `escalation.ts`, `escalationView`, financial records |
| §7 lock-in/break/termination | radar lock-in/break events | "lock-in end ≠ termination allowed", break conditions, termination process, deposit | review reasons, `lease_termination`, `depositRecovery` |
| §8 financial | none per lease | cost overview with unknowns, payments only from records | `costOverview`, `lease_financial_record`, `paymentStatus` |
| §9 documents | `legal_document` (intelligence legal, clause extraction, redline), capture docs `routeLease` (lease create proposal) | lease-scoped versions, execution states, page-referenced date extraction, amendments compare | `lease_document`, `extract.ts`, `addDocument` (supersedes, diff) |
| §10 obligations | legal exposure checklist | tracked obligations, party, evidence | `lease_obligation`, tracker page |
| §11 handover | none | configurable checklist | `lease_handover_item` |
| §12 portfolio | radar landlord concentration | compatible-only aggregates, missing flagged | `portfolio()`, `/leases/portfolio` |
| §13 opportunities | signals scan lease/lease_event; brief tasks | potential-only opportunities → orchestrator | `identifyOpportunities`, `lease.opportunity_identified` events; no requirement created |
| §14 reminders | brief deadline48 notifications; orchestrator notify (dedupe, cancelObsolete) | configurable offsets from verified dates, recalc, cancel obsolete | `lease_reminder`, `syncReminders`, `dispatchDueReminders` |
| §15 UI A–F | `/leases` radar only | dashboard, detail, calendar, pipeline, obligations, portfolio | 7 routes; radar kept as tab |
| §16 integrations | signals/scoring triggers on lease; orchestrator lease.* events | M16 import, assistant answers, meeting context, supply | `receiveExecutedLease`, `answerLeaseQuestion`, `leaseContextForOrg`, `alternativeProperties` |

## Remaining gaps (need shared/other-module edits)
- Register `leases` jobs in `src/lib/jobs/registry.ts`; rename nav item "Lease radar" → "Leases" in `src/lib/nav.ts`.
- Assistant tool registration for `answerLeaseQuestion` (assistant module).
- Capture/Input engine: call `addDocument` when a captured lease document is linked to an existing lease.
- Holiday calendar for business-day notices; PDF parsing on the lease page (use Capture OCR).
