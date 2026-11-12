# Integration audit — master spec Parts 4, 6, 7, 10 (2026-11-12)

Status: DONE = implemented with evidence; PARTIAL = works with a stated gap; MISSING = not built.
"(this pass)" = implemented in the integration pass.

## Part 4 — shared entities and events
| Requirement | Evidence | Status |
|---|---|---|
| 4.1 shared entities (26) with stable id, created/updated, ownership, source refs, verification, history | `make_business_table` `supabase/migrations/20261031000100_core_platform.sql:180` (id, workspace_id, owner, classification, timestamps, row_version, archived_at, RLS, audit); fact_status columns in core_domain; history tables (availability append-only, lease_term_version, tx_offer immutable versions, opportunity_stage_history) | DONE |
| Entities Floor/Unit | modelled as `space` under `asset` (campus>tower) | PARTIAL (no separate floor table; floor is a space attribute) |
| 4.2 common event mechanism | `event_outbox` `20261111001700_orchestrator_core.sql:90`, `publishEvent` `src/modules/orchestrator/events/publish.ts` | DONE |
| 4.2 envelope: source module, actor, correlation id, permission context | `20261112000500_integration.sql` (columns + `event_contract_fill` trigger), `PublishInput` (this pass) | DONE (this pass) |
| 4.2 no sensitive data in payloads | publishers send ids + summaries only (`transactions/events.ts record`, lease events) | DONE |
| 4.2 event names | `docs/integration/EVENTS.md` catalogue + name mapping | DONE (names differ from examples; mapping documented) |
| 4.3 async / idempotent consumers / safe retry / visible failures / inspectable history | `events/process.ts` (`event_processing_log` unique, MAX_EVENT_ATTEMPTS=5, status failed), /automation views | DONE |
| 4.3 transaction.* and lease.* consumers | `events/process.ts` CONSUMERS + `events/tx-lease.ts` (this pass) | DONE (this pass) |
| 4.3 material updates trigger reassessment | reassess.* workflows; quote → transactions flag `transactions/integrations.ts flagTransactionsForQuote` (this pass) | DONE |

## Part 6 — synchronisation
| Rule | Evidence | Status |
|---|---|---|
| 6.1 company → intel / signals / scores / buying group / assistant | company.* → reassess.record_changed (recalcOrg) `orchestrator/reassess/records.ts`; assistant reads live tables | PARTIAL (signals/buying-group re-run on their own schedules, not per event) |
| 6.2 contact → employment history, buying group, scores, tasks | employment_changed → reassess.employment + employer_chain | DONE |
| 6.3 requirement → history, readiness, matching, comparisons, affected transactions | reassess.requirement; `commercial.requirement_changed` → `transactions` consumer `flagTransactionsForRequirement` (`transactions/integrations.ts`): open transactions on the requirement get a `review` mark + `requirement_changed` timeline entry + owner notice, agreed terms untouched (test: `orchestrator/reassess.db.test.ts` "Spec 6.3") | DONE |
| 6.4 property → inventory, comparisons, affected offers, notify | quote_received → reassess.quote + transaction flag (this pass) | PARTIAL (availability snapshot changes are not an event) |
| 6.5 lease → milestones, reminders, signals, scores, assistant | lease.* → dependants + lease_chain; leases.daily resync reminders (registered this pass); confirmed expiry mirrored to `lease.contractual_expiry` (`mudar_app.lease_mirror_confirmed_expiry`, this pass); assistant `lease_question` (this pass) | DONE |
| 6.6 transaction → events, dependants, toolkit, lease hand-off, intel, assistant | tx_event timeline + transaction.* events; consumers notify/re-score/hand-off retry (this pass); deal health reads tx issues/approvals `scoring/features.ts dealHealth` (this pass); assistant `transaction_blockers` / `transaction_question` (this pass) | DONE |

