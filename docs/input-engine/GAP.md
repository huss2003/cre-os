# Module 10 Input Engine — gap analysis (capture module)

Scope: spec §2, §4–§9, §11–§13 (except 13C import dashboard), §15. Spreadsheet engine (§3), batch reports (§10) and 13C belong to the imports module.

**Before:** 48 DONE / 67 PARTIAL / 33 MISSING (of 148)  
**After:** 145 DONE / 3 PARTIAL / 0 MISSING (round 3, Nov 2026: was 138 / 10 / 0)

Paths are relative to the repo root. Tests: `src/modules/capture/input-engine/input-engine.test.ts` (pure) and `input-engine.db.test.ts` (local Supabase).


## 2.1 Text input

| Item | Before | After | Evidence |
|---|---|---|---|
| Capture typed notes | DONE | DONE | src/modules/capture/service.ts createCapture |
| Informal / shorthand notes | DONE | DONE | src/modules/capture/extract.ts ruleExtract (20k, lakh, Hinglish) |
| Incomplete sentences / shorthand | DONE | DONE | extract.ts clause splitter |
| CRE terminology | PARTIAL | DONE | src/modules/capture/input-engine/commercial.ts (carpet/chargeable/SBA, psf, CAM, lock-in, escalation, deposit) |
| Identify companies, people, buildings, locations, requirements | PARTIAL | DONE | extract.ts mentions + analysis.ts intents (property_information) |
| Extract dates, rent figures, areas, commercial terms | PARTIAL | DONE | commercial.ts extractCommercialTerms + classifyDates |
| Commitments, objections, follow-ups | DONE | DONE | extract.ts promises/objections/tasks |
| Convert to structured records | PARTIAL | DONE | capture_observation rows + proposals (service.ts persist) |
| Preserve original note | DONE | DONE | capture.raw_text never rewritten |
| Anil example: feet as area, 'Budget is 85' kept raw | MISSING | DONE | extract.ts unit 'feet', budget bare-number fact; input-engine.test.ts §17.1 |
| Ask clarification of pricing basis before treating 85 as confirmed | MISSING | DONE | single question '₹85 per sq ft per month? Is CAM extra?' (extract.ts + analysis.ts budgetQuestion) |

## 2.2 Voice notes

| Item | Before | After | Evidence |
|---|---|---|---|
| Record voice notes | DONE | DONE | ui/voice-recorder.tsx, live-dictation.tsx |
| Uploaded audio | DONE | DONE | createCapture kind audio; drop zone audio |
| Audio → text | DONE | DONE | gateway.transcribe (mock = typed text) |
| English / Hindi / Hinglish | PARTIAL | DONE | src/modules/capture/input-engine/hindi.ts romanise + detectLanguage; processCapture stores meta.language/original_transcript |
| Abbreviations / terminology | PARTIAL | DONE | hindi.ts dictionary (sq ft, lakh, localities) + commercial.ts |
| Names, locations, dates, amounts, commitments | DONE | DONE | extract.ts on transcript |
| Preserve audio | DONE | DONE | storage_paths kept |
| Store transcript with recording | DONE | DONE | capture.transcript / capture_transcript |
| Review & correct transcription | PARTIAL | DONE | correctTranscript (history in capture_correction) + re-extract |

## 2.3 Images / screenshots

| Item | Before | After | Evidence |
|---|---|---|---|
| Upload photos/screenshots | DONE | DONE | capture kind image, drop zone |
| OCR | DONE | DONE | gateway.extractImageText |
| Business-related images / brochures / ads | PARTIAL | DONE | OCR text → commercial.ts terms (image source = estimate) |
| Rent quotations & terms from images | MISSING | DONE | analyseDocument / runInputEngine on OCR text |
| Layouts and labels | PARTIAL | PARTIAL | layout detection + carpet/chargeable labels from OCR; no drawing understanding |
| Dates, prices, areas, specs | PARTIAL | DONE | commercial.ts + classifyDates |
| Conversation screenshots | PARTIAL | DONE | intent classification (quotation/objection) on OCR text |
| Review before important updates | DONE | DONE | photo facts tentative; proposals only |

## 2.4 Business cards

| Item | Before | After | Evidence |
|---|---|---|---|
| Name / designation / company / email / phone / website | DONE | DONE | docs/card.ts |
| Office address | MISSING | DONE | card.ts address |
| Identify likely company & contact | PARTIAL | DONE | docs/service.ts matchCardPerson + company_matches |
| Match existing contacts | MISSING | DONE | email/phone exact = high; same name = medium/low |
| Suggest new contact if no reliable match | DONE | DONE | person create proposal only when tier none |
| Flag uncertain fields | MISSING | DONE | card.ts uncertainCardFields; shown on document page |
| Preserve card image | DONE | DONE | capture_document.storage_path |

