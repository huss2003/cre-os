# capture + changes/approvals module

Owns `src/modules/capture/**`, `src/modules/changes/**`, `src/lib/services/changes.ts`, migration
`20261031001100_changes_apply_reverse.sql`, routes `/capture`, `/capture/[id]`, `/approvals`, `/api/v1/captures/**`, `/api/v1/changes/**`.
Spec: Part I §7, §8 (Daily debrief, Database steward, Workflow contracts → Capture), §10; Part III extraction/change contract,
transactional update & reversal algorithm, acceptance tests Debrief, Approval invalidation, Reversal, Prompt injection, Person move.

## Security model (docs/security-review.md C1, C2, M3)
- `change_proposal` rows written straight through the API are only drafts. Trigger `cx_proposal_guard` forces `state='proposed'`,
  clears `before/applied_audit_id/reversal_of/decided_*`, recomputes `risk` (never below the SQL floor `cx_risk_floor`, the SQL port of
  `MATERIAL_FIELDS`) and `approval_required`. Afterwards only `patch/reason/evidence_ids/expected_version` can be edited, and only while the proposal is undecided.
  A content edit sends the proposal back to `proposed`, so the old approval (hash-bound) stops working. DELETE is revoked.
- `approval`: UPDATE/DELETE revoked. Approvals for change proposals come only from `app.approve_change`. Direct inserts are still allowed for other
  subject types (the integrations draft flow), but only with `approver_user_id = auth.uid()`. `change_conflict` is written only by `reverse_change`.
- `apply_change` / `reverse_change` / `preview_reverse` check the table allow-list (`cx_allowed_tables`; never membership/workspace/
  record_share/connector_account/audit/approval/job/outbox/...). They also check column validation (`cx_patch_fields`) and that the caller can read and write the target row.
  Reversal accepts only proposals that apply_change actually applied: `applied_audit_id` must be an audit row of that proposal on that entity.
  The before/after values come from that audit row (`app.cx_verified_apply`), never from `change_proposal.before`. Merge re-point pairs are
  whitelisted against `cx_merge_refs`. Reversal risk is recomputed.
- M3: trigger `cx_material_guard` rejects direct API updates of `cx_material_fields` on requirement, opportunity, lease, lease_event,
  employment, quote, fee_milestone, organisation, person, contact_method and availability. Definer functions and the service role pass.
- Applying a proposal that needs approval requires `state='approved'` and an approval whose hash matches the current content, has not expired,
  and comes from someone with the required role. Otherwise apply fails with `approval_invalid`.

## SQL functions (schema `app`, granted to authenticated + service_role)
`propose_change`, `edit_change`, `approve_change(p, 'approved'|'rejected'|'clarify')`, `apply_change`, `preview_reverse`,
`reverse_change(p, actor, paths)`, `search_entity_candidates`, `change_hash`. Service-role callers pass `p_actor` (the originating user).

## Exported services
- `src/lib/services/changes.ts`: `proposeChange(db, ws, input)` calls the `propose_change` RPC. Jobs pass `actorUserId`. Also exports `classifyRisk`,
  `MATERIAL_FIELDS`, `ChangeError`, `toChangeError`, `ForbiddenTargetError`. Signatures are unchanged; `before` is now ignored because the server snapshots the current values.
- `src/modules/changes/service.ts`: `approveChange`, `rejectChange`, `clarifyChange`, `applyChange`, `approveAndApply`, `editChange`,
  `previewReverse`, `reverseChange`, `previewBatchReverse`, `batchReverse` (newest first), `commitRoutine` (routine changes applied at once and undoable),
  `proposeMerge`, `proposePersonMove` (closes the prior employment and keeps it as history, creates a new one, copies no notes), `listQueue`, `getProposal`, `changeDigest`.
