# imports module

Safe spreadsheet intake (spec Part I §6, Part III "Import adapters and reconciliation", Part V "Import acceptance rules"):
read-only source → hashed import → row-level staging → schema mapping → type checks → candidate matching → exception queue →
validated upserts → reconciliation. Adapters are chosen by **schema signature (header fingerprint / headerless shape)**, never by file name.

## What's built
- **Migration** `supabase/migrations/20261031001000_imports.sql` (re-runnable; drops only this module's tables):
  `adapter_mapping` (per-workspace approved column maps; DB trigger lets only admins approve), `import_batch` (status, versions, counts,
  diff), `staged_row` (every considered row: locator, raw cells + formula text, row hash, status, reason, mapped record, targets),
  `import_exception`, `identity_match_candidate`, `import_entity_key` (natural key → master id, first source), `asset_observation`
  (one building master, many source observations). All via `app.make_business_table`.
- **Parsing** (`parse.ts`): exceljs/papaparse, read-only. Formula cells keep `f` (text) and `v` (cached value); nothing is
  recalculated, no macros or external links. Legacy `.xls` is rejected.
- **Adapters** (`adapters/*`, registry + detection in `detect.ts`): `asset_list_v1` (+ headerless tab only via an approved positional map,
  first row is data, `positional_map` flag), `ready_asset_v1`, `lease_large_v1`, `lease_small_v1` (labels, not positions), `transactions_2022_v1`,
  `transactions_2023_v1`, `market_matrix_v1` (metadata row skipped, unpivot, transposed rent, Total = control, blank = unknown, current year =
  `snapshot`), `comparison_reference_v1` (reference only, reuse blocked). Pivot/analysis tabs are deliberately excluded; unknown sheets are
  quarantined (`needs_mapping`) with suggestions.
- **Lease events** (`lease-events.ts`): EDATE with month-end clamp for integer tenure; fractional tenure → no date, `needs_review`;
  stale formula caches flagged; lease and lock-in are distinct events on one lease; `date_basis = calculated_from_source_tenure`.
- **Size rules** from typed area, strict `>min` and `<max` (workspace_setting `imports.size_rules`, defaults 5,000/200,000/8,000);
  boundaries flagged for review; small rows classified, never discarded.
- **Identity** (`identity.ts`): companies by CIN/GSTIN/domain (names = context), group/subsidiary → relation; people never merged on name;
  buildings by name + locality + tower scope + coordinates, towers never collapsed. ≥0.95 *and* hard identifiers agree = auto-link band;
  0.80–0.95 review; else separate (workspace_setting `imports.identity_thresholds`). Exact natural keys link automatically; everything
  fuzzier becomes an `identity_match_candidate`. "Link" creates a `proposeChange(operation:'merge')` proposal (approval + reversal by the
  changes module); "related" proposes an `organisation_relation` link or a tower→campus `parent_asset_id`.
- **Pipeline** (`pipeline.ts`): deterministic UUIDs per (workspace, type, natural key) + `ON CONFLICT DO NOTHING` → identical re-import and
  re-processing create nothing; same hash = no-op even under another name; same name + new hash = new `source_object` version with a
  row/field diff; revisions add new observations; existing canonical fields are never overwritten. Calls
  `assertIngestionAllowed` (kill switch) before processing. Licensed/restricted originals are stored under `<ws>/private/imports/` (owner only).
- **Reconciliation** (`reconcile.ts`): `rows_considered = accepted + quarantined + excluded` (duplicates reported within accepted,
  header/title rows counted separately), master counts (new vs existing-linked) separate from observation counts, controls, exceptions.

## Exported services (`service.ts`, for routes/pages; RLS client)
`uploadImport`, `reprocess`, `approveMappingAndReprocess` (admin), `decideCandidate`, `closeException`, `reconciliation`, `listBatches`,
`batchDetail`, `mappableRoles`. Lower level (`pipeline.ts`): `registerImport`, `processBatch`, `approveMapping`, `decideMatch`,
`resolveException`, `getReconciliation`, `detId`. Pure: `detectWorkbook`, `mapWorkbook`, `scoreOrganisation/scorePerson/scoreBuilding`, `decide`.

## Jobs
- `imports.process {batch_id, allow_from?}` — service-role processing (every query filters `workspace_id`). The upload route also
  processes inline; an optimistic status/row_version claim prevents double processing.
- `schedule()` re-enqueues batches stuck in `registered` for >10 min (dedupe per batch per hour).

## Routes
- Pages: `/imports` (upload + batch list with reconciliation line), `/imports/[id]` (counts, masters vs observations, sheets, mapping
  review, controls, version diff, review queue, identity review, quarantined rows with source cells).
- API: `POST /api/v1/imports` (multipart `file`, `as_of`, `period_year`, `classification`; Idempotency-Key), `GET /api/v1/imports`,
  `GET /api/v1/imports/[id]/reconciliation`, `POST /api/v1/imports/[id]/reprocess`, `POST /api/v1/imports/[id]/mappings` (admin),
  `POST /api/v1/imports/matches/[id]` `{decision: link|keep_separate|related}`, `POST /api/v1/imports/exceptions/[id]` `{status, note}`.

## Env vars
None beyond the core (`NEXT_PUBLIC_SUPABASE_URL`, keys). No AI calls.

## Tests
`npx vitest run src/modules/imports` — adapters/detection/reconcile/diff (`adapters.test.ts`), identity (`identity.test.ts`), DB pipeline in a
throwaway workspace (`pipeline.test.ts`: headerless tab, repeat & revision, lease chronology, identity ambiguity, market controls, unknown
schema, admin-only mapping guard, restricted storage, kill switch), volume (`scale.test.ts`: 815 lease rows, idempotent re-run).

## Known gaps
- Person masters are not created from "representative name" columns (no verified identifiers; names kept in staged rows).
- Developer names are kept raw (not linked as landlord/developer organisations).
- Transactions link to buildings only on an exact building|locality key; no building masters are created from tracker labels.
- Fractional-tenure rows create the lease with a dateless `needs_review` event; there is no in-app "confirm intended tenure" editor yet.
- `import_entity_key` is re-pointed to the merge winner lazily (on the next import that touches it).
- No watched-folder/connector intake; uploads only.
