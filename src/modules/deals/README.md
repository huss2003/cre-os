# deals module

Requirements, matching/shortlists, quotes, finance engine, documents, pipeline, closing coordinator, fees and
official-CRM export proposals. Spec: Part I §6, §8, §11, §12; Part II §5–6; Part III API + acceptance tests
(Shortlist, Finance, Editable artifacts, Official CRM conflict).

## Routes
Pages (all mobile-first, empty states explain the next step): `/requirements` (list, `/new`, `/[id]`), `/deals` (board on
desktop, stage-grouped list on mobile, `/[id]`), `/finance` (list + new scenario, `/[id]` results, sensitivities,
concession equivalence), `/documents` (generate / freshness / approve / release / download), `/fees` (separate money
stages, fee protection, funnel calculator). Writes use Server Actions in `actions.ts`.

API (`/api/v1`, mutations need `Idempotency-Key`; first response is replayed via `deal_idempotency`):
| Method & path | Purpose |
|---|---|
| `GET/POST /requirements` | list / create (fields saved as estimates unless marked confirmed) |
| `GET/PATCH /requirements/{id}` | detail (missing questions, completeness, stakeholder gaps) / field edits — confirmed fields return change proposals |
| `POST /requirements/{id}/confirm` | client confirmation (all mandatory fields confirmed + evidence; enforced in SQL) |
| `GET/POST /requirements/{id}/shortlist` | latest / run match-v1 and store a new shortlist version |
| `POST /requirements/{id}/stakeholders` | stakeholder map |
| `GET/POST /requirements/{id}/quotes`, `POST …/quotes/{quoteId}/revise` | versioned quotes |
| `POST /finance/evaluate` | engine fin-1.0 (optionally saved with cash flows + output hash) |
| `POST /finance/compare`, `/finance/concessions`, `/finance/financing` | equal-horizon comparison, concession equivalence, financing offers vs cash (pure) |
| `POST /finance/scenarios/{id}/approve` | admin; re-runs engine, refuses stale quotes |
| `POST /documents/generate`, `GET /documents`, `GET /documents/{id}/download`, `POST /documents/{id}/{approve,release,status}` | design studio + release guard |
| `GET/POST /opportunities`, `GET/PATCH /opportunities/{id}`, `POST …/{stage,outcome,fees,checklist,crm-export}`, `POST /opportunities/funnel` | pipeline |

## Services (import from other modules only these)
- `requirements/contract.ts` (pure): `REQUIREMENT_FIELDS`, `missingQuestions`, `requirementCompleteness`, `confirmationBlockers`, `stakeholderGaps`.
- `requirements/service.ts`: `createRequirement`, `updateRequirementFields`, `confirmRequirement`, `setNotApplicable`, `addStakeholder`, `getRequirementDetail`.
- `matching/match.ts` (pure, `match-v1`) + `matching/service.ts`: `runShortlist`, `setOptionStatus`.
- `finance/engine.ts` (pure, `fin-1.0`): `evaluate`, `compareScenarios`, `sensitivities`, `concessionEquivalence`, `compareFinancingOffers`.
- `pipeline/stages.ts` (pure): `checkTransition`, `checkOutcome`, `CLOSING_TEMPLATE`, `funnel`. `pipeline/service.ts`: opportunity CRUD, stage/outcome, checklist, fees.
- `fees/fees.ts` (pure): `feeSummary`, `feeProtectionIssues`. `crm/export.ts`: `detectConflicts`, `proposeCrmExport`, `recordExternalSnapshot`, `markExported`.
- `quotes/service.ts`: `createQuote`, `reviseQuote`, `quoteLeakageCheck`. `documents/service.ts`: `generateDocument`, `stalenessReasons`, `approveDocument`, `releaseDocument`, `downloadDocument`.
All services take a `DealsCtx` with a **user-scoped** client; the module never uses the service role.