- `src/modules/capture/service.ts`: `createCapture`, `processCapture` (job body; optional injected `extractor`), `getReview`, `submitReview`,
  `listCaptures`, `reprocess`. `extract.ts`: the zod contract (schema_version 1), `ruleExtract` (the deterministic mock, which handles
  "spoke to Raj at Acme; 20k by March; maybe Baner; send options Friday") and `enforceRules` (applies the code rules to any model output).

## Capture rules
- Candidate IDs come only from `search_entity_candidates`, run as the capturing user. Model IDs that were not offered are dropped.
- Critical numbers and dates always need confirmation. Confusable number words ("fifty"/"fifteen" and similar), a month without a year, and a bare weekday each become a question.
  No proposal is created for such a fact until the question is answered. No material proposal is made until the company is resolved.
- Idempotency keys: interaction `source_message_id=capture:<id>`, tasks `capture:<id>:task:<n>`, proposals `capture:<id>:fact:<n>` or
  `capture:<id>:requirement` (one tentative-requirement create), and drafts `purpose=capture:<id>:draft:<n>`. Spans are upserted per claim.

## Job types
`capture.process` (payload `{captureId, force?}`, dedupe `capture.process:<id>`). The API and the server action also run it once inline;
after that the queued job does nothing unless forced.

## Routes
- `GET/POST /api/v1/captures`: JSON or multipart (`file`). POST needs an Idempotency-Key.
- `GET /api/v1/captures/[id]`; `GET/POST /api/v1/captures/[id]/review` (resolutions, answers, requirementId, text, done); `POST .../reprocess`.
- `GET/POST /api/v1/changes` (`kind: change|merge|person_move`); `GET /api/v1/changes/[id]`; `POST .../approve` (`decision`, `apply`).
- `POST .../apply`, `POST .../edit`, `GET|POST .../reverse`, `POST /api/v1/changes/reverse-batch` (`preview`).
- Pages: `/capture` (quick capture for note, voice or photo; recent captures), `/capture/[id]` (review: confirm entities, answer questions, accept or reject facts),
  `/approvals?tab=records|merges|drafts|documents|history` (before/after, stale warning, approve/reject/clarify/edit, undo, batch undo).

## Env
No module-specific environment variables. `OPENAI_API_KEY` empty means the rule extractor runs, and speech-to-text uses the typed note as the transcript.

## Tests
`npx vitest run src/modules/capture src/modules/changes tests/security/change-tamper.test.ts`

## Round 2 (Daily Debrief + Database Steward) — migration `20261101000200_capture_imports_round2.sql`
- **Extractor** (`extract.ts`, contract still `schema_version 1`, new arrays `promises`, `objections`, `stakeholders`, `details`):
  - bare amounts without a unit ("20k", "bees hazaar", "2 lakh") => `unit` question (sq ft vs ₹ per seat / ₹ total; option values
    `area_target_sf` | `budget_max|<budget_basis>`), never assumed; explicit units/₹ psf/per seat resolve directly (with `budget_basis`).
  - Roman-script **Hinglish** rules (no AI): "X se baat hui", "Acme ke Priya se mila", "March tak", "Baner ho sakta hai",
    "Friday ko options bhejna hai", "Raj Monday tak floor plan bhejega", "decision Raj lega"; Hindi number words (bees, pachaas, hazaar,
    lakh, dedh…), confusable saat/saath, satrah/sattar; Devanagari digits. The transcription prompt hint is unchanged.
  - promises (`who: "me"` for the user, else the name), objections, stakeholder roles (contract `STAKEHOLDER_ROLES`), and requirement
    details using contract keys: parking, power, transit, security_access, fitout_standard, tenure_months, lockin_months, expansion,
    employee_catchments.
