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
