# Journey results: STAGE 8 (Module 12 assistant, 12.1–12.15) and §14 Integration Tests 1–5

- **Test date:** 2026-11-11 · **Environment:** local Supabase (shared), mock-AI mode (`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` empty), no browser, no `next build/dev`.
- **Test files:** `tests/journey/m12-assistant.test.ts` (15 cases) and `tests/journey/integration.test.ts` (5 cases).
- **Run:** `npx vitest run tests/journey/m12-assistant.test.ts tests/journey/integration.test.ts`
- **Fixture:** every run builds its own synthetic **ABC Technologies `<tag>`** in WS1 (tag from `tag()`):
  - **Company and occupancy:** the company, its current Kharadi campus and a lease of 15,000 SF (`fact_status=ai_inference`, an estimate) expiring in about 8 months.
  - **Contacts:** Rahul (Head of Admin, decision_maker, email `verified`), Priya (CFO, economic_buyer, no email) and Amit (IT Head, technical_evaluator, email `unverified`).
  - **Properties:** A, B and C, each with an availability snapshot and an immutable landlord quote (rent 95/82/78, CAM 10/14/16, rent-free 4/3/2, escalation 15%/36 months, 60-month term).
  - **Requirement and deal:** a requirement with target 25,000 SF (22k–28k), an opportunity, stakeholders and a shortlist.
  - **Signal:** with supporting evidence (ET, dated) and counter-evidence (a hiring freeze).
  - **Lead score:** from the real `scoreEntity("lead")`, which gave 57.
  - **Outreach:** a draft from the real `createOutreach`, plus an interaction that carries a promise.
  - **Meetings:**
    - Past meeting, with the note "Rahul said Property A is expensive" and the commitment "revised commercials for B and C by Friday".
    - Upcoming meeting with Rahul and Priya.
  - **Second company:** a Pune company whose lease has no expiry date (for 12.15).
- **Retest after fixes (2026-11-11):** `npx vitest run tests/journey/m12-assistant.test.ts tests/journey/integration.test.ts src/modules/assistant` run 3 times: journey 20/20 every run (no flakes); assistant module 164/167 every run — the same 3 failures as before the fixes, not in the changed code (see "Remaining failures" below). `npx tsc --noEmit` clean.
- **Original final run:** 20 tests: 17–18 pass and 2–3 fail. 12.6, 12.7 and IT5 fail **intermittently**: in 6 runs 12.6 failed 4 times, 12.7 failed 4 times and IT5 failed 2 times. The cause is the entity resolver's order-dependent name matching (D1 and D2 below). These tests are left asserting the correct behaviour so they work as regression tests.

## How mock-mode results are judged

In mock mode `MockProvider` (`src/modules/assistant/engine/mock.ts`) plans with a keyword intent (`engine/router.ts`) and a fixed `PLANS` table. For each case the test records:
- (a) the tools the mock picked;
- (b) whether the real-model path would be **offered** the expected tools (`selectTools` in `tools/select.ts`; the real model can also call `load_more_tools`);
- (c) the expected tool run directly through `executeTool`, which uses the same validation, permission, approval and logging path. This verifies the capability.

The verdict is **PARTIAL** when the capability works but the mock does not route to it. In that case the developer notes say whether the real Claude path would be offered the tool.

---

## STAGE 8 — Module 12

### 12.1 – Retrieve complete company intelligence
| Field | Value |
|---|---|
| ID / module / date | 12.1 / M12 / 2026-11-11 |
| User action / input | `runAssistant("Give me everything important about ABC Technologies <tag>.")` |
| Expected | Profile, locations, occupancy, contacts, stakeholders, signals, lead score, requirement, outreach, meetings, properties, commercials, commitments, next actions; nothing invented |
| Actual | Intent `company_summary`. The mock called `get_company_profile`, which returned ok with the correct `companyId`. The profile payload holds leases, scores, signals, contacts, interactions, requirements, opportunities, locations, documents and openTasks. The Missing card says "Headcount unknown". No invented contact or address. The mock did **not** call find_decision_makers, get_outreach_history, get_meeting_history, get_commitments or compare tools. The real path is offered all of those except `find_decision_makers` and `get_outreach_history` (the `outreach` group is not selected for `company_summary`). |
| Result | **PARTIAL** |
| Evidence | `/tmp/m12-results.json` → `12.1` (picked, realPathOffered, profileOutputKeys) |
| Error | — |
| Severity | MEDIUM (incomplete workflow) |
| Developer notes | 1) `src/modules/assistant/tools/select.ts` `BY_INTENT.company_summary`: add `"outreach"` (and `"deals"`), so the real model gets `find_decision_makers` and `get_outreach_history` without needing `load_more_tools`. 2) `engine/mock.ts` `PLANS.company_summary`: when `company` is resolved, also queue `get_research_signals`, `find_decision_makers`, `get_outreach_history`, `get_meeting_history` and `get_commitments` (all take `companyId`, and `fillInput` already maps it). |
| Retest | **PASS** (2026-11-11, 3/3 runs). Mock now calls get_company_profile, get_research_signals, get_scores (company), find_decision_makers, get_outreach_history, get_meeting_history (6 steps; commitments come with each meeting). `company_summary` now offers the `outreach` and `deals` groups on the real path. |

