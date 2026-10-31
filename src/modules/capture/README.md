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

## Known gaps
- Speech-to-text in mock mode cannot transcribe audio. A voice note without typed text waits in review until the user types the note.
- There is no OCR for photos: the caption is the content.
- The documents tab lists `document_version` rows; the deals module owns their approval flow.
- The extractor recognises only requirement fields (area, seats, budget, occupation/decision date, locality). There is no stakeholder-role extraction yet.
