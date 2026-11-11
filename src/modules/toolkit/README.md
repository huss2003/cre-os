# Module 8 — Deal Toolkit (`/toolkit`)

Workbench for comparing, costing and recommending options on a requirement. Every analysis is saved through
`saveAnalysis()` (`store.ts`): current inputs/outputs on `deal_analysis` + an immutable `deal_analysis_version`
(inputs, outputs, formula version), so any figure in a client document is traceable and reproducible.
Calculators are pure, deterministic code in `calc/*.ts` — never an LLM (S5). Unknown stays unknown (S6).

## Sections and routes
| # | Section | Route | `deal_analysis.kind` | Formula |
|---|---|---|---|---|
| 01 | Requirement brief | `/toolkit/brief`, `/toolkit/brief/[requirementId]` | `brief` | `brief-1.0` |
| 02 | Property comparison | `/toolkit/compare` | `property_comparison` | `rating-1.0` |
| 03 | Lease economics | `/toolkit/lease` | `lease_economics` | `lease-1.0` |
| 04 | Occupancy economics | `/toolkit/occupancy` | `occupancy` | reuses `fin-1.0` (deals finance engine) |
| 05 | Conventional vs managed | `/toolkit/managed` | `conventional_vs_managed` | `cvm-1.0` |
| 06 | Renewal vs relocation | `/toolkit/renewal` | `renewal_vs_relocation` | `rvr-1.0` |
| 07 | Fit-out & financing | `/toolkit/fitout`, `/toolkit/financing` | `fitout`, `financing` | `fitout-1.0`, `loan-1.0` |
| 08 | Negotiation | `/toolkit/negotiation` | `negotiation` | `nego-1.0` |
| 09 | Client deliverables | `/toolkit/deliverables`, download `/toolkit/deliverables/[id]/[file]` | `deliverable` | `deliverable-1.0` |
| 10 | Rating models | `/toolkit/models` | — | per model |
| 11 | Built-to-suit (§8.11) | `/toolkit/bts`, `/toolkit/bts/[id]` | `bts` | `bts-1.0` |
| 12 | Investment analysis (§8.11) | `/toolkit/investment`, `/toolkit/investment/[id]` | `investment` | `inv-1.0` |
| — | Analysis deck (any kind) | POST `/toolkit/deck/[id]` (generate+download), GET `?doc=` (re-download) | — | `deck-1.0` |

Dashboard `/toolkit`: section entry list with saved counts per kind, recently updated analyses, analyses needing
information (status `needs_info` + missing items), requirements with no analysis, quotes expiring in 14 days and
expired quotes (latest, non-superseded versions; expired shown as a banner at the top).

## Requirement brief (`brief.ts`)
- `buildBrief()` (pure) assembles sections A–G from the requirement contract (`deals/requirements/contract.ts`),
  stakeholder slots (decision-maker = approver/sponsor, financial approver = finance, procurement, facilities =
  technical, admin = user, legal), meeting outcomes (`meeting_prep.outcome`), open questions (`missingQuestions`) and
  pending requirement change proposals.
- Labels come from the deals field status: `client_confirmed` → Confirmed, `estimated` → Estimated,
  `reported` → Assumption, no value → Missing, `constraints.not_applicable` → Not applicable.
- Editing uses `updateRequirementFields` (deals). Choosing "Confirmed by client" never writes directly: it always
  creates a change proposal (with evidence) via `proposeChange()`; already-confirmed fields are proposals too (S4).
- "Save brief snapshot" → `saveAnalysis(kind "brief", formula "brief-1.0")` (same analysis id per requirement, new
  version each save); `missing` = mandatory unknowns, so it can be approved only when none are missing.

## Client deliverables (`deliverables.ts`)
`generateDeliverables(db, ws, userId, { requirementId, analysisIds, preparedFor, title })` builds
(a) `proposal.docx` (editable), (b) `analysis-workbook.xlsx` (summary + one sheet per analysis: inputs, outputs,
formula version, labels), (c) `decision-summary.docx` (options, recommended option, financial implications,
trade-offs, risks, assumptions, outstanding approvals). Brand from the tenant `template_asset` (purpose `proposal`)
/ workspace name via deals `brandFrom`. Labelling: analyses with missing info → `MISSING INFO`, not approved →
`UNVERIFIED`, values under an `estimated/reported/ai_inference/...` status → `ESTIMATED — not confirmed`, blanks →
`MISSING`. Files: storage `mudar-workspace-files/<ws>/toolkit/deliverables/<uuid>/…`; file refs (path, sha256) and the
analysis ids/versions/formulas used are saved with `saveAnalysis(kind "deliverable")`. Downloads re-check the path
prefix and sha256.