### 12.2 – Ask about research signals
| Field | Value |
|---|---|
| Input | "Why did we identify ABC Technologies <tag> as an opportunity?" |
| Expected | Signals, supporting evidence, dates, counter-evidence, hypothesis |
| Actual | Intent `general`. The words match only the `deals` group, so `selectTools` offers **no** `get_research_signals` to the real model (`realPathOffered: []`). The mock called `get_company_profile`. When run directly, `get_research_signals` returned the signal with its evidence date (`latest_evidence_on`), verification and recommended action. **Counter-evidence is not returned**: the tool never reads `signal_evidence` (role `counter`), so "Hiring freeze…" is absent and the source excerpts are absent too. |
| Result | **FAIL** (the counter-evidence and supporting excerpts requirements are not met) |
| Evidence | `12.2.counterEvidenceSurfaced=false`, `directStatus=ok` |
| Severity | MEDIUM (missing source references) |
| Developer notes | 1) `src/modules/assistant/tools/activity.ts` `get_research_signals.run`: after loading signals, load `signal_evidence` (`signal_id in ids`, columns role, source_name, source_url, excerpt, published_on). Return `support[]` and `counter[]` per item, and add a "Counter-evidence" table block. 2) `tools/select.ts` `BY_WORDS` scoring regex: add `why .*opportunit|identif|evidence`. 3) `engine/router.ts`: add a `research_why` rule (`/\bwhy\b.*\b(identif|opportunit|flag)/`) mapped in `mock.ts` `PLANS` to `get_research_signals` (needs company). |
| Retest | **PASS** (3/3). New intent `research_why` → get_research_signals + get_scores. The tool now returns supporting AND counter-evidence (source, date, excerpt) per signal, a flat `data.evidence` list and an "Evidence and counter-evidence" table; the answer quotes "Hiring freeze announced for Q1 in Bengaluru" as counter-evidence and labels the signal a hypothesis. Real path offered the scoring group. |

### 12.3 – Ask about prioritisation
| Field | Value |
|---|---|
| Input | "Why is ABC Technologies <tag> a high-priority account?" |
| Expected | Lead score, factors, relationship access, timing and freshness, missing info |
| Actual | Intent `priority_accounts`. The mock called `rank_priority_accounts`: a workspace-wide top 10 that does not contain ABC, with a coverage note. That is the wrong tool for a question about one account. The real path is offered `get_scores`. Run directly, `get_scores(company)` returns the lead score (57, real scoring service) with strengths/weaknesses factors and missing items. |
| Result | **PARTIAL** |
| Evidence | `12.3`: leadScoreFound, hasFactors and hasMissing are all true |
| Severity | MEDIUM (incorrect AI tool execution in mock) |
| Developer notes | `engine/mock.ts` `PLANS.priority_accounts`: put `{ ids: ["get_scores"], needs: ["company"] }` first and make `rank_priority_accounts` `unless: ["company"]` (`fillInput` maps `entityType`/`entityId` from `primary`). |
| Retest | **PASS** (3/3). `priority_accounts` with a named company → get_scores(company) with strengths/weaknesses/missing (lead 62, company 69 in the retest fixture) + its signals; `rank_priority_accounts` only when no company is named. |

### 12.4 – Find decision-makers
| Field | Value |
|---|---|
| Input | "Who are the important people we need to speak to at ABC Technologies <tag>?" |
| Expected | Profiles, roles, responsibilities, missing categories, verified vs unverified |
| Actual | Intent `general`, so the mock called `get_company_profile` only. The real path is offered `find_decision_makers` (outreach words "decision-maker"). Run directly, it returned Rahul, Priya and Amit with role classes and contact verify status (verified/unverified/none), and nothing invented. |
| Result | **PARTIAL** |
| Evidence | `12.4`: all three names present, verifyDistinction true |
| Severity | LOW–MEDIUM |
| Developer notes | `engine/router.ts`: add rule `["decision_makers", /\b(who (are|should)|important people|decision.?makers?|stakeholders?)\b/i]` and `mock.ts` `PLANS.decision_makers = [{ ids: ["find_decision_makers"], needs: ["company"] }]`. |
| Retest | **PASS** (3/3). New intent `decision_makers` → find_decision_makers. Output adds a per-person "Contact info" status (verified / unverified / no channel on record) and "Missing category" gaps (procurement, legal, HR/workplace…). |

### 12.5 – Generate outreach (follow-up to Rahul)
| Field | Value |
|---|---|
| Input | "Draft a short follow-up to Rahul <tag> based on our last meeting." |
| Expected | Correct contact, previous meeting, requirements and commitments, contextual draft, approval controls active |
| Actual | Intent `commitments` (the word "follow-up"). The mock called `get_commitments` with no company or person filter, which returned "0 commitment(s)". No draft was made. The real path is offered `get_meeting_history` and `generate_outreach_draft`. Run directly, `generate_outreach_draft(personId=Rahul, scenario=meeting_followup)` returned ok: "Drafted 1 outreach item(s) — not sent", with a duplicate warning ("There is already a draft Email"). All of Rahul's drafts are in state `drafted` and none is sent. |
| Result | **PARTIAL** (S3 no-send verified) |
| Evidence | `12.5.draftStates=["drafted","drafted"]` |
| Severity | MEDIUM |
| Developer notes | 1) `engine/router.ts`: add a rule before `commitments`: `["outreach_draft", /\b(draft|write|prepare)\b.*\b(follow[- ]?up|email|message|note)\b/i]`. 2) `mock.ts` PLANS: `[{ ids:["get_meeting_history"], needs:["person"] }, { ids:["generate_outreach_draft"], needs:["person"] }]`. Note that `fillInput` does not fill `channels` (required), so add `else if (k === "channels") v = ["email"]`. 3) `tools/select.ts` outreach regex: add `follow.?up`. |
| Retest | **PASS** (3/3). New intent `outreach_draft` → get_meeting_history(person) then generate_outreach_draft(person, email, meeting_followup). The answer names the last meeting and its commitment ("revised commercials for Property B and Property C by Friday") and says draft only; all Rahul drafts stay `drafted`. |