## Finance engine (fin-1.0)
Period 0 = base date; recurring items fall in periods 1..H. Costs positive, refunds/inflows negative. Monthly rate
`r_m = (1+r_a)^(1/12) − 1`; NPV = Σ C_t/(1+r_m)^t; equivalent monthly = NPV / Σ_{t=1..H}(1+r_m)^−t (NPV/H at 0 %).
Rent = rate × billing area/seats; escalation steps at lease month `every+1` (never monthly); rent-free optionally
waives CAM; CAM none/fixed/per-SF/mixed; parking; deposit out at payment and back at contractual refund (beyond the
horizon → PV at H); capex, landlord support, reinstatement; financing as client cash view (draw offsets capex, then
interest + principal; fees, lender deposit, residual buyout, early settlement) — never double-counted; parallel
rent / move / brokerage; GST only when a rate is supplied (warning otherwise). Tenure shorter than the horizon must
say `afterTenure` explicitly; comparisons refuse unequal horizon/base date/discount rate/currency. Decimal.js only,
amounts rounded per category-period to paise, `outputHash` = sha256 of engine version + input + results.
Tests hand-compute zero discount, 12 % control, escalation boundary, deposit/refund, rent-free vs CAM, mixed CAM,
financing reconciliation and equal horizons (`finance/engine.test.ts`).

## Shortlist exports / documents
`shortlist_deck` (PPTX, pptxgenjs), `proposal` and `market_note` (DOCX), `comparison_xlsx` (XLSX with real
formulas: per-month Total/discount factor/PV and TCO/NPV/annuity/equivalent-monthly formulas; the Comparison sheet
shows formula NPV, engine NPV and the difference — `documents/builders.test.ts` evaluates the formulas and
reconciles them to the engine). Brand (name, colours, font, disclaimer) comes from the tenant's `template_asset`
(`purpose`, `kind`, `brand_json`); none configured → neutral built-in layout, flagged. Files are stored at
`workspace-files/<ws>/documents/<doc>.<ext>`; `document_version` records sha256, template id/version and
`input_versions` {requirement row_version, quotes version, scenarios output_hash, shortlist version, availability as_of}.
Staleness (requirement edited, quote superseded/expired, scenario recalculated, availability past validity or newer
snapshot) blocks approval/release; release also runs the quote-leakage check and records the recipient. Nothing is
sent: the user downloads and shares manually (S3).

## Database (migration `20261031001300_deals.sql`, re-runnable)
Tables: `requirement_version`, `shortlist_version`, `deal_milestone`, `objection_log`, `concession_step`,
`decision_log`, `crm_export`, `deal_idempotency`. Security (docs/security-review.md):
- **M4**: `app.deals_same_ws` triggers reject cross-workspace references on all deals tables.
- **M3**: `requirement_deals_guard` locks client-confirmed fields (and whole confirmed requirements) unless the write
  comes from `apply_change`; `opportunity_deals_guard`, `fee_milestone_deals_guard`, `quote_deals_guard` (quote
  versions immutable), `document_version_deals_guard` (stale never approved/released; release hash-bound).
  Because `app.cx_material_guard` (changes module) blocks all direct material updates, user edits go through
  SECURITY DEFINER paths that re-check role, `can_write`, row_version and the rules in SQL:
  `deals_update_requirement`, `deals_confirm_requirement`, `deals_move_stage`, `deals_set_outcome`,
  `deals_update_opportunity` (fee/credit/CRM id settable once), `deals_update_fee` (amounts fill once; evidence appended).
- Invalidation: superseding a quote drops finance approvals and stales documents; changing a scenario's hash does too.
- Stage history is written by trigger with the evidence passed to `deals_move_stage`.

## Jobs / env
- deals-A: no scheduled jobs; SQL triggers enqueue `deals.rematch`, `deals.req_tasks`, `deals.concession_npv` (see Round 2 —
  deals-A). Freshness is also checked on approve/release and on demand.
