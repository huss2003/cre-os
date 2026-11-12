# Module 16 — Transaction Execution & Negotiation: gap analysis

Inspected 2026-11-12: deals (requirements, opportunity + `opportunity_stage_history`, `deal_milestone` closing checklist,
quotes, fees, documents/`document_version`), toolkit (`calc/negotiation.ts` nego-1.0, `talking-points.ts`),
`change_proposal`/`approval` (changes module), drafts (`src/lib/services/drafts.ts`, hash-bound approval, manual send),
orchestrator (`publishEvent`, `registerConsumer`), intelligence/meeting tables (`objection_log`, `decision_log`,
`concession_step`, `meeting_visit`), Module 15 (`src/modules/leases/**`, `docs/lease-lifecycle/CONTRACT.md`).

## Before (what existed)
| Spec § | Existing | Gap |
|---|---|---|
| §2 workspace | `opportunity` (stage, owner, next action), `requirement`, `stakeholder` (per requirement), closing checklist (`deal_milestone`) | No transaction entity/ID, no 16-section workspace, no chronological transaction timeline |
| §3 types/templates | `requirement.transaction_kinds`, single `CLOSING_TEMPLATE` | No 7 transaction types, no per-type configurable stage templates |
| §4 offers | `quote` (versioned, immutable, superseded_by); toolkit nego-1.0 `diffOffers`/`analyseNegotiation` (pure, saved analyses) | No transaction-linked offer/counteroffer chain with parties, validity, response status, reason, hash |
| §5 concessions | toolkit `valuePackages`, `analyseNegotiation` (fin-1.0) | Not wired to transaction offers; no "missing components" view when area/tenure unknown |
| §6 positions | requirement field statuses (client_confirmed vs estimated) | No separate adviser-recommendation / counterparty-proposal records |
| §7 issues | `task` (owner, due, depends_on) | No issue categories/statuses, next action, no-due-date reason, blocking, dependencies list |
| §8 inspections/docs | toolkit site-visit pack | No inspection records, technical clarifications vs requirement, document requests (received ≠ verified) |
| §9 stakeholders | `stakeholder` (requirement-level roles) | No transaction-level 17 categories, decision authority, internal/external, pending actions |
| §10 LOI/term sheet | closing checklist items | No LOI/term-sheet versions, no commercial point tracker (8 statuses) |
| §11 agreement diff | `document_version` lineage (generated files) | No clause-level diff, no reconciliation vs agreed terms, no legal-review routing |
| §12 approvals | `approval` (hash-bound; subject_type check limited to change_proposal/draft/document_version/quote/finance_scenario; decision approved/rejected/clarify) | No 8 categories, 7 statuses, assigned reviewer, deadline; cannot extend core check constraint (core table) |
| §13 deposits/execution | `fee_milestone` is the adviser's fee, not deposits | No deposit lifecycle (proposed…refunded), no execution record |
| §14 possession/fit-out/handover | — | Missing |
| §15 command view | `/deals/[id]` | No consolidated command view |
| §16 closure pack | docx builders (deals documents) | No closure pack, no completion block |
| §17 integrations | orchestrator events (no transaction.* types), drafts, meetings, capture/input engine, Module 15 not present | All transaction hooks missing |

## Design decision
Reuse: `requirement`, `opportunity` (link + "Open transaction" from deals), `quote` (offer may reference `quote_id`),
`stakeholder`/`person`/`organisation`, `task` (issue/stakeholder pending actions), `draft` (communications; manual send),
`document_version` (closure pack docx), `event_outbox` (orchestrator), toolkit nego-1.0 (all maths), audit trigger.
New `tx_*` tables only for what is missing (migration `20261112000300_transactions.sql`).
`approval` cannot carry the 8 categories/7 statuses/reviewer/deadline without altering its core check constraint, so
`tx_approval` holds them, bound to an exact subject hash.

## After
See `src/modules/transactions/README.md` — every row above is covered; remaining gaps are listed there.

## After (2026-11-12)
All rows above are implemented in `src/modules/transactions/**` + `/transactions` pages + migration `20261112000300_transactions.sql`.
Remaining: assistant tool registration (lead), AI clause-suggestion layer, orchestrator consumers for `transaction.*` events.