### 12.6 – Meeting preparation
| Field | Value |
|---|---|
| Input | "Prepare me for my next meeting with ABC Technologies <tag>." |
| Expected | The **next** meeting, company and attendees, previous interactions, requirement and properties, commitments, questions |
| Actual | `generate_meeting_brief`, `get_company_profile` and `get_commitments` all ran ok for the right company. The commitments include "…by Friday". **Intermittently (4 of 6 runs) the brief was generated for the past meeting** ("options discussion", 3 days ago) instead of the upcoming one. The name resolver matches both meeting titles, `PLANS.meeting_prep` uses whichever resolved meeting comes first, and it ignores "next". |
| Result | **FAIL** (intermittent) |
| Evidence | `12.6pre`: input `meetingId` = past `meeting_visit_id` |
| Severity | HIGH (incorrect AI tool execution / wrong historical record) |
| Developer notes | `engine/mock.ts` `PLANS.meeting_prep` and `slotsFrom`: only use a resolved `meeting` whose `start_at >= now` when the request says next/upcoming/tomorrow; otherwise fall through to `get_upcoming_meetings`. The `start_at` is in `pkg.records`. `engine/context.ts` `searchEntities`: sort meeting hits by `start_at` ascending among future rows. |
| Retest | **PASS** (3/3, was 2/6). Weak tag-token meeting matches are no longer resolved; for "next/upcoming" a resolved meeting is used only if `start_at >= now`, otherwise get_upcoming_meetings picks the company's next meeting. Brief generated for the upcoming meeting every run. |

### 12.7 – Commercial analysis
| Field | Value |
|---|---|
| Input | "Compare Property A, Property B, Property C — which is financially better?" and the literal "Which of the three properties is financially better?" in the same conversation |
| Expected | Correct properties, Module 8 service, terms compared, total cost, assumptions and missing, explanation; no invented maths |
| Actual | The mock called `compare_properties` (Module 8 `runComparison`, formula `rating-1.0`, saved and versioned analysis). The result was reproducible across two runs. The calculator is correct: I checked effective occupancy by hand. A = (36×95 + 24×109.25 − 4×95)/60 + 10 = **104.37**; B = **96.82**; C = **96.08** ₹/sf/month, matching the output. Missing items are listed (micro-market, metro, amenities). **Defect (4 of 6 runs):** "Property B" resolved to a different asset (the ABC current campus). `candidatePhrases` drops "Property" (a STOP word) and single-letter tokens, so the B/C letters are lost and the tag token matches other assets. A **second issue:** the rating recommends **A**, which has the *highest* occupancy cost, "led by commercials and area fit". For "financially better" the answer should come from the occupancy cost or lease economics (C is cheapest). |
| Result | **FAIL** (intermittent wrong property). Calculator: PASS. |
| Evidence | `12.7direct` (ranks, occupancyCost, reproducible=true), `12.7pre` (wrong asset id) |
| Severity | HIGH (wrong property in a commercial comparison) |
| Developer notes | 1) `engine/context.ts` `candidatePhrases`: keep capitalised runs **before** stop-word filtering when they contain a single capital letter or digit suffix (e.g. "Property A"). Also search the raw run against the label with `ilike`, and score exact full-label matches highest. 2) `engine/mock.ts` `compose` for `compare_properties`: when the request says financially/cheaper/cost, also call `calculate_lease_economics` from the quotes, or state "ranking is a weighted rating; the lowest occupancy cost is X" using the tool's `occupancyCost` (no arithmetic). 3) `tools/toolkit.ts` `compare_properties` description: tell the model to use `calculate_lease_economics` or `occupancyCost` for "financially better". |
| Retest | **PASS** (3/3, was 2/6). "Property A/B/C <tag>" are kept as whole phrases and match exactly; ABC current campus is no longer pulled in. compare_properties now returns `byOccupancyCost` + a "Financial ranking" table; the answer ranks C (96.08) < B (96.82) < A (104.37) for "financially better" and states the weighted rating separately. The literal follow-up "Which of the three properties…" routes to compare_properties via the conversation's properties. |

### 12.8 – Multi-module deal review
| Field | Value |
|---|---|
| Input | "Prepare ABC Technologies <tag> for a complete deal review." |
| Expected | M1, M2, M3, M4, M5, M7 and M8 coordinated; account, opportunity, stakeholders, requirement, comparison, commercials, issues, next actions |
| Actual | `search_opportunities`, then `generate_deal_review` (category B) on the correct opportunity. Sections: Account, Stakeholders (with gaps: procurement and legal not involved), Requirement (25,000 SF, open fields), Options (A/B/C shortlisted with fit), Commercials, Open issues, Commitments, Next actions. **Not covered:** research signals (M2), lead score (M3) and outreach history (M5). The message says "verified vs inferred". |
| Result | **PARTIAL** |
| Evidence | `12.8.reviewText` |
| Severity | MEDIUM (incomplete workflow) |
| Developer notes | `src/modules/assistant/tools/actions.ts` `generate_deal_review.run`: add "Signals" (`signal` by `org_id`, top 3 with verification and date), "Priority" (`score_result` model `lead` and `opportunity`) and "Outreach" (last 3 `outreach_item` and interaction) sections. All are read via `db(t)` (RLS). |
| Retest | **PASS** (3/3). generate_deal_review now adds Commercial comparison (quote terms + occupancy-cost order from the saved comparison), Signals (with supporting/counter counts), Priority and deal health (lead + opportunity scores), stakeholder role classes, Outreach history, Meetings (last/next + open commitments). The mock also runs signals/scores/decision-makers/outreach tools. |

