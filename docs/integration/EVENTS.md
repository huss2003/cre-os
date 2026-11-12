# Event contracts (master spec Part 4.2 / 4.3)

Transport: transactional outbox `mudar.event_outbox` (migration `20261111001700_orchestrator_core.sql`, contract columns
added by `20261112000500_integration.sql`). Publish from code with `publishEvent()` (`src/modules/orchestrator/events/publish.ts`)
or from DB triggers with `mudar_app.orch_emit` (same transaction as the business write). Consumers live in
`src/modules/orchestrator/events/process.ts` (`CONSUMERS`), run by `orchestrator.dispatch` every tick.

## Envelope (every event)
| Spec field | Column | Filled by |
|---|---|---|
| Event ID | `id` | DB default |
| Event type | `event_type` | publisher |
| Entity type / ID | `subject_type`, `subject_id` | publisher |
| Timestamp | `occurred_at` | DB default |
| Source module | `source_module` | `publishEvent({sourceModule})` or trigger `event_contract_fill` (type prefix) |
| Actor | `actor_user_id` | `auth.uid()` at insert (null for jobs/service role) |
| Payload | `payload` | publisher — ids + short summary only, no contact details / document bodies |
| Correlation ID | `correlation_id` | `publishEvent({correlationId})`; root event = its own id |
| Idempotency key | `dedupe_key` (unique per workspace) | publisher; duplicate insert only bumps `duplicate_count` |
| Permission context | `classification` + `workspace_id` (RLS via `make_workspace_table`) | default `corporate_confidential` |

## Processing rules (4.3)
- Async: outbox → `processEvents` (orchestrator tick). Never browser-triggered.
- Idempotent consumers: `event_processing_log` unique (event, consumer); only a failed attempt is re-claimed.
- Retry: up to 5 attempts, then `failed` (visible on /automation + failure notifications).
- Inspectable: event history + per-consumer log rows (`detail`, `run_id`, routed status).
- Events with no consumer are kept as `ignored` (history stays).

## Catalogue (implemented names; spec example names in brackets where they differ)
| Event | Published by | Consumers |
|---|---|---|
| company.created / company.updated | organisation trigger | `dependants` → reassess.record_changed (re-score) |
| contact.created / contact.info_added | trigger | `dependants` |
| contact.employment_changed [contact.employer_changed] | trigger | `review` (reassess.employment), `reengage` (workflows.employer_chain) |
| research.signal_detected [signal.detected] | trigger | `chain` (workflows.signal_chain) |
| commercial.quote_received [property.quotation_received] | trigger | `reassess` (reassess.quote), `transactions` (flag open transactions on same requirement/space: mark + timeline + notify; agreed terms untouched) |
| commercial.requirement_changed [requirement.updated] | trigger | `reassess` (reassess.requirement) |
| meeting.scheduled / rescheduled / cancelled / completed | meeting_visit trigger | prep scheduling, meeting chain |
| lease.created / lease.changed | lease trigger | `dependants` (re-score, flag analyses), `renewal` (workflows.lease_chain) |
| lease.executed_received / lease.renewal_agreed / lease.termination_notice_recorded | `leases/service.ts` | `notify` (lease owner), `dependants` |
| lease.opportunity_identified | `leases/service.ts scanOpportunities` | `notify` (labelled potential) |
| transaction.stage_changed [transaction.stage_changed] | `transactions/service.ts advanceStage` | `notify`, `dependants` |
| transaction.offer_received / counteroffer_created [offer.created / offer.revised] | `createOffer` | `notify` |
| transaction.approval_pending [approval.requested] | `requestApproval` | `notify`, `dependants` (deal health) |
| transaction.material_term_changed / document_version_changed | points / documents | `notify` (+ `dependants` for material) |
| transaction.offer_expiring / issue_overdue / possession_approaching / handover_incomplete | `transactions.scan` daily | `notify` (urgent for expiring/overdue/approval/handover) |
| transaction.executed | milestone executed | `notify`, `dependants`, `lease_handoff` (Module 15 hand-off retry; also swept daily by transactions.scan) |
| integration.failed / integration.recovered [workflow.failed] | connector triggers | health reassessment |

Not emitted as separate names (covered by the rows above): `property.created`, `property.availability_changed`
(availability snapshots are append-only; supply status computed on read), `interaction.created`, `meeting.processed`,
`score.recalculated` (score history table), `approval.completed` (change_proposal / tx_approval state + audit),
`lease.expiry_approaching` / `lease.escalation_approaching` (lease reminders → `notifyUser` category `lease_deadline`),
`document.uploaded/processed` (capture_document status), `workflow.failed` (workflow_run status + notifyFailures).
