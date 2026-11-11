# Input Engine (Module 10): spreadsheet engine gap analysis

Scope: spec `docs/input-engine/SPEC.txt` §3.1–3.4, §10, §13C, plus the spreadsheet parts of §6 (duplicates), §7 (validation/conflicts), §11 (worksheet + cell traceability) and §15 rules 2–6. Owner: `src/modules/imports/**`, `src/app/(app)/imports/**`.

**Before** is the module as it stood after rounds 1–2: tenant workbook adapters (assets, leases, transactions, market), hashing, staging, steward conflicts. **After** is this round. Evidence is the file or test that shows the behaviour.

## §3 Supported formats
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Excel .xlsx | DONE | DONE | `parse.ts` exceljs (read-only, formula text and cached value kept); test 10 `input-engine.test.ts` |
| Excel .xls | MISSING (rejected) | PARTIAL | No BIFF reader is installed (no new deps). Every path now says "Old format — save as .docx/.pptx/.xlsx for full extraction": batch item (`runs.ts` `LEGACY_XLS_NOTE`, original stored read-only under `<ws>/imports/legacy/<sha>/`), single upload (`parse.ts`), capture document upload (`legacyNote`, original stored). Full parsing still needs `xlsx` (SheetJS) |
| CSV | DONE | DONE | `parseCsv`; test 11 |

## §3.1 Spreadsheet upload
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Upload spreadsheets | DONE | DONE | `POST /api/v1/imports`; several files at once via `POST /api/v1/imports/runs` |
| Read multiple worksheets | DONE | DONE | each sheet is detected separately; test 10 (Contacts plus a non-data "Readme" sheet) |
| Identify column headers | PARTIAL (exact tenant aliases only) | DONE | `detectContacts` scans the first 10 rows for the header row, with fuzzy and learned matching (`adapters/contacts.ts`) |
| Detect data types | PARTIAL | DONE | typed parsers in `validate.ts` (email, phone, date with format/precision, area with unit/basis, rent with basis); cell types `s/n/d/b/e` |
| Blank and incomplete rows | PARTIAL | DONE | blank rows are excluded (`blank_row`); a row with no company and no contact is quarantined (`incomplete_row`); company-only and contact-without-method rows are flagged |
| Duplicate records | PARTIAL | DONE | `markDuplicates` on identity key (email > phone > name+company); also flags spelling variants of one company and one phone/email shared by different names (`possible_duplicate_*`) |
| Potentially invalid values | PARTIAL | DONE | `invalid_email/phone/area/date/value`, `suspicious_number` |
| Preserve original spreadsheet | DONE | DONE | storage + SHA-256 + `source_object` versions; test 10 compares bytes. Originals open from the record-source page via a signed URL |

## §3.2 Automatic column mapping
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Spec example (Company→Company Name … Expiry→Lease Expiry Date) | MISSING (no contact/requirement adapter) | DONE | `contacts_requirements_v1`; `validate.test.ts` "maps the spec example headers"; test 10 column_map |
| Suggest mappings | PARTIAL (suggestions for unknown sheets only) | DONE | `suggestColumns`: per column field, confidence, source (learned/synonym/partial/keyword) and alternatives |
| Review mappings | PARTIAL | DONE | "Column mapping" card on `/imports/[id]` shows every column with its target and confidence |
| Correct mappings | PARTIAL (unknown sheets only) | DONE | `ColumnMappingEditor`; `approveMapping` now also accepts corrections to header-driven mapped sheets; an approved map for the same header signature overrides the built-in one (`detect.ts`) |
| Custom column names | MISSING | DONE | unmatched columns are kept as `custom["<header>"]` with their cell refs; mapping to `custom:<name>` is allowed; test 10 ("Source Channel") |
| Remember approved patterns | PARTIAL (exact signature only) | DONE | new `import_header_alias` (admin-only, DB trigger). Approving a map stores header→field pairs that later files with other layouts reuse; test 12 ("Desk Count") |
| Detect changed layouts | MISSING | DONE | `layoutChanges` (added/removed/moved/remapped columns, sheet added/removed) against the previous version; `layout_changed` exception; test 13 |
| Columns that cannot be mapped | PARTIAL | DONE | `unmapped_columns` issue + `extra_columns` |
| Incomplete or ambiguous mappings | PARTIAL | DONE | `ambiguous_mapping`, `incomplete_mapping` (no company column), `low_confidence_mapping` |