Exported services: `buildBrief`, `parseFieldInput`, `loadBriefFor`, `generateDeliverables`, `downloadDeliverable`,
pure builders `buildProposal`, `buildWorkbook`, `buildDecisionSummary`, `flatten`, `analysisFlags`, `prepare`.
Server actions (`actions-core.ts`): `updateBriefFieldAction`, `saveBriefSnapshotAction`, `approveAnalysisAction`,
`generateDeliverablesAction`.

## Presentation decks (`deck.ts`)
`generateDeck(db, ws, userId, analysisId, version?)` → editable PPTX: title, executive recommendation, options tables,
NATIVE pptx charts from stored numbers (unknowns are left out of the chart and named, never plotted as 0), assumptions +
method, missing info, sources, appendix (flattened inputs/outputs with labels). Brand: pptx `template_asset` (purpose
containing "deck" preferred) else workspace name on a neutral layout. Stored at `<ws>/toolkit/decks/<analysisId>/…` and
recorded as `document_version` (kind pptx, purpose `analysis_deck`, linked_entity deal_analysis; `input_versions` holds
analysis id/version/formula/requirement_id). Lineage trigger chains versions. `DeckPanel` (`ui/deck-button.tsx`) shows
"Download deck" + earlier decks on every result page. Pure: `deckModel`, `extract`, `chartOf`, `buildAnalysisDeck`.

## Site visit pack (`packs.ts`)
Per property: details, amenities, key commercials (verification-labelled), photos/floor plans (evidence of kind
photo/floor_plan on any analysis of the requirement, matched to a building by name in the title; PNG/JPEG ≤4 MB embedded
in the DOCX), SITE_VISIT inspection checklist, `PACK_CHECKLIST` assessment (commute, connectivity, layout, building quality,
amenities, parking, operational constraints, price concerns, stakeholder reactions, suitability; rated 1–5) and a blank
client feedback form. Outputs DOCX + PDF (`buildSiteVisitPdf`, via assistant `buildPdf`; text only) + PPTX.

## Specialist models (`calc/bts.ts`, `calc/investment.ts`, `models-service.ts`)
`runBts` / `runInvestment` compute + `saveAnalysis`. Form parsers `btsFromForm`, `investmentFromForm`. Actions in
`actions-models.ts`. Unknown inputs → dependent outputs null with reasons in `nulls`; area basis stated, never converted;
deposits separate. IRR: bracketed bisection with a convergence guard (`irr()` returns null if no root). Assistant tools
`src/modules/assistant/tools/toolkit2.ts` → `toolkit2Tools` (run_bts_model, run_investment_model, generate_deck) — to be
registered by the lead. Migration `20261111001300_toolkit_models.sql` widens `deal_analysis.kind`.

## Tables
`deal_analysis`, `deal_analysis_version` (immutable versions, trigger), `property_rating_model` — migration
`supabase/migrations/20261108001000_deal_toolkit.sql`. Reuses `requirement`, `stakeholder`, `quote`,
`finance_scenario` (fin-1.0), `meeting_prep`, `change_proposal`, `template_asset`.

## Tests
`npx vitest run src/modules/toolkit` — `brief.test.ts`, `deliverables.test.ts` (pure), `deliverables.db.test.ts`
(local stack, RLS as owner; fixtures tagged in WS1).

## Status / known gaps
- Brief, deliverables, dashboard: built. Other sections are built by their own sub-modules.
- Deliverables are new rows each time (no regenerate-from-same-request yet); they are not linked to
  `document_version` approval/release flow.
- Recommendation is read from an analysis output key `recommended` / `recommendation` / `recommended_option` /
  `winner`; analyses without one show "Not determined".

## Rollback
```sql
drop table if exists mudar.deal_analysis_version;
drop table if exists mudar.deal_analysis;
drop table if exists mudar.property_rating_model;
drop function if exists mudar_app.deal_analysis_version_immutable();
```
Then remove `/toolkit` from `src/lib/nav.ts` (NAV + FOCUS_MENU) and delete `src/modules/toolkit`, `src/app/(app)/toolkit`.
Stored files under `<ws>/toolkit/` can be removed from the storage bucket.