- **Materialise**: every capture logs an interaction (`note` if no channel verb). Company not named => the CONFIRMED person's single
  current employer (re-checked visible) is used and flagged. Details => one `/constraints` proposal (`capture:<id>:details`, field_status
  `estimated`); roles => `stakeholder` link proposals once person + requirement are known. Tasks link to the interaction
  (`linked_entity_type='interaction'`) and carry `task.related_entities` [{type:'interaction'|'person'|'organisation', id}].
  `interaction.promises` = `{key, who, what, due ('YYYY-MM-DD' only when confirmed, else null + due_tentative), status:'open', ...}`;
  `interaction.objections` = `{key, text, status}`; statuses set later are preserved on re-processing.
- **Photo OCR**: `gateway.extractImageText` (Responses API vision, deterministic `mock`). Photo text is appended under a marker,
  spans use `photo_text:` locators, facts from it are `tentative` and reasons say "evidence only, not proof of terms".
- **Voice**: in-browser recorder (`ui/voice-recorder.tsx`, MediaRecorder webm/mp4) on `/capture`, alongside file upload.
- **Steward** (`changes/steward.ts`): `listConflicts`, `proposeConflictFix`, `dismissConflict`, `recordProvenance` (per-field applied
  changes + resolved evidence: file, staged row/locator, capture excerpt; flags untraceable material fields), `runStaleDetector`
  (windows in workspace_setting `steward.freshness_windows`, defaults org/person 180d, building 365d, availability 45d; one deduped task per
  record per verification date; notify owner via outbox), `markVerified`, `listStale`, `getFreshness`. UI: `FreshnessBadge`, `StewardNav`.
  Applying an `imports.person:*` proposal proposes the employment link (`afterApply` in `changes/service.ts#applyChange`).
- Pages: `/approvals/conflicts`, `/approvals/stale`, `/approvals/evidence?type=&id=`; API: `GET /api/v1/changes/conflicts`,
  `POST /api/v1/changes/conflicts/[id]` `{action: propose_fix|dismiss}`, `GET /api/v1/changes/provenance`, `GET/POST /api/v1/changes/freshness`.
- Tests: `extract-round2.test.ts` (spec sentence, unit question, Hinglish, Hindi numbers, promises/roles/details),
  `capture-round2.test.ts` (two Rajs, year + unit asked, task↔interaction, promise shape, budget basis, details/roles proposals, photo OCR).

## Known gaps
- Speech-to-text in mock mode cannot transcribe audio. A voice note without typed text waits in review until the user types the note.
- Hinglish coverage is rule-based (common phrasings, Roman script); Devanagari words other than digits are left to the model.
- Record pages (`/companies`, `/people`, `/buildings`, owned by admin) do not yet render `FreshnessBadge` / the evidence link.
- The documents tab lists `document_version` rows; the deals module owns their approval flow.

## Round 3 — Capture drop zone + Review queues (migration `20261111001200_capture_docs.sql`)
- Tables: `capture_document` (one per file, unique `(workspace_id, sha256)`; detected_type, detection, status
  received|processing|needs_review|needs_input|done|failed|unsupported, links, result) and `capture_transcript` (text, segments with
  start/end, has_timestamps, diarised=false ⇒ speakers uncertain). Both via `make_business_table`.
- `docs/detect.ts` (pure): file family + keyword rules; model (`callStructured`, mock = unknown) only when ambiguous.
- `docs/card.ts` (pure): `parseBusinessCard` (verbatim values only; phone types switchboard/direct/mobile/fax/unknown), `cardContactMethods`.
- `docs/service.ts`: `intakeDocument`, `intakeFromStorage`, `processDocument`, `updateAndReprocess`, `getDocument`, `listDocuments`, `linkOptions`.
  Routing: spreadsheet → `imports.uploadImport`; quotation → `toolkit.extractQuoteTerms` → `quote` create proposal (needs requirement link);
  lease/LOI → assistant `lease-terms` (page-verified snippets) → `lease` create proposal (fact_status reported); meeting notes → `createCapture`;
  business card → person/contact_method/organisation proposals (existing same-name org = uncertain match, not created);
  photo/layout → meeting material (`meetings.addUploadedMaterial`) and/or building link; audio → transcript → meeting_note + capture
  (`[mm:ss]` markers when segments have timestamps). Proposal keys `capture_doc:<id>:…`.