- deals-B (`jobs-b.ts`): `deals.closing_alerts` — enqueued once per workspace per local day (dedupe
  `deals.closing_alerts:<ws>:<date>`); raises overdue / blocked closing-item alerts via `notify()` (outbox, in-app) plus a
  task (idempotency key `deals.closing:<milestone>:<overdue:due|blocked:…>`), assigned to the item owner → account owner →
  opportunity owner. Service-role client, every query filtered by workspace. Nothing is sent externally.
Optional workspace setting `deals.availability_decay_days` (default 30). No env vars.

## Known gaps
- Storage objects under `<ws>/documents/` rely on the core storage policy for direct-URL access control.
- Concession steps / decision log have tables but no UI yet; occupied-seat scenarios and XNPV for irregular dates not built.

## Round 2 — deals-A (workflows 08 / 09 / 11)
Migration `20261101000400_deals_a_round2.sql` (re-runnable). Tests: `requirements/requirements-a.test.ts`,
`matching/matching-a.test.ts`, `finance/finance-a.test.ts` (pure); `requirements/requirements-a.db.test.ts`,
`finance/finance-a.db.test.ts`, `finance/concession-npv.db.test.ts` (RLS, local Supabase).

**08 Requirement Analyst**
- Field statuses `client_confirmed | reported | estimated | unknown` (`FIELD_STATUSES`, API zod enums, badges). Only
  client-confirmed is a client instruction; reported/estimated mandatory fields stay on the checklist.
- `requirements/tasks.ts`: one follow-up task per open MANDATORY question (`source = deals.requirement_question`,
  idempotency `deals.req.q:<req>:<field>`), retitled when an estimate needs confirmation, closed with evidence when
  answered / not applicable, reopened when cleared. Synced on every service write and by job `deals.req_tasks` after an
  approved change proposal is applied (SQL trigger).
- Free-text power / parking / transit / working hours / certifications / fit-out answers are parsed deterministically
  into `constraints.required_specs` (`deriveSpecs`, `applyDerivedSpecs`; kW never converted; unparseable → note).
  `constraints.spec_sources` records `manual` vs `derived:<field>`; manual wins.
- `/requirements/[id]`: hard-constraints block (value, source, status), matching-config form, location names
  (`resolveGeographies`: exact name/alias, unknown names rejected), follow-up & verification tasks card.

**09 Property Adviser**
- `matching/config.ts` `updateMatchingConfig` (+ `GET/PATCH /api/v1/requirements/{id}/matching`): weights, required
  specs, catchment points, hard filters. On a client-confirmed requirement spec / hard-filter edits become a change
  proposal (SQL guard `requirement_deals_a_guard` too); weights / catchments apply directly.
- match-v1: optional hard filters `constraints.hard_filters.{budget_ceiling, latest_occupation, preferred_only}`
  (default off = scored; unknown under a filter = needs verification). Options store `qualifies[]` (why it passes, with
  evidence) and coded `verification[{code,text}]`; the shortlist shows per-criterion detail and data completeness
  separately from fit.
- `matching/verify-tasks.ts`: verification items of the top 10 non-ineligible options → tasks
  (`deals.verify:<req>:<space>:<code>`), closed when resolved on a later run, reopened if re-flagged.
- Re-match: statement-level triggers on availability / space / asset (+ requirement confirmation / constraint edits)
  enqueue `deals.rematch` (≤ 1 queued per active requirement that is confirmed or already has a shortlist). Handler
  `matching/rematch.ts` (service role, explicit workspace filters) stores a new shortlist version, syncs verification
  tasks and notifies the owner (deduped outbox) when the eligible set changed.

**11 Financial Analyst**
- Three-state cost inputs `FinanceInput.costStates` for rent, CAM, parking, deposit, fit-out, opex, reinstatement
  (`known | none | unknown`; inferred if absent: amount → known, CAM mode none → none, else unknown; contradictions are
  input errors). Results carry `costStates`, `gaps` (+ GST rate missing), `complete`, `completeTotals` (null when
  incomplete) and `totalsLabel`. `inputFromQuote` maps a missing quote CAM to unknown; the /finance form defaults every
  optional cost to "Unknown — gap". Numbers and `outputHash` are unchanged, so stored fin-1.0 scenarios still reproduce.