### 12.9 – Historical information
| Field | Value |
|---|---|
| Input | "What did Rahul <tag> say about Property A <tag> during our last meeting?" |
| Expected | Meeting note retrieved, exact original reference, no invented quote, confirmed vs interpretation |
| Actual | Intent `general`. The mock called `get_company_profile` for "Pune Widgets <tag>", a **different company**, because the request's tag token matched it (company hits get +1). The real path is offered `get_meeting_history`. Run directly with `personId=Rahul`, it returned the exact note "Rahul said Property A is expensive" with its date. The mock's answer invented no quote. |
| Result | **PARTIAL** (wrong company touched in mock; capability ok) |
| Evidence | `12.9`: text "Profile of Pune Widgets…", directStatus ok |
| Severity | HIGH in mock (wrong company association). The real path is likely fine. |
| Developer notes | 1) `engine/router.ts`: add `["history", /\b(what did|said|say about|mentioned)\b/i]` and `mock.ts` `PLANS.history = [{ ids:["get_meeting_history"], needs:["person"] }, { ids:["get_meeting_history"], needs:["company"], unless:["person"] }]`. 2) `engine/context.ts` `searchEntities`: do not add the `+1` company bonus when a person hit has a higher score. |
| Retest | **PASS** (3/3). New intent `history` → get_meeting_history(person). The answer quotes the stored note "Rahul said Property A is expensive" with the meeting title and date, labelled as recorded wording; no other company is touched (weak tag matches dropped). |

### 12.10 – Memory and conversation continuity
| Field | Value |
|---|---|
| Input | Turn 1: "Show the requirement ABC <tag> Pune expansion". Turn 2 (same conversation): "Use the same requirement and compare two new properties." |
| Expected | Same requirement identified, preferences reused, record retained, asks only for the genuinely missing input |
| Actual | The requirement is stored in the conversation `entity_refs` (true), and there is still exactly one requirement (no duplicate). Turn 2 called `search_properties` and returned "232 spaces match… Showing 2". It **picked 2 arbitrary properties** instead of asking which two new properties. `get_requirement_details` was not called, and the requirement was not passed. |
| Result | **PARTIAL** |
| Evidence | `12.10` |
| Severity | MEDIUM (incorrect recommendation) |
| Developer notes | `engine/mock.ts` `PLANS.compare_properties`: when `requirement` is resolved and `assets` are empty, call `get_requirement_details`. Then `compose` must ask "Question: which two properties should I compare?" instead of using `search_properties` results. Also `fillInput` should pass `requirementId` to `search_properties` if the schema has it. |
| Retest | **PASS** (3/3). "the same requirement" now resolves from the conversation; the mock calls get_requirement_details and answers "Question: which properties should I compare against …?" instead of picking two buildings. Still exactly one requirement. |

### 12.11 – Contextual assistant (page focus)
| Field | Value |
|---|---|
| Input | "Summarise this company/contact/property/requirement/opportunity." with `focus` set to each record |
| Expected | The page record is used, without typing a name; no entity confusion |
| Actual | Company page: `get_company_profile(focus id)` ok. **Contact, property, requirement and opportunity pages:** the mock called `search_companies` with no focus id, so it **ignored the page**. No other entity was mixed in (`confusedWith=[]`). The real path does get the focus record in its context (`buildContext` adds it), and `BY_FOCUS` offers `get_contact_profile`, `get_property_details`, `get_requirement_details` and `get_opportunity_details`. |
| Result | **PARTIAL** (company PASS; the other 4 page types FAIL in mock) |
| Evidence | `12.11.pages` |
| Severity | HIGH (incorrect AI tool execution) |
| Developer notes | `engine/mock.ts` `PLANS.company_summary` and `general`: prepend focus-typed profile needs: `{ids:["get_contact_profile"],needs:["person"]}`, `{ids:["get_property_details"],needs:["assets"]}`, `{ids:["get_requirement_details"],needs:["requirement"]}`, `{ids:["get_opportunity_details"],needs:["opportunity"]}`, and gate `search_companies` with `unless` on all of them. `slotsFrom` already puts focus into those slots. |
| Retest | **PASS** (3/3). Contact/property/requirement/opportunity pages → get_contact_profile / get_property_details / get_requirement_details / get_opportunity_details with the focus id; company page → company profile + account picture. No confusion. |

### 12.12 – Multi-step action
| Field | Value |
|---|---|
| Input | "Prepare a follow-up for Rahul <tag>, create an internal reminder for Friday and update the deal review." (opportunity page) |
| Expected | Draft, reminder, deal review, each action reported, nothing sent, partial failures reported |
| Actual | The mock ran only `generate_deal_review` (ok). Its status block reports only that step, and it does not say that the other two requested actions were not done. Run directly, both `generate_outreach_draft` and `create_internal_task` (due on the coming Friday) returned ok. No draft was sent. The real path is offered `create_internal_task` and `generate_deal_review` but **not** `generate_outreach_draft` (follow-up is not an outreach keyword; `load_more_tools` would be needed). |
| Result | **PARTIAL** |
| Evidence | `12.12.statusBlock`, `done` |
| Severity | MEDIUM (incomplete workflow; the unperformed sub-tasks are not reported) |
| Developer notes | 1) `tools/select.ts` outreach regex: add `follow.?up`. 2) `engine/mock.ts`: split multi-clause requests on `,`/`and` and plan per clause, or at minimum have `compose` list unrouted clauses under "Not completed". 3) `engine/run.ts`: no change needed (status aggregation works). |
| Retest | **PASS** (3/3). From the deal page the mock runs generate_deal_review, generate_outreach_draft (Rahul, meeting_followup, linked to the deal) and create_internal_task ("Follow up Rahul …", due the coming Friday). Any requested clause that cannot run is listed as "Not completed: … — reason". Nothing sent; `follow-up` now selects the outreach group on the real path. |

