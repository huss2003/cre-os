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

## Round 2 (Intake Engineer / Database Steward) — migration `20261101000200_capture_imports_round2.sql`
- **Approved sources** (`import_source`, `import_batch.import_source_id`, status `awaiting_source`): upload chooses a source; an unknown
  name is registered unapproved and the batch is stored but **quarantined** (blocking `unapproved_source` exception) until an admin
  approves it (DB trigger `imports_source_guard`; `approveSource` then processes waiting batches). No source => built-in approved
  "Manual upload" source (`mudar_app.imports_default_source`, revocable). Page `/imports/sources`; API `GET/POST /api/v1/imports/sources`,
  `POST /api/v1/imports/sources/[id]` `{decision: approve|revoke}`; upload accepts `source_id` or `source_name`+`source_kind`.
- **Field conflicts** (`field_conflict`, deterministic ids): asset status/area/floor sizes/floors, lease rent/tenure/lock-in and lease-event
  dates that disagree with the CURRENT master are recorded with source locator + file version; masters are never overwritten.
  Material ones (MATERIAL_FIELDS) get a change proposal (`imports.conflict:<id>`, evidence = staged row + source_object). Shown on
  `/imports/[id]` and `/approvals/conflicts`. Re-import/re-process => zero new rows (counts in `counts.steward`).
- **Person candidates**: representative-name columns => `person` create proposals keyed `imports.person:<name+company>` (never merged by
  name; same-name records are mentioned in the reason). Applying one proposes the employment link (material, needs approval).
- **Merge/relate evidence**: `decideMatch` attaches the batch's source_object + staged rows targeting either record (`candidateEvidence`).
- **Stale-record job** `imports.steward_stale` (daily per workspace, dedupe `imports.steward_stale:<ws>:<day>`) runs
  `changes/steward.ts#runStaleDetector`.
- Fixed: jsonb `contains` filters (`targets`, merge `patch`) were sent in array-literal form and never matched (merge following now works).
- Tests: `steward.test.ts` (quarantine + admin-only approval, conflicts/proposals/zero duplicates, propose-fix → provenance, person proposals
  → employment follow-up, merge evidence, stale detector).

## Known gaps
- Transactions' broker/contact columns are not turned into people (brokers are firm context only).
- Conflicts are detected for assets and leases; transaction and market rows are observations and are not compared with a master.
- Developer names are kept raw (not linked as landlord/developer organisations).
- Transactions link to buildings only on an exact building|locality key; no building masters are created from tracker labels.
- Fractional-tenure rows create the lease with a dateless `needs_review` event; there is no in-app "confirm intended tenure" editor yet.
- `import_entity_key` is re-pointed to the merge winner lazily (on the next import that touches it).
- No watched-folder/connector intake; uploads only.

## Real-data fixes (scripts/real-data-e2e.ts on the tenant's six Pune workbooks) — tests `real-data.test.ts`
- `normalize.quarter()` read "Q1 2023" as 2020 (2-digit year branch matched first): every 2023-tracker deal was dated 2020. Fixed (4-digit first).
- Footer summary lines under the 2022 deal table ("Net Absorption", "Pre-Commitments", "Total Transactions with PC") are excluded as `summary_or_total` instead of quarantined.
- Lease numerics are compared at the stored scale (numeric(8,2)): tenure 52.866 vs stored 52.87 no longer raises a false conflict + approval.
- Person-proposal key lookups use URL-length-bounded chunks (`keyChunks`) and throw on error (150 keys/request hit HTTP 414; re-imports re-attempted ~860 proposals).
- Asset floor-size ranges: reversed ("45,000 - 35,000") => `floor_size_range_suspect` review; implausible spread (> 10x, "7,420 - 8") => text kept, min/max unknown.
- `scripts/real-data-e2e.ts` (+ `real-data-workflows.ts`) re-runs the whole real-data import + downstream workflows in workspace `pune-real-test`.

## Input Engine round (Module 10: spreadsheet engine §3, batch §10, import dashboard §13C) — migration `20261111001910_input_engine_imports.sql`
Gap analysis (before/after per bullet): `docs/input-engine/SPREADSHEET-GAP.md`.
- **Generic contact/requirement sheets**: adapter `contacts_requirements_v1` (`adapters/contacts.ts`), listed last in the registry so tenant adapters win ties.
  It suggests a mapping for each column (`suggestColumns`: synonyms, keywords, learned aliases, confidence, ambiguity), finds the header row,
  and reports unmapped, ambiguous and incomplete mappings. Unmatched columns are kept as `custom[<header>]`.