- `docs/review.ts`: `attentionQueues`, `listFailedJobs`, `retryJob` (admin, `mudar_app.retry_job`), `requestMoreInfo` (uses existing `clarify` state + task linked to the proposal).
- Job `capture.document` (payload `{documentId}`) — retry path, runs as the uploader.
- Routes: `/capture` (drop zone + recent files), `/capture/documents/[id]`, `/approvals` attention panel + "Request more info";
  `GET/POST /api/v1/captures/documents`, `GET/POST /api/v1/captures/documents/[id]`.
- Gaps: `gateway.transcribe` returns text only (no verbose_json) ⇒ no timestamps with the real key until the gateway exposes segments;
  no diarisation; contact methods for a NEW person are proposed after the person proposal is applied (press Process again);
  photos in mock mode have no OCR (user types card text); building photo is linked via capture_document only (no building gallery UI).

## Round 4 — Module 10 Input Engine (migration `20261111001900_input_engine_capture.sql`)
Gap analysis: `docs/input-engine/GAP.md` (148 spec items: before 48 DONE / 67 PARTIAL / 33 MISSING → after 138 DONE / 10 PARTIAL / 0 MISSING).
Spreadsheet engine (§3), batch reports (§10) and the import dashboard (§13C) stay with the imports module.

- **Tables** (both `make_business_table`): `capture_observation` — one row per extracted item with `intent` (§4.4), `fact_class`
  (confirmed|estimate|assumption|hypothesis|commitment|task|preference), `raw_text` (verbatim), `value_json` (null = unknown), `unit`,
  `pricing_basis`, `area_basis` (carpet|chargeable|super_built_up|unknown — never converted), `cam_treatment` (included|extra|unknown — never
  assumed), `date_class` (confirmed|estimated|informal), `missing[]`, subject + `links` + `match_confidence` (high|medium|low|none),
  `source_type`, `source_ref` {locator, start, end, page, timestamp, file_name, document_id}, `source_hash`/`content_hash`, `observed_at`,
  `extracted_at`, `verification`, `independent`/`repeat_of`/`corroborates` (rule 10), `version`/`conflict_with` (rule 6), `review_category`
  (§13D), `status` (auto_saved|pending_review|confirmed|rejected|corrected), `proposal_id`, `task_id`. Unique `(workspace_id, obs_key)`.
  `capture_correction` — append-only (UPDATE/DELETE revoked) history of value / transcript / association / status changes.
- **Pure** (`input-engine/`): `commercial.ts` (`extractCommercialTerms`, `classifyDates`, `pageAt`), `analysis.ts` (`classifyIntents`,
  `matchTier`/`matchAll`, `factClass`, `analyse`, `budgetQuestion`, `applyPermissions`, `buildReceipt`, hashes), `hindi.ts`
  (`romanise`, `detectLanguage`), `office.ts` (`pptxSlides`, `legacyOfficeText`).
- **Service** (`input-engine/service.ts`): `runInputEngine(admin, ws, captureId)` (after `processCapture`), `processAndAnalyse` (both;
  used by the action, `POST /api/v1/captures`, the job and drop-zone notes), `analyseDocument` (called from `processDocument` for every
  file: page/slide-referenced observations), `correctObservation`, `confirmObservation`, `rejectObservation` (also rejects the linked
  proposal when the user may), `associateObservation`, `createRecordFromObservation` (proposal), `requestClarification` (task),
  `correctTranscript`, `reviewQueue`, `captureHistory`, `dashboardCounts`, `observationsFor`, `correctionsFor`, `searchCaptures`,
  `loadPermissions`/`savePermissions`. `recording.ts`: `intakeRecording` (consent required → audio doc → Module 7).