### 12.13 – Permission test
| Field | Value |
|---|---|
| Input | User `other` (WS2 owner): "Show me that company's lease information." with focus = ABC company id (WS1) |
| Expected | Backend denies, nothing confidential returned, attempt logged |
| Actual | Run status `partial`. The message contains neither the ABC name nor "15000". A direct `lease` select by id returns 0 rows (RLS). A direct `organisation` select returns 0 rows. `assistant_security_event` (WS2) recorded `access_denied` with the focus id. The text says "not found or you do not have access". |
| Result | **PASS** |
| Evidence | test 12.13 assertions; `12.13.securityEvents=["access_denied"]` |
| Severity | — (would be CRITICAL if it failed) |
| Developer notes | — |
| Retest | **PASS** (3/3, unchanged) |

### 12.14 – Incorrect information correction (25,000 → 30,000 SF)
| Field | Value |
|---|---|
| Input | "The client's requirement is now 30,000 SF, not 25,000 SF." (requirement page) |
| Expected | Correct requirement, change proposed, confirmation, old value preserved, linked to source, downstream recalc possible |
| Actual | Intent `general`. **The mock called `get_company_profile` on an unrelated company ("Acmeeng-…")**: the token "SF" matched "…k2y**sf**g" via `ilike %SF%`. It never proposed a change. The real path is **not offered** `update_requirement_record` ("now" and "not" do not match the `changes` regex). Direct path: `update_requirement_record` with key `area_target_sf` produced an approval whose **diff was empty**, and after approval it **failed** with "unknown requirement field: area_target_sf". That key is advertised in the tool's own description; the Deals contract key is `area` = [min, target, max]. Retried with `area=[22000,30000,33000]`: `needs_approval`, and the requirement was unchanged (25,000) until approved. After approval it was executed and area_target_sf = 30,000. `audit_event` `update` holds `before.area_target_sf=25000` (old value preserved), and the approval row stores the reason "Client said…". No `change_proposal` was created, although the description says client-confirmed fields go to Review. Downstream recalculation was not triggered or observed. |
| Result | **FAIL** (wrong entity in mock; misleading key in the real-path tool description; change not routed through Review as documented). The approval gate and history work. |
| Evidence | `12.14pre.firstAttempt=failed`, `12.14` (areaAfterApproval 30000, proposals [], auditActions [update, insert]) |
| Severity | HIGH (incorrect AI tool execution; a real model following the description fails) |
| Developer notes | 1) `src/modules/assistant/tools/changes.ts:65` description: replace "area_target_sf" with `area ([min,target,max])` and list `FIELD_BY_KEY` keys. In `plan()`, **reject** unknown keys (return an error) instead of creating an approval with an empty diff (currently line 73 only mentions them in the explanation). 2) `engine/context.ts` `candidatePhrases`: drop all-caps unit tokens (`SF`, `SQ`, `FT`, `INR`, `RS`) and require ≥3 chars for `ilike`. 3) `engine/router.ts`: add `["requirement_correction", /\b(requirement|seats|sf|sq\.? ?ft|area|budget)\b.*\b(now|not|instead|changed)\b/i]` → `mock.ts` PLANS `[{ids:["update_requirement_record"],needs:["requirement"]}]` with a numeric parser. 4) `tools/select.ts` `changes` regex: add `\bnow\b.*\bnot\b|\binstead of\b`. 5) Deals owner: confirm whether client_confirmed edits through the assistant approval should also create a `change_proposal` (README/description says yes, behaviour says no). |
| Retest | **PASS** (3/3). New intent `requirement_correction` parses "now 30,000 SF, not 25,000 SF" → update_requirement_record {key:"area", value:[22000, 30000, 30000]} (bounds widened only where the target falls outside). Unknown keys (e.g. `area_target_sf`) are rejected by input validation with the list of valid keys — no empty-diff approval. On approval the tool files a `change_proposal` (state `proposed`, before-snapshot area_target_sf 25,000, reason includes "source: assistant conversation <id>, run <id>"); the requirement stays 25,000 until Review applies it. "SF" no longer matches company names. Real path offered the `changes` group. |

### 12.15 – Failed task (coverage limitation)
| Field | Value |
|---|---|
| Input | "Show me all Pune companies with lease expiries in the next 12 months." (the fixture includes a Pune company whose lease has no expiry) |
| Expected | Available records retrieved, incomplete ones identified, no claim of completeness, coverage explained |
| Actual | `find_leases_expiring(windowMonths=12)` returned 77 leases, page of 10. Coverage: "1000 companies checked; 877 have no lease record. 31 have a lease without an expiry date." The answer says "not a complete market list", and a Missing card is shown. Caveats: (a) "Pune" is not applied as a filter; the result is workspace-wide and does not say so. (b) The check is capped at 1000 companies while WS1 has about 1,380; the note says "1000 checked", which is honest but not flagged as truncation. |
| Result | **PASS** (with LOW notes) |
| Evidence | `12.15.coverage` |
| Severity | LOW |
| Developer notes | `src/modules/assistant/tools/database.ts` `find_leases_expiring`: add an optional `city`/`geography` input, have the planner fill it from "Pune", and when the org cap (1000) is hit, add "only the first 1000 companies were checked" to `missing`. |
| Retest | **PASS** (3/3). The mock now passes `place: "Pune"` (filter applied, note says "Filtered to \"Pune\""), and the coverage note/missing list flag when the 5,000-company cap is reached; whole-workspace runs say "Not filtered by place". |