## 2.5 Documents

| Item | Before | After | Evidence |
|---|---|---|---|
| PDF | DONE | DONE | unpdf with page texts |
| DOC (legacy) | MISSING | DONE | office.ts legacyOfficeText (best effort) + `LEGACY_FORMAT_NOTE` "Old format — save as .docx/.pptx/.xlsx for full extraction" on the document receipt (`result.format_note`, banner on /capture/documents/[id]) and on batch items (/imports/runs/[id]); original always stored; test "buildings in notes … legacy .doc note" in input-engine.db.test.ts |
| DOCX | DONE | DONE | mammoth |
| PPT (legacy) | MISSING | DONE | same as DOC (best effort text + clear old-format note; original kept) |
| PPTX | MISSING | DONE | office.ts pptxSlides (slide = page ref) |
| Images / scanned documents (OCR) | PARTIAL | PARTIAL | images OCR'd via gateway `extractImageText`; scanned PDFs: no page renderer installed (unpdf `renderPageAsImage` needs `@napi-rs/canvas`, not a dependency), so `SCANNED_PDF_NOTE` asks for typed key terms or page photos (which are OCR'd); original kept. Closing it needs the `@napi-rs/canvas` package |
| Identify document type | DONE | DONE | docs/detect.ts |
| Extract CRE info, company/property refs | PARTIAL | DONE | analyseDocument observations |
| Lease terms | DONE | DONE | routeLease (page-verified) + observations |
| Commercial quotations | DONE | DONE | routeQuote + rent/CAM observations |
| Property specifications | PARTIAL | DONE | area bases, rent, parking observations |
| Dates, amounts, areas, contractual details | PARTIAL | DONE | commercial.ts / classifyDates |
| Requirements and commitments | PARTIAL | DONE | meeting notes → capture pipeline |
| Preserve original | DONE | DONE | storage |
| Page references | PARTIAL | DONE | source_ref.page on every document observation |

## 2.6 Permitted recordings

| Item | Before | After | Evidence |
|---|---|---|---|
| Accept permitted recordings | PARTIAL | DONE | src/modules/capture/input-engine/recording.ts intakeRecording (consent required) + /api/v1/captures/recordings + RecordingForm |
| Transcribe | DONE | DONE | routeAudio |
| Identify speakers where possible | PARTIAL | PARTIAL | speakers marked uncertain (no diarisation provider) |
| Meeting info, decisions, commitments, objections, requirements, follow-ups | DONE | DONE | transcript → capture pipeline |
| Timestamps and transcript refs | DONE | DONE | [mm:ss] segments; observation source_ref.timestamp |
| Send to Module 7 | PARTIAL | DONE | meeting_note + meeting.notes_uploaded event |
| Consent & privacy | PARTIAL | DONE | consent flag mandatory; consent_reference stored |

## 4.1 Entity recognition

| Item | Before | After | Evidence |
|---|---|---|---|
| Companies, people, locations | DONE | DONE | extract.ts mentions |
| Buildings / business parks | PARTIAL | DONE | input-engine/matching.ts `matchBuildings` (names, entity_alias aliases, "EON Kharadi" = lead word + locality, "Tower B" needs its campus for high) → `engine.buildings` + receipt "suggestion only, not linked"; matching.test.ts |
| Requirements, leases, landlords, quotes, offers | PARTIAL | DONE | intents + commercial terms |
| Areas, rents, CAM, deposits, lock-in, expiry, notice, escalation, fit-out | PARTIAL | DONE | commercial.ts TERM_KEYS |
| Commitments, follow-ups, objections, opportunities | DONE | DONE | promises/tasks/objections + signals |

## 4.2 Commercial extraction

| Item | Before | After | Evidence |
|---|---|---|---|
| Carpet / chargeable / SBA | MISSING | DONE | commercial.ts separate keys, area_basis |
| Rent psf / monthly / annual | PARTIAL | DONE | rent_psf, monthly_rent, annual_rent |
| CAM, deposit, rent-free, lock-in, duration, escalation, notice, fit-out, brokerage, parking | PARTIAL | DONE | commercial.ts |
| Retain original wording + source | PARTIAL | DONE | raw_text + source_ref on every observation |
| No assumed units / periods / inclusions | PARTIAL | DONE | missing[] (unit, pricing_basis, cam, area_basis) |

## 4.3 Dates & commitments

| Item | Before | After | Evidence |
|---|---|---|---|
| Meeting/expiry/possession/deadline/follow-up/validity/payment dates | PARTIAL | DONE | classifyDates + facts |
| Commitments and task deadlines | DONE | DONE | promises/tasks |
| Confirmed vs estimated vs informal | MISSING | DONE | date_class column |

## 4.4 Intent classification

