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
No scheduled jobs (`jobs.ts` empty): freshness is checked on approve/release and on demand. Optional workspace
setting `deals.availability_decay_days` (default 30). No env vars.

## Known gaps
- Office templates: brand_json is applied; uploaded master .pptx/.docx files are not merged yet.
- Storage objects under `<ws>/documents/` rely on the core storage policy for direct-URL access control.
- Concession steps / decision log have tables but no UI yet; occupied-seat scenarios and XNPV for irregular dates not built.