---

## §14 Cross-module integration tests (real services, mock AI)

### IT1 – Signal → outreach
| Field | Value |
|---|---|
| Action | `ingestText` (announcement naming the existing company), then `signalDetail`, `scoreEntity("lead")`, `setRole(decision_maker)`, the `find_decision_makers` tool, and `createOutreach(signalId)` |
| Expected | Company, evidence, score and contact flow M1→M5 |
| Actual | The signal matched the **existing** org: one org with the tag, no duplicate. Verification `hypothesis` (not claimed as fact), 1 evidence row. Lead score 51 (Medium, 7 factors). Decision-maker result: "1 decision-maker(s)". The outreach item is linked to the person, the org and the signal, with reason "I noticed **reports of** ABC…: possible expansion". The draft is `drafted` and addressed to the verified email. |
| Result | **PASS** |
| Evidence | `/tmp/integration-results.json` → `IT1` |
| Severity / notes | — |

### IT2 – Outreach → meeting
| Field | Value |
|---|---|
| Action | `requestApproval`, then `approve(content_hash)`, `openForSend` (returns `mailto:` only), `markSent` (the user marks it sent), `recordResponse` (synthetic reply), `createMeeting`, `generateBrief` |
| Actual | The reply was classified `meeting`, with 1 task and 1 opportunity proposal (not a direct write). The meeting prep is linked to the org and the opportunity, Rahul is an attendee, the brief is v1 `brief_ready`, and the brief references the prior email and Kharadi. |
| Result | **PASS** |
| Evidence | `IT2` |

### IT3 – Meeting → requirement
| Field | Value |
|---|---|
| Action | `addNote` ("280 seats, move in 2027-06-01"; commitment), then `structureOutcome`, `applyOutcome`, `approveAndApply` (change proposals), `scoreEntity("requirement")`, `getRequirementDetail` |
| Actual | Extracted `seats_target=280` and `occupation_date=2027-06-01`, each with its quote. `applyOutcome` gave 1 proposal, 1 task and 1 interaction, and seats_target **stayed null until approved** (no silent overwrite). After approval: 280 and 2027-06-01. Readiness score 50 (Medium), missing: micro-market, budget, lease duration, furnishing, decision-maker. The requirement detail (brief) is returned. Still exactly **1 requirement** for the org. |
| Result | **PASS** |
| Evidence | `IT3` |

### IT4 – Requirement → commercial proposal
| Field | Value |
|---|---|
| Action | `createQuote` ×3, then `runShortlist`, `compare_properties` ×2, `calculate_lease_economics` (3 offers), `generate_deck` |
| Actual | Shortlist v1: all 3 spaces eligible. The comparison is identical across two runs (B 91.9 / C 89.7 / A 85.7; occupancy 94.82 / 90.78 / 107.95). Lease economics `lease-1.0`: month-1 rent for A = 24,000 × 95 = **2,280,000**, checked by an independent assertion. Totals, NPV, deposit and rent-free benefit are returned. Gaps are listed (parking, other opex) and `complete=false` (unknown stays unknown). Deck v1 generated (download, nothing sent). |
| Result | **PASS** |
| Evidence | `IT4`, `IT4le` |
| Notes | LOW: the `discountRatePct` field is required in `leaseTermsSchema` without a default (the first attempt failed with "invalid_input"). Consider defaulting it to the workspace setting, labelled as assumed (`src/modules/assistant/tools/toolkit.ts:38`). |
| Retest | **PASS** (3/3). `discountRatePct` is now optional in the lease-terms schema; when omitted the workspace setting (`toolkit.discount_rate_pct` / `discount_rate_pct`) or 10% is used and shown in Assumptions ("Discount rate 10% assumed …"). |

### IT5 – Complete AI assistant workflow
| Field | Value |
|---|---|
| Input | "Review ABC Technologies <tag>, identify why it is a relevant opportunity, show me the important decision-makers, summarise our last interaction, compare the three properties against its requirement and prepare the next actions." |
| Expected | M1, M2, M3, M4, M5, M7 and M8 used coherently without opening modules |
| Actual | Intent `deal_review`; the mock ran a single `generate_deal_review`. Covered: M1 (account, requirement), M4 (stakeholders and gaps), M7 (commitments), M8 (options, commercials), next actions. **Not covered:** M2 signals and "why relevant", M3 score, M5 outreach history, last-interaction summary, and a fresh property comparison. **In 2 of 6 runs the review was generated for a different "ABC Technologies" company's deal**: the request's tag had no uppercase letter or digit, so only "ABC Technologies" was searched and the first of several matches was taken without asking. From the company page (focus) the right deal is always used. |
| Result | **FAIL** (intermittent wrong company; incomplete module coverage) |
| Evidence | `IT5`, `IT5focus` (`usedRightDeal=true`, viaTool M1 only) |
| Severity | **CRITICAL** when the wrong company is used (wrong company association). Otherwise MEDIUM. |
| Developer notes | 1) `src/modules/assistant/engine/context.ts` `searchEntities` and `buildContext`: when two or more companies tie on the top score, do **not** resolve. Add `missing: "Several companies match '<phrase>' — which one?"` and have the mock `compose` start with `Question:`. 2) `candidatePhrases`: include lowercase tokens with a hyphen or digit (the `/[A-Z0-9]/` test drops them), and query the full capitalised run plus the trailing token. 3) Coverage: extend `generate_deal_review` (see 12.8). In `mock.ts`, for multi-clause deal_review requests, also queue `get_research_signals`, `get_scores`, `find_decision_makers`, `get_outreach_history` and `compare_properties` (with the shortlist asset ids) when a company is resolved. |
| Retest | **PASS** (3/3, was 4/6). The request tag is honoured ("ABC Technologies int-xxxx" exact match); ties between several equally-matching companies now produce a "Question: several companies match … — which one?" with the candidates instead of picking the first (unit-tested in `engine/resolve.test.ts`). Coverage: search_opportunities → generate_deal_review plus get_research_signals (M2), get_scores (M3), find_decision_makers (M4), get_outreach_history (M5), get_meeting_history (M7); M8 comparison appears inside the deal review's Commercial comparison section (no fresh compare run). |