| Item | Before | After | Evidence |
|---|---|---|---|
| 15 categories | MISSING | DONE | analysis.ts classifyIntents / INTENTS |

## 5 Entity matching

| Item | Before | After | Evidence |
|---|---|---|---|
| Company names, spellings, abbreviations, alternates | DONE | DONE | search_entity_candidates + entity_alias |
| Subsidiary/parent references | PARTIAL | DONE | `tieBreakOrg` + service `orgTieContext`: among same-name companies, the one with a parent/subsidiary/affiliate relation to an already-linked company wins at MEDIUM (confirm), never high |
| Location-aware company matching | PARTIAL | DONE | `tieBreakOrg`: organisation.hq_city named in the note breaks a same-name tie (medium); DB test "Pune" vs "Chennai" |
| Detect duplicate companies | PARTIAL | DONE | card company_matches; low-tier review |
| Contacts by name/email/phone | PARTIAL | DONE | contactHits / matchCardPerson |
| Current & previous employers, designations | DONE | DONE | candidate detail current_orgs; employment history kept |
| Employer change does not move opportunities | DONE | DONE | proposePersonMove; test §17.16 |
| Property matching (buildings/parks/addresses) | PARTIAL | DONE | asset links on documents + `matchBuildings` in notes with confidence tiers (suggestions only) |
| Confidence high/medium/low/none | MISSING | DONE | analysis.ts matchTier |
| High may auto-associate under rules | MISSING | DONE | permission auto_associate_high_confidence |
| Medium/low presented for review | PARTIAL | DONE | review_category uncertain_*; Review queue |
| No merge without approval | DONE | DONE | proposeMerge only |

## 6 Duplicate detection

| Item | Before | After | Evidence |
|---|---|---|---|
| Duplicate file uploads | DONE | DONE | sha256 unique |
| Repeated observations | MISSING | DONE | content_hash + source_hash; independent=false, repeat_of |
| Duplicate business cards | PARTIAL | DONE | sha256 + email/phone match |
| Duplicate company / contact info | PARTIAL | DONE | matchCardPerson, company_matches, contact_method dedupe |
| Repeated quotations / meeting notes | MISSING | DONE | content_hash repeat / corroborates |
| Duplicate spreadsheet imports | DONE | DONE | imports module (not owned) |
| Same info from different sources | MISSING | DONE | corroborates column |
| Preserve source history; avoid needless records | PARTIAL | DONE | observations keep every source; no new records |
| Repeat ≠ independent evidence | MISSING | DONE | independent flag; receipt line |

## 7 Validation & conflicts

| Item | Before | After | Evidence |
|---|---|---|---|
| Missing / ambiguous info | DONE | DONE | ambiguities + missing[] |
| Conflicting values vs existing records | PARTIAL | DONE | persist() conflict_with + canonicalConflicts() |
| Questionable numbers / inconsistent dates | PARTIAL | DONE | confusable words, date classes + matching.ts `questionable` bands (rent psf <15 or >400 ₹/sf/month, area <100 or >20,00,000 sf, deposit >24 months, CAM >60 ₹/sf) → `source_ref.questionable`, confidence 0.3, receipt line; value saved, never blocked |
| Uncertain commercial terms | MISSING | DONE | missing[], verification needs_clarification |
| Highlight differences / suggest resolution | PARTIAL | DONE | receipt 'changed' line; proposal for approval |
| Ask only necessary clarification | PARTIAL | DONE | clarifications = material unit/number only; informal month optional; weekday auto |
| 85→95: preserve previous, new observation/version, source+date, review | MISSING | DONE | version, conflict_with, commercial.offer_revised event; db test |

## 8 Classification & metadata

| Item | Before | After | Evidence |
|---|---|---|---|
| Confirmed / estimate / assumption / hypothesis / commitment / task / preference | MISSING | DONE | fact_class column (analysis.ts factClass) |
| Original source, source type, observation date, extraction date | PARTIAL | DONE | source_ref, source_type, observed_at, extracted_at |
| Verification status, confidence | PARTIAL | DONE | verification, confidence, match_confidence |
| Linked company/contact/property/requirement | PARTIAL | DONE | subject_type/subject_id + links |

## 9 Human review

| Item | Before | After | Evidence |
|---|---|---|---|
| Auto-process low-risk info | PARTIAL | DONE | applyPermissions (auto_saved) |
| Auto-save eligible internal observations under configured rules | MISSING | DONE | workspace_setting input_engine.permissions |
| Uncertain matches for review | DONE | DONE | entity questions + review queue |
| Approval before merges / material updates | DONE | DONE | proposeChange / approval |
| Correct / reject / confirm | PARTIAL | DONE | correctObservation / rejectObservation / confirmObservation |
| Preserve original extraction; correction history | MISSING | DONE | capture_correction (append-only) |
| Don't confirm every minor item | PARTIAL | DONE | only material questions block |