- **Validation** (`validate.ts`, pure): email, Indian phone (E.164), dates (format, precision, dd/mm ambiguity, column consistency), area (unit and basis
  never assumed), rent (basis/CAM only if stated), suspicious numbers. `report.ts#validationReport` → `import_batch.counts.validation`.
- **Writes** (`contacts-writer.ts`): companies are keyed by canonical name and reuse a live company with the same canonical name; fuzzy matches go to
  identity candidates. People are created only with a valid email/phone, and an existing person holding that value is linked. Name-only contacts
  become person proposals. Differences from existing people become field conflicts or proposals (contact_method, employment). Requirements are
  always `proposeChange` (create, or update if the earlier one was applied), `status: estimated`. `area_*_sf` is set only when the unit is
  explicitly sq ft. The spreadsheet expiry stays `constraints.lease_expiry_reported` (`fact_status: reported`, `confirmed: false`).
  Same values = same idempotency key; a column missing from a new layout is not read as "cleared".
- **Mapping memory**: `approveMapping` also corrects mapped header-driven sheets (admin). It writes `import_header_alias` (admin-only trigger
  `imports_alias_guard`), and detection uses those aliases for later files with other layouts. An approved map for the same header signature
  overrides the built-in map.
- **Change detection**: `diff.layout` (`report.ts#layoutChanges`: added/removed/moved/remapped columns) + `layout_changed` exception;
  `diff.removed_policy` (missing rows never delete anything).
- **Traceability**: `staged_row.mapped_json.cell_refs` (field → `Sheet!C12`) for every adapter. `trace.ts`: `recordSources`, `valueHistory`, `originalUrl`.
  Page `/imports/source/[entityId]`, API `GET /api/v1/imports/trace/[entityId]`.
- **Batch runs** (`runs.ts`): `import_run` + `import_run_item`. `createRun` registers spreadsheets and queues `imports.process`. Documents and images go through
  capture's exported `createCapture` (queues `capture.process`). Unsupported files, including `.xls`, become failed items. Nothing runs inline.
  `refreshRun` computes per-file status and `runReport` (files received/processed/partial/failed, records identified/created/updated, potential
  duplicates, conflicts, needs review). `retryRun` re-queues temporary failures only. The `imports.process` job throws (so the queue retries) only on temporary
  errors (`classifyImportError`) and refreshes its run.
- **Orchestrator**: after each processed version, `publishEvent("import.completed", subject import_batch, dedupe import.completed:<batch>:<sha>)`
  with created/linked record ids. The per-record `company.created`/`contact.created` events come from the existing DB triggers.
- **Exported services** (`service.ts`): `uploadRun`, `importRuns`, `importRunDetail`, `retryImportRun`, `columnSuggestions`, `recordTrace`.
- **Routes**: `POST|GET /api/v1/imports/runs` (multipart `files`, Idempotency-Key), `GET /api/v1/imports/runs/[id]`, `POST /api/v1/imports/runs/[id]/retry`
  `{item_id?}`, `GET /api/v1/imports/trace/[entityId]`. Pages: `/imports` (multi-file upload + batch list), `/imports/runs/[id]` (progress, files,
  completion report, retry), `/imports/[id]` (+ column mapping card/editor, validation report, layout changes, contacts summary), `/imports/source/[entityId]`.
- **Tests**: `validate.test.ts` (pure: validators, spec mapping example, learned/ambiguous/custom columns, layout diff, run report) and
  `input-engine.test.ts` (DB: §17 scenarios 10, 11, 12, 13, 14, 15, 21, 23, 24 incl. temporary-failure retry, 28, 29).
- **Known gaps**: `.xls` needs the `xlsx` (SheetJS) package. Entity pages link to `/imports/source/<id>` via `provenance-links.tsx` (`provenanceLinks` in trace.ts). Mapping approval is
  admin-only. Capture items in a run only report counts once capture finishes (they show as waiting until then).