---

## Summary of results

| ID | Result | Severity | Retest (3 runs) |
|---|---|---|---|
| 12.1 | PARTIAL | MEDIUM | PASS |
| 12.2 | FAIL | MEDIUM | PASS |
| 12.3 | PARTIAL | MEDIUM | PASS |
| 12.4 | PARTIAL | LOW–MED | PASS |
| 12.5 | PARTIAL | MEDIUM | PASS |
| 12.6 | FAIL (intermittent) | HIGH | PASS |
| 12.7 | FAIL (intermittent; calculator PASS) | HIGH | PASS |
| 12.8 | PARTIAL | MEDIUM | PASS |
| 12.9 | PARTIAL | HIGH (mock) | PASS |
| 12.10 | PARTIAL | MEDIUM | PASS |
| 12.11 | PARTIAL | HIGH | PASS |
| 12.12 | PARTIAL | MEDIUM | PASS |
| 12.13 | PASS | — | PASS |
| 12.14 | FAIL | HIGH | PASS |
| 12.15 | PASS | LOW | PASS |
| IT1 | PASS | — | PASS |
| IT2 | PASS | — | PASS |
| IT3 | PASS | — | PASS |
| IT4 | PASS | LOW | PASS |
| IT5 | FAIL (intermittent) | CRITICAL / MEDIUM | PASS |

**Root causes, in priority order:**
- **D1:** the name resolver (`engine/context.ts` `candidatePhrases`/`searchEntities`) matches substrings (e.g. "SF" in names), drops "Property" and single letters, ignores lowercase tagged tokens, and picks the first of several ties without asking. This caused the wrong company or property in 12.7, 12.9, 12.14 and IT5.
- **D2:** the mock planner (`engine/mock.ts` + `engine/router.ts`) has no intents for signals-why, decision-makers, history quotes, outreach drafts or requirement corrections. It ignores non-company page focus, and it ignores "next" for meetings.
- **D3:** in tool selection for the real path (`tools/select.ts`), `follow-up` and `why…opportunity` do not pull in the outreach and scoring groups, and corrections phrased as "now X, not Y" do not pull in the `changes` group.
- **D4:** `update_requirement_record` advertises an invalid key (`area_target_sf`) and accepts unknown keys into an approval with an empty diff.
- **D5:** `get_research_signals` omits counter-evidence and supporting excerpts.

**Fixes (retest 2026-11-11, all in `src/modules/assistant/**`):**
- **D1 fixed** (`engine/context.ts`): unit tokens (SF, sqft, sq ft, ₹, psf, INR…) and bare numbers are dropped; "Property A"/"Tower B" style names stay together; lowercase tag-like tokens (hyphen/digit) are kept and continue a capitalised run; ranking is exact > prefix > contains; single-token partial matches are weak and dropped when any strong match exists; ties between several records of one type (not buildings/meetings) are not resolved — the context carries `ambiguous` and the mock answers "Question: several companies match … — which one?" with the candidates. Unit tests: `engine/resolve.test.ts` (20 tests incl. routing/selection/parsers).
- **D2 fixed** (`engine/router.ts`, `engine/mock.ts`): intents `research_why`, `decision_makers`, `history`, `outreach_draft`, `requirement_correction`; named-account priority → get_scores; "next meeting" uses only future meetings; page focus for contact/property/requirement/opportunity; multi-clause requests run the follow-up draft and reminder and report unrouted clauses as "Not completed".
- **D3 fixed** (`tools/select.ts`): follow-up/stakeholder words → outreach; why…opportunity/identify/evidence → scoring; "now X, not Y"/"instead of" → changes; company_summary includes outreach and deals.
- **D4 fixed** (`tools/changes.ts`): description lists the real Deals keys (area/seats = [min,target,max], budget = [min,max]…); unknown keys and malformed ranges are rejected at input validation (before an approval exists); after approval the change is filed with `proposeChange` → a `change_proposal` with the before-snapshot and the assistant conversation/run as source.
- **D5 fixed** (`tools/activity.ts`): supporting and counter-evidence with source, date and excerpt, plus a flat evidence list and table.
- Also: `generate_deal_review` now covers signals, lead score + deal health, stakeholder role classes, outreach history, meetings + open commitments and a commercial comparison (`tools/actions.ts`); `compare_properties` returns an occupancy-cost ranking separate from the weighted rating (`tools/toolkit.ts`); `discountRatePct` defaults to the workspace setting or 10% (shown as an assumption); `find_leases_expiring` gets the place from the request and flags the company cap / unfiltered scope (`tools/database.ts`); find_decision_makers shows verified/unverified contact status and missing buying-group categories.

