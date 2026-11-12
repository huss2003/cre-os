# Module 16 — Transaction Execution & Negotiation (`/transactions`)

Spec `docs/transactions/SPEC.md`, gap analysis `docs/transactions/GAP.md`. Module 8 (toolkit) evaluates, Module 16 executes and
coordinates, Module 15 (leases) monitors after execution (USER-RULES 2). All maths comes from toolkit nego-1.0 / fin-1.0.

## Built
- §2/§3 transaction (unique code, client/req/deal/properties/owner, history), 16-section workspace page, 7 types + configurable templates (`tx_stage_template`, any new type).
- §4 offers/counteroffers: immutable versions (DB trigger), parent links, reason required, response status, hash; version diffs via toolkit `diffOffers`.
- §5 `comparePackages` → toolkit `analyseNegotiation`; incomplete inputs → "cannot determine" + missing/assumptions/not-modelled. Spec Offer A/B never resolves to B on headline rent.
- §6 `tx_position` (client requirement / adviser recommendation / counterparty proposal), kind and value immutable; client positions only from client-confirmed requirement fields.
- §10.3 `tx_commercial_point` 8 statuses; agreeing needs evidence; agreed values never overwritten (superseded); "verified" only against an executed agreement that reconciles.
- §7 issues (owner, next action, due date or reason, blocking, dependencies, overdue, linked task); §8 inspections, clarifications vs requirement (discrepancy), document requests (received ≠ verified, DB check).
- §9 stakeholders (17 categories, authority, internal/external, pending actions as tasks, blocking).
- §10/§11 LOI / term sheet / agreement versions (`tx_document`, immutable, sha256); deterministic clause diff (added/removed/modified, dates, money, obligations) and reconciliation vs agreed terms.
- §12 `tx_approval` (8 categories, 7 statuses) bound to subject hash; DB guard: only the assigned reviewer decides, on the current hash; legal only by a legal-reviewer stakeholder; new doc version / changed commercial position invalidates and reassessments are opened. Approvals are owned by the reviewer (standard owned/shared RLS).
- §12.4 `draftCommunication`: commercial terms require live client-commercial approval of the current position and every figure must be approved; drafts only (S3).
- §13 deposits (each stage separately, paid needs evidence, ack needs receipt); milestones (8 distinct kinds, each with evidence; legally approved needs a legal reviewer decision; executed needs an executed agreement).
- §14 fit-out, handover checklist/defects (closing needs evidence). §15 `commandView`. §16 closure pack DOCX (`document_version` purpose `transaction_closure_pack`); completion blocked by `mudar_app.tx_closure_blockers` (DB trigger).
- §17: orchestrator events `transaction.*` (offer_received, counteroffer_created, offer_expiring, issue_overdue, approval_pending, document_version_changed, material_term_changed, executed, possession_approaching, handover_incomplete); job `transactions.scan` daily; intake (`tx_intake`, mock = pattern extraction, review before records); meeting context/outcomes; relationship memory; property supply (shortlist, read-only); Module 15 `receiveExecutedLease` on execution (`lease-handoff.ts`, idempotent, pending state stored if it fails); assistant answers (`integrations.answer`, tools in `assistant-tools.ts`).

## Routes
Pages `/transactions`, `/transactions/[id]`, download `/transactions/[id]/closure-pack/[doc]`. API `/api/v1/transactions` (GET/POST), `/[id]` (GET command view), `/[id]/[action]` POST offers|compare|issues|approvals|documents|communications|milestones|intake|closure-pack|complete (Idempotency-Key), GET timeline|offers|positions|ask?q=.

## DB
Migration `supabase/migrations/20261112000300_transactions.sql` (re-runnable; apply with `psql -1`). 19 `tx_*` tables via make_business_table. SECURITY DEFINER: `tx_guard`, `tx_approval_guard` (trigger fns, execute revoked).

## Tests
`transactions.test.ts` (pure), `transactions.db.test.ts` (§19 scenarios 1–37), `handoff.db.test.ts` (real Module 15).

## Known gaps / for the lead
- Register `transactionTools` (assistant-tools.ts) in `src/modules/assistant/tools/index.ts`.
- An editor who requests an approval for another reviewer cannot read the approval row afterwards (owned by reviewer); owners/admins see all.
- Agreement diff/extraction is pattern-based (numbered clauses, ₹/SF phrasing); AI suggestions layer not added.
- No orchestrator consumers registered for `transaction.*` events (they are stored in the outbox).