- Assumptions register: `deriveAssumptions` (discount rate, horizon, tenure, rent terms, escalation, rent-free, areas,
  GST, deposit, financing, each "none" cost) with source + value hash → table `finance_assumption`. Per-assumption
  approval (admin, `mudar.deals_approve_assumptions`; direct writes refused); revocation drops the scenario approval.
- Scenario approval needs reproduction, fresh quotes, every assumption approved and no gaps unless `acknowledgeGaps`
  (stored in `finance_scenario.gaps_acknowledged` + approval note); SQL guard `finance_scenario_deals_a_guard` agrees.
- Versions: `recalculateScenario` (+ `POST /finance/scenarios/{id}/recalculate`, form on `/finance/[id]`) inserts v n+1
  (`version`, `previous_id`); approvals of unchanged assumptions carry over, changed ones need re-approval.
- Rounding rule stored per result (`roundingRule`, column `rounding_rule`). `/finance/compare` page (+ `scenarioIds` on
  `POST /finance/compare`) shows completeness, pending assumptions and top sensitivity drivers.
- Concession ladder pricing: `finance/concession-npv.ts`, job `deals.concession_npv` fills
  `concession_step.npv_equivalent` + `engine_version` from `value_json.finance_type` + `value_json.finance_value`
  against the latest scenario of the step's current quote version; unknown → NULL, reason in
  `value_json.finance_equivalence`. Enqueued on step insert / quote or finance-field change, quote supersede, scenario insert.

Known gaps (deals-A)
- Re-match relevance is workspace-wide (any inventory change re-runs active requirements, deduped), not filtered to
  spaces that could match. Only mandatory questions create tasks.
- Legacy scenarios have no assumptions register / stored rounding rule until recalculated. Gaps/assumptions are not in
  `outputHash` (they derive from the hashed input). Geography names resolve in the page action; the API still takes ids.
- The Deal Strategist does not write `value_json.finance_value` yet, so its ladder steps stay unpriced (NULL).

## Round 2 — execution half (deals-B: workflows 12, 17, 21)
Migration `20261101000450_deals_execution.sql` (re-runnable). Tests: `documents/studio.test.ts`, `pipeline/closing.test.ts`,
`fees/ledger.test.ts`, `fees/reconcile.test.ts` (pure) and `execution.db.test.ts` (RLS, local Supabase).

**12 Design Studio**
- Charts: native, editable PowerPoint charts (pptxgenjs) and native Word charts (DrawingML chart parts + embedded workbook,
  `documents/ooxml-charts.ts`): equivalent monthly cost, TCO vs NPV, option area vs requirement, all-in cost vs budget
  ceiling. Data = engine outputs / stored snapshots (`documents/visuals.ts`); unknown values are left out and said so.
- Location map: schematic plot of stored asset / preferred-geography lat-lon (equirectangular, km scale bar, north arrow;
  shapes in PPTX, labelled scatter chart in DOCX). No tiles, no network. No coordinates → a "No map" note instead.
- Market note has its own template (`documents/market-note.ts`): focus micro-markets, stored market observations (period,
  source, release date), availability picture, observed asking-rent range (single basis only), caveats.
- Version lineage: `document_version.family_id / parent_id / version_no` set by a SQL trigger (works even when the user
  cannot see every earlier version); lineage immutable. Every generation (and "New version" = `regenerateDocument`) is a
  new row; earlier approved/released versions stay listed with their approval hash. `/documents` groups by family.
- Immediate staleness (SQL triggers): requirement edit, new/changed availability for an option's space, quote superseded,
  scenario recalculated → `status = stale` with `stale_reasons[] {reason, at, was}`. Released documents are flagged too
  (`released_at` kept; UI: "was shared — re-review before sharing again").
- Uploaded master (`documents/theme.ts`, jszip): carries theme colours (accent1/accent2, dk2 fallback), theme fonts
  (minor → body, major → headings) and the logo on the slide master / page header. Not carried: layouts, placeholders,
  backgrounds, Word styles, page setup, header/footer text, macros, embedded fonts. Explicit brand_json values win over
  the file's theme. Every document states what was carried over.