## §3.3 Validation
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Email format | MISSING | DONE | `parseEmail`; invalid emails are kept raw and never saved as a contact method |
| Telephone (Indian formats) | MISSING | DONE | `normalisePhone`: +91/091/0091/0-prefix, 10-digit mobile, STD landline, 1800 toll-free, international, several numbers per cell, E.164 output |
| Inconsistent date formats | MISSING | DONE | `parseDate` (format + precision + dd/mm ambiguity) and `dateColumnConsistency` (mixed day-first and month-first) |
| Invalid area values | PARTIAL (tenant adapters) | DONE | `parseArea` (non-numeric, ≤0, reversed range) and `missing_area_unit` |
| Missing company names | MISSING | DONE | `missing_company` |
| Duplicate contacts | PARTIAL (people never merged) | DONE | within the file (identity key, shared phone/email) and against the DB (an existing contact_method value links to that person); test 15 |
| Duplicate companies | PARTIAL | DONE | canonical-name key (legal suffixes folded); reuse of a live company with the same canonical name; fuzzy pairs go to `identity_match_candidate`; test 14 |
| Suspicious numbers | PARTIAL | DONE | `suspiciousArea/Rent` (area <100 or >20,00,000 sf, rent per sf <₹15 or >₹400/month, phone-like, more than 10x spread, rent without basis) — flagged for review, never blocked |
| Conflicts with existing records | PARTIAL (assets/leases) | DONE | person name gives a `field_conflict` plus a proposal; a new phone/email gives a contact_method proposal; a new employer gives an employment proposal; test 15 |
| Validation report | MISSING | DONE | `validationReport` → `counts.validation`; `ValidationReportCard` |

## §3.4 Change detection
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Identify previously imported records / match rows | DONE | DONE | same file name + new hash = version n+1; `diffVersions` by identity key |
| New / modified / removed rows | DONE | DONE | `diff.added/changed/removed` with samples; test 13 |
| Changed column layouts | MISSING | DONE | `diff.layout` + exception |
| Change summary | PARTIAL | DONE | diff card + layout card + contacts summary line |
| Propose database updates | PARTIAL | DONE | requirement create/update proposals (update when the earlier one was applied); contact and employment proposals; asset/lease conflicts as before |
| Preserve historical values | DONE | DONE | staged rows per version kept; field_conflict history; earlier proposals kept; record-source page shows every version (test 28/29) |
| Never delete for missing rows | DONE (implicit) | DONE (explicit) | `diff.removed_policy`; test 13 checks the removed row's company is not archived. A column missing from the new layout means "not reported", not "cleared" (`subsumed`) |

## §6 / §7 / §15 (spreadsheet parts)
| Rule | After | Evidence |
|---|---|---|
| Duplicate spreadsheet imports | DONE | same hash = no-op under any name; re-processing writes 0 rows; test 21 |
| Repeated info is not independent evidence | DONE | the same values give the same idempotency key, so no new proposal; one source_object per hash |
| Carpet ≠ chargeable; unit never assumed | DONE | `area_*_sf` only when the unit is explicitly sq ft; basis only when stated; otherwise raw in `constraints`; test 10 |
| Rent ≠ CAM-inclusive; missing ≠ 0 | DONE | rent basis only when stated; budget is written only with a stated basis |
| Uncertain spreadsheet date ≠ confirmed contractual date | DONE | expiry stored only as `constraints.lease_expiry_reported {fact_status: reported, confirmed: false, ambiguous, alternative}`; no lease_event; test 10 |
| No silent overwrite | DONE | existing records are linked, never updated; differences go to conflicts and proposals |
| Material changes need approval | DONE | requirement/employment are created only via `proposeChange` (risk from code) |