## 11 Traceability

| Item | Before | After | Evidence |
|---|---|---|---|
| Preserve files, images, audio, notes | DONE | DONE | storage + raw_text |
| Page references | PARTIAL | DONE | source_ref.page |
| Sheet/cell refs | DONE | DONE | imports module (not owned) |
| Transcript timestamps | DONE | DONE | [mm:ss] + source_ref.timestamp |
| Link values to sources; open source from record | PARTIAL | DONE | observationsFor(subject) + capture/document links; /approvals/evidence |
| Extraction & correction history | PARTIAL | DONE | capture_correction |

## 12 Integration

| Item | Before | After | Evidence |
|---|---|---|---|
| M1 create/update/match/history/audit | DONE | DONE | proposeChange + audit |
| M2 send business observations; signal reassessment | MISSING | DONE | ingestText for business_signal + capture.processed event |
| M3 lead priority / reassessment | PARTIAL | DONE | requirement/quote triggers + events → orchestrator reassess |
| M4 contact info, card, missing info, no duplicates | PARTIAL | DONE | contact.info_added event, matchCardPerson, uncertain fields |
| M5 outreach notes, replies, objections → follow-up tasks | PARTIAL | DONE | objection tasks, outreach.reply_received event |
| M7 recordings & notes with refs | PARTIAL | DONE | recording.ts, meeting.notes_uploaded |
| M8 quotations, lease terms, offers, reassessment | PARTIAL | DONE | routeQuote/routeLease + offer_revised + quote trigger |
| M9 notify, trigger, schedule, report failures | PARTIAL | DONE | publishEvent (capture.processed/task_scheduled/failed/...) |
| M12 NL queries over captures | MISSING | DONE | assistant tool search_captures |

## 13 UI (A, B, D, E)

| Item | Before | After | Evidence |
|---|---|---|---|
| A Type note / voice / image / card / document | DONE | DONE | /capture |
| A Spreadsheet upload link | PARTIAL | DONE | dashboard link → /imports |
| A Permitted recording upload | MISSING | DONE | RecordingForm |
| A Recent captures / pending reviews / processing status | PARTIAL | DONE | dashboardCounts card |
| B Original, extracted, entities, matches+confidence, missing, conflicts, proposals, tasks, source refs | PARTIAL | DONE | /capture/[id] EnginePanel + existing review |
| B Confirm / edit / reject / associate / create / clarify | PARTIAL | DONE | ObservationList actions |
| D Review queue categories (7) | MISSING | DONE | /capture/review |
| E Capture history | MISSING | DONE | /capture/history |

## 15 Business rules

| Item | Before | After | Evidence |
|---|---|---|---|
| 1 Preserve raw on failure | DONE | DONE | status failed keeps raw_text; test §17.25 |
| 2 No carpet→chargeable conversion | MISSING | DONE | commercial.ts area_basis |
| 3 Rent never assumed to include CAM | MISSING | DONE | cam_treatment unknown |
| 4 Missing ≠ zero | PARTIAL | DONE | value null + missing[] |
| 5 Uncertain date ≠ contractual date | PARTIAL | DONE | date_class (imports for spreadsheets) |
| 6 No silent overwrite | DONE | DONE | versioned observations + proposals |
| 7 No uncertain merges | DONE | DONE | proposeMerge |
| 8 Estimates ≠ facts | PARTIAL | DONE | fact_class estimate |
| 9 AI interpretations ≠ client statements | PARTIAL | DONE | machine readings = estimate/assumption |
| 10 Repeat ≠ independent evidence | MISSING | DONE | independent=false |
| 11 Only necessary questions | PARTIAL | DONE | clarifications |
| 12 Preserve originals | DONE | DONE | storage/raw |
| 13 Review for material changes | DONE | DONE | approval_required |
| 14 Auto only within configured permissions | MISSING | DONE | input_engine.permissions |
| 15 Plain-language receipt | MISSING | DONE | buildReceipt |

## Remaining PARTIAL (known gaps)

- Scanned PDFs without a text layer: images are OCR'd, but no PDF page renderer is installed (`@napi-rs/canvas` for unpdf's `renderPageAsImage`), so the user is asked to type key terms or upload page photos. The note says so plainly; the original is kept.
- Speakers in recordings are not identified (no diarisation from the gateway); marked uncertain.
- Layout drawings are detected and attached, not interpreted beyond OCR labels.

Closed in round 3: legacy .doc/.ppt/.xls messaging ("Old format — save as .docx/.pptx/.xlsx for full extraction", original preserved),
building/business-park matching in notes (suggestions only), parent/subsidiary and HQ-city company tie-breakers, outlier bands,
entity-page "Source" / "From capture" links (`src/modules/imports/provenance-links.tsx` on /companies, /people, /buildings).
