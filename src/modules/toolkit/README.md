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
| 10 | Specialist models | `/toolkit/models` | — | per model |

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