## §11 Traceability
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Worksheet + cell reference per value | PARTIAL (row locator + raw cells) | DONE | `mapped_json.cell_refs` for every adapter (generic from the column map; contacts per field, including custom columns) |
| Open the original from a record | MISSING | DONE | `/imports/source/[entityId]` + `GET /api/v1/imports/trace/[entityId]` (`trace.ts`: rows, cells, raw values, signed URL to the original, value history); test 28 |
| Extraction / correction history | PARTIAL | DONE | all versions' staged rows, approved mapping versions + aliases, field conflicts, proposals |

## §10 Large files and batches
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Large files | PARTIAL (25 MB, 815-row test) | DONE | 25 MB per file, 50 files per batch; 600-row file in test 23 (chunked writes) |
| Asynchronous processing | PARTIAL (job + inline) | DONE | batch upload only registers and enqueues (`imports.process`); the response returns at once |
| Multiple files in one batch | MISSING | DONE | `import_run` + `import_run_item`; documents/images go to capture's `createCapture` |
| Background extraction | PARTIAL | DONE | jobs; captures through `capture.process` |
| Track progress / processing status | PARTIAL | DONE | `refreshRun` progress 0–1 from item states; `/imports/runs/[id]` refreshes itself |
| Continue using the app | PARTIAL | DONE | nothing runs inline for batches |
| Identify failed files | MISSING | DONE | per-item status, error and `error_kind` |
| Retry temporary failures | PARTIAL (queue retried everything; failed batch was then skipped) | DONE | job throws only on temporary errors and allowFrom includes `failed`; `retryRun` (UI/API) skips permanent failures; test 24 |
| Keep successful results when another file fails | PARTIAL | DONE | per-file isolation; test 24 |
| Final report (all 10 figures) | MISSING | DONE | `runReport` → `import_run.report`; `RunReportGrid` |

## §13C Import dashboard
| Bullet | Before | After | Evidence |
|---|---|---|---|
| Upload history | DONE | DONE | `/imports` batch list + "Batch uploads" list |
| Import progress / processing status | PARTIAL | DONE | run progress bars, per-file statuses, auto-refresh |
| Spreadsheet mapping | PARTIAL | DONE | column mapping card + editor |
| Validation results | PARTIAL (exceptions list) | DONE | validation report card |
| Duplicate records | DONE | DONE | DuplicatesPanel (identity candidates) + duplicate rows in the validation report |
| Conflicting information | DONE | DONE | conflicts card (now also person conflicts) |
| Completion report | PARTIAL | DONE | three-step summary per file + run completion report |
| Mobile 375px | PARTIAL | DONE | single-column layouts, `grid-cols-2` tiles, truncation, stacked mapping editor rows |

## Still open / requests
- `.xls` parsing needs the npm package `xlsx` (SheetJS). Not added here because `package.json` is shared.
- Entity pages (`/companies/[id]`, `/people/[id]`, owned by admin) should link "Source" → `/imports/source/<id>`.
- Mapping corrections stay admin-only, as before (DB triggers on `adapter_mapping` and `import_header_alias`). Editors can review but not approve.

### Round 3 (Nov 2026)
- Entity pages (/companies, /people, /buildings) show "Source (n spreadsheet rows)" → `/imports/source/<id>` when import traces exist, and "From capture (n observations)" when capture observations name the record (`trace.ts provenanceLinks`, `provenance-links.tsx`).
- `summary.ts` no longer uses `any` (uses the shared `Db` type; `counts` is `Record<string, unknown>`).