## Part 7 — approval, evidence, quality
| Requirement | Evidence | Status |
|---|---|---|
| 7.1 one review queue | `/approvals` (change proposals, drafts, documents, captures, imports, conflicts, stale, outdated, failed jobs) + transaction approvals for me, lease dates needing review, proposed lease terms (`orchestrator/ui/integration-sections.ts reviewIntegrationSections`, this pass); the Review menu badge counts all of them (`app/(app)/layout.tsx loadBadges`, same filters) | PARTIAL (tx approvals / lease dates are listed and link to their module for the decision, not decided inline) |
| 7.1 item shows what/why/source/affected/confidence/impact/action; approve/edit/reject/defer/inspect | `modules/changes/ui/proposal-card` | DONE for change proposals |
| 7.2 evidence fields | fact_status/source_object/evidence_ids; lease_date clause/page/method/status; signal evidence_tier | DONE |
| 7.3 audit history (who/what/old/new/source/time/approval) | `audit_event` generic trigger; change_proposal + approval | DONE |
| 7.4 safe undo, no overwrite of later update | changes reverse with row_version checks (`20261031001100_changes_apply_reverse.sql`) | DONE |
| 7.5 permissions incl. search, AI answers, exports | RLS everywhere; assistant tools use ctx.db + ws filter; `tests/security/*` | DONE |
| 7.6 error handling explains failure | StaleBanner / unavailable sections; event + workflow failures visible | DONE |
| 7.7 untrusted content as data | gateway `evidence` field `src/lib/ai/gateway.ts:61`; capture routes never act on document text | DONE |
| No outbound send anywhere (S3) | grep of fetch/SMTP/Twilio/LinkedIn/WhatsApp: only Gmail **read** + watch subscription (`integrations/providers/google.ts`, `push.ts`), Anthropic API, internal routes. Drafts only. | DONE |

## Part 10 — technical
| Requirement | Evidence | Status |
|---|---|---|
| Migrations for DB changes | `supabase/migrations/*` (this pass: `20261112000500_integration.sql`, re-runnable) | DONE |
| Structured APIs; backend validation; idempotent mutations | `/api/v1/*` via `route(..., {requireIdempotency})`, `dealsRoute/txRoute({mutation:true})`; audit: every mutating route requires Idempotency-Key except 4 pure calculators (`finance/compare`, `finance/concessions`, `finance/financing`, `opportunities/funnel` — no writes) | DONE |
| AI separate from deterministic logic (dates, money, status, approvals) | lease dates code-first `leases/dates.ts`; finance `decimal.js`; S4 risk in code | DONE |
| Async long-running work, reliable jobs | Postgres queue `mudar_app.enqueue_job/claim_jobs`; leases.daily now registered (`src/lib/jobs/registry.ts`, this pass) | DONE |
| Logs/audit; meaningful errors | audit_event, model_usage, workflow_run | DONE |
| Model routing + usage per module/workflow; multi-provider | gateway tiers luna/sol + `model_usage`; assistant fast/deep; OpenAI + Anthropic | DONE |
| Specialised OCR/transcription | gateway extractImageText / transcribe | DONE |

## Wiring done in this pass (Part A)
registry (leases jobs) · nav (Leases section with tabs, Buildings → Supply tab, Transactions under Work, Intelligence/Automation under More) ·
assistant tools `lease_question`, `transaction_blockers`, `list_transactions`, `transaction_question`, `match_requirement_supply`,
`find_alternative_space`, `find_intro_paths` + groups + intents (available_space, transactions, intro_paths, priority "which companies should I approach") ·
capture lease-family docs linked to a lease → `leases.addDocument` (dates never confirmed), linked to a transaction → `tx_intake` (review) ·
Today "Active transactions" + "Important lease events" · daily plan `transaction_blockers` section · Review sections · admin evidence-trail plain words ·
deal health reads transaction blockers/approvals.

## Known gaps
- Capture drop-zone UI has no lease/transaction picker yet (form keys `lease_id` / `transaction_id` are accepted).
- Review count badge in nav does not include transaction approvals / lease dates.
- `confirmDate` run by a job (no auth.uid) cannot mirror to `lease.contractual_expiry` (by design: human-only).

Capture upload: the "Link to a record" panel has Lease and Transaction pickers (`EntityPicker` kinds `lease`/`transaction`, lookup `assistant/notes/lookup.ts`, `/api/v1/assistant/notes/lookup`). UI copy says "Leases" instead of "Lease radar" (Today, Today details, /tasks; tutorial captions unchanged).