- Sources: every PPTX/DOCX/XLSX lists the source data and calc versions (requirement row_version, shortlist run + rubric,
  availability ids/as-of/fact status, quote versions, scenario engine + output hash, geographies, market observations,
  template id/version, document family/version); also stored in `input_versions.sources`.

**17 Closing Coordinator** (`pipeline/closing.ts` pure, `pipeline/closing-service.ts`)
- Checklist template in SQL `mudar_app.deals_closing_template()` (mirrors `CLOSING_TEMPLATE`, equality tested) with
  `depends_on` keys; auto-seeded when an opportunity reaches LOI (trigger, every path) and before any move past LOI
  (so skipping LOI still blocks on real items). RPC `mudar.deals_seed_closing_checklist(id)`.
- `deal_milestone.assignee_user_id` (workspace member) + `owner_note` (external owner), editable due dates and
  dependencies on `/deals/[id]`. DB guard: same-deal dependency, no cycles, "done" only after the dependency is cleared.
- Dependency timeline with blocked state + "waiting on" chain; outstanding-documents list (document/legal/approval/fee
  items, proof gaps, unreleased or stale client documents); reconciliation exceptions per deal.
- Fee milestones can link to the closing item they depend on (`fee_milestone.deal_milestone_id`).

**21 Revenue Controller** (`fees/ledger.ts`, `fees/reconcile.ts`, `fees/report-service.ts`, `fees/recon-service.ts`)
- Separate money stages, each with status + transaction link (opportunity, fee milestone, CRM id, invoice no.):
  expected (forecast) · contractual (`contractual_amount` + `contract_ref`) · attributed (gross × credit share; credited
  when `attributed_on` + `attribution_ref`) · invoiced (`invoice_no`, `invoice_due_on`) · recognised · collected.
  Forecasts never enter invoiced/recognised/collected totals. New fields fill once (admin / approved proposal to correct).
- `/fees`: stage totals, forecast list, fee attribution register, receivables aging (by invoice due date; unknown due
  date is its own bucket), slippage (from `opportunity_close_history`, written by trigger on every expected_close
  change), cohort funnel (from `opportunity_stage_history`).
- `/fees/reconcile`: CSV export from the official finance system → match by invoice no. → fee id → CRM id (+ amount);
  per-row status (matched / mismatch / missing_in_cre_os / unmatched / invalid), totals (official vs recorded),
  "recorded but missing from export" list. Differences become `fee_milestone` change proposals (high_value, approval in
  /approvals); recorded amounts are never written by the import. Same file again → replayed (sha256), nothing re-proposed.
  Tables `fee_recon_import`, `fee_recon_row` (raw rows kept verbatim as evidence).

Routes added: `/fees/reconcile`; API `GET /opportunities/revenue`, `GET|POST /opportunities/reconcile`,
`GET /opportunities/{id}/closing`, `POST /opportunities/{id}/checklist` (update accepts assigneeUserId, ownerNote,
dependsOn, dueDate), `POST /documents/{id}/regenerate`, `GET /documents/{id}/versions`. Actions in `actions-b.ts`.

Known gaps (deals-B)
- Word charts embed a workbook; PowerPoint charts are pptxgenjs-native. The schematic map is not a street map.
- Logo from the master is placed in the deck master and Word header; master layouts themselves are not merged.
- Page CSV upload is limited by the default Server Action body size (1 MB); the API accepts 2 MB.
- Credit notes / negative amounts in finance exports are flagged as exceptions, not netted.
- Closing alerts run once a day; changing a due date creates a new alert/task (old tasks are not auto-closed).

## Property supply (Module 14)
See `src/modules/deals/supply/README.md` and `docs/property-supply/CONTRACT.md`. match-v1 now honours `availability.supply_status`, snapshot CAM (`cam_psf_month`) and flags historical asking rent (`pricing_historical`).