**Remaining failures in `src/modules/assistant` (unchanged before/after, not caused by these fixes):**
- `data/landlord-offer.test.ts` and `data/data.db.test.ts` (landlord offer with fit-out allowance): `InputRangeError: A+fitout: Amount must be between 0 and …` thrown by the shared toolkit calculator `src/modules/toolkit/calc/landlord-offer.ts` (read-only for the assistant; owner: toolkit).
- `documents/documents.db.test.ts` "with a provider … RRF": the fixture's attachment is not in the top 5 hybrid hits because the shared local DB has accumulated chunks with identical fake embeddings from earlier runs (environment/test-data issue, not code in this change).

---

## 16. Final release checklist (evidence-based, 2026-11-11)

Other suites run for evidence (same day): `npx vitest run src/modules/signals src/modules/scoring src/modules/contacts src/modules/outreach src/modules/meetings src/modules/toolkit/calc src/modules/accounts tests/rls.test.ts`. Result: 167/170 passed. The 3 failures are all in `src/modules/outreach/outreach-more.db.test.ts`: variant mock wording `/reports of/`, the relationships list status, and property suggestions returning `[]`. That module is owned by another agent and may be mid-change.

| Item | Status | Evidence |
|---|---|---|
| Module 1 maintains accurate central records | [x] | IT1 (signal matched the existing org, 1 org), IT3 (1 requirement), 12.10 (no duplicate); accounts suite green |
| Module 2 detects and links relevant business signals | [x] | IT1 (signal linked to the org, verification `hypothesis`, evidence row); signals suite green. Retest: the assistant shows supporting and counter-evidence with dates and excerpts (12.2, D5 fixed) |
| Module 3 generates explainable and configurable scores | [x] | IT1 lead 51 with 7 factors; IT3 requirement readiness with a missing list; 12.3 factors and missing; scoring suite green |
| Module 4 identifies and enriches relevant stakeholders | [x] | 12.4 (roles, verified/unverified), IT1 `setRole` then `find_decision_makers`; deal review lists stakeholder gaps; contacts suite green |
| Module 5 generates contextual and approved outreach | [ ] not fully | IT1/IT2 pass (approval bound to content hash, mailto only, mark-sent); **3 failing tests in outreach-more.db.test.ts** |
| Module 7 prepares meetings and captures structured outcomes | [x] | IT2 brief v1; IT3 notes became proposals, tasks and an interaction; meetings suite green. Retest: assistant briefs the *next* meeting 3/3 (12.6) |
| Module 8 calculates and compares commercial options accurately | [x] | IT4 reproducible comparison, month-1 rent verified; 12.7 occupancy cost hand-verified (104.37/96.82/96.08); toolkit calc suite green |
| Module 12 can access and coordinate all included modules | [x] | Retest: the mock planner routes all 15 cases to the expected tools (no direct-execution fallback needed in 12.2–12.12/12.14); IT5 uses M1, M2, M3, M4, M5, M7 tools on the correct company 3/3, with M8 commercials inside the deal review; ambiguous names produce a clarifying question |
| All modules reuse the same central company and contact records | [x] | IT1–IT3 link the same org, person, requirement and opportunity ids across signal, score, outreach, meeting, requirement and comparison |
| Requirements remain independent and historically traceable | [x] | 12.14 audit `before` keeps 25,000; IT3 change proposals with quotes; quotes immutable (deals suite) |
| No important information is silently overwritten | [x] | IT3 proposal-before-write; 12.14 retest: assistant approval files a `change_proposal` (before-snapshot 25,000, source = assistant conversation); the requirement is unchanged until Review applies it |
| Permissions are enforced across every module | [x] | 12.13 (RLS deny, no leak, `access_denied` logged); `tests/rls.test.ts` green |
| External communication requires human approval | [x] | 12.5/12.12 drafts stay `drafted`; IT2 `approve(hash)` then `mailto:` then manual `markSent`; no outbound sender exists |
| Financial calculations are deterministic and tested | [x] | IT4 identical re-runs and an independent rent check; 12.7 hand-verified; `decimal.js` rating engine with unit tests |
| AI outputs distinguish confirmed facts from assumptions | [x] | Signals `hypothesis`/`inference` with counter-evidence; history answers quote the stored note and label it as recorded wording; "financially better" separates occupancy cost from the weighted rating; discount rate shown as assumed; lease economics `complete=false` with gaps |
| Failed tasks are reported accurately | [x] | 12.15 coverage note incl. place filter and cap; 12.13 partial with a denial message; 12.12 runs every requested sub-task and lists any it could not do as "Not completed: … — reason" |
| End-to-end workflow works without duplicate data entry | [x] | Service chain IT1–IT4 PASS; IT5 single instruction resolves the right company/deal 3/3 and covers M1–M5, M7 (+M8 in the review) |

**Release verdict (retest 2026-11-11):**
- **Module 12 / end-to-end: blocker D1 resolved.** All 15 Module 12 cases and IT1–IT5 pass in 3 consecutive runs with no flakes; ambiguous names now ask instead of guessing.
- Open items outside Module 12's changed code: the toolkit landlord-offer calculator range check (2 assistant tests) and a test-data accumulation issue in the documents hybrid-search test.

**Original release verdict:**
- **Not ready for Module 12 / end-to-end.** D1 (entity resolution) is a blocker because it can attach the wrong company or property.
- **Modules 1–4, 7 and 8 service layers are ready**, based on this evidence.
- **Module 5** needs its 3 failing tests resolved.