- **Anil example**: "feet" is an area unit; "Budget is 85" is a budget fact with unknown unit/basis and ONE question
  "Budget "85" — does that mean ₹85 per sq ft per month? Is CAM extra?" (options carry `|cam_extra|cam_included|cam_unknown`);
  "by September" stays an informal target (its year question is optional: `meta.optional_questions`, skipped by `openQuestions`);
  "Friday" is auto-set to the next Friday (workspace tz, IST) when tasks may be auto-created; receipt lines saved / matched / proposed /
  questioned / scheduled. A requirement **create proposal** (key `capture:<id>:requirement`, same as the review path) is made only when the
  company is high-confidence (named + matched, or the single current employer of a high-confidence person).
- **Conflicts**: a different value for the same subject+field ⇒ new observation (version+1, `conflict_with`), earlier row untouched; a
  requirement column that differs (area/budget) ⇒ approval-gated proposal `input:<obs_key>:conflict`; event `commercial.offer_revised`.
- **Permissions** (workspace_setting `input_engine.permissions`, admin-only; defaults): `auto_save_internal_observations` true,
  `auto_create_tasks` true, `auto_associate_high_confidence` false. Material values and uncertain matches always wait for review.
- **Hindi**: Devanagari transcripts/notes are romanised for the rules; original kept in `extraction.meta.original_transcript`,
  `meta.language` en|hi|hinglish.
- **Business cards**: address + `uncertainCardFields`; `matchCardPerson` (same email/phone = high → no new person; same name = medium/low →
  suggestion only; none → new contact proposal).
- **Files**: PPTX (slides = pages) and legacy DOC/PPT (best effort) are new families in `detect.fileFamily`.
- **Events** (orchestrator `publishEvent`, deduped): `capture.processed`, `capture.task_scheduled`, `capture.failed`,
  `commercial.requirement_proposed`, `commercial.offer_revised`, `capture.quotation_extracted`, `contact.info_added`,
  `outreach.reply_received`, `meeting.notes_uploaded`. Business signals also go to `signals.ingestText` (company resolved).
  Objections become "Address objection" tasks (`capture:<id>:objection:<k>`).
- **Assistant**: tool `search_captures` (`src/modules/assistant/tools/captures.ts`, groups documents + briefs).
- **Routes**: pages `/capture` (dashboard: links incl. spreadsheet → `/imports`, permitted recording form, pending/processing counts,
  automation permissions for admins), `/capture/[id]` (receipt, intents, matches with confidence, extracted items with confirm / edit /
  reject / link / create / clarify, Hindi original, correction history), `/capture/documents/[id]` (observations with page refs, card match
  + uncertain fields), `/capture/review` (§13D queue), `/capture/history` (§13E). API: `POST /api/v1/captures/observations/[id]`
  `{action: confirm|reject|correct|associate|create|clarify}`, `GET /api/v1/captures/[id]/observations`, `GET /api/v1/captures/review-queue`,
  `GET /api/v1/captures/history`, `GET /api/v1/captures/search?q=&days=`, `POST /api/v1/captures/recordings` (multipart, `consent: true`),
  `GET/POST /api/v1/captures/settings`. Mutating routes require an Idempotency-Key.
- **Tests**: `npx vitest run src/modules/capture/input-engine` — `input-engine.test.ts` (pure) and `input-engine.db.test.ts`
  (§17 scenarios 1–9, 14–22, 25–30; fixtures PDF/DOCX/PPTX generated in-test, card images via injected OCR).
- **Matching (round 3)**: `input-engine/matching.ts` — `matchBuildings` (building/park suggestions in notes, never auto-linked),
  `tieBreakOrg` (parent/subsidiary relation or HQ city breaks same-name company ties, medium at most), `questionable` (outlier bands).
- **Known gaps**: see GAP.md "Remaining PARTIAL" (no OCR of scanned PDFs — page renderer `@napi-rs/canvas` not installed;
  no diarisation; layout drawings not interpreted). Legacy .doc/.ppt are best effort with an "Old format" note.
