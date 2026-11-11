# Bug hunt retest: CRE OS (2026-11-11, production build on :3100)

Scope: owner@cre-os.local, workspace "Demo — Pune CRE (synthetic)", checked at 1440px and 375px.

Method:
- Crawled 134 routes at both widths: every static route, one instance of each dynamic route, and the download links.
- Crawled 75 more tab and view URLs: company tabs, Review queues, Search accounts mode, Buildings map, Automation views, workflow and run pages, Meetings, Outreach, Contacts and Signals tabs, Tasks filters, and Today `?meeting=`.
- Then scripted interactions: forms at 375px, Today and outreach actions, meeting live view, notes and reschedule, signal actions, automation controls, the notification bell, capture upload, an import, the tutorial video, and the failed-jobs queue.

Scripts are in `/tmp/hunt-r/s/`, screenshots in `/tmp/hunt-r/*.png`, and raw crawl output in `/tmp/hunt-r/crawl-*.json`.

**Not testable:** every `/settings/*` page (General, Members, Partners, Templates, Sources, Lanes, Retention) shows the Security & MFA gate, because owners need a TOTP authenticator first. I did not enrol one, since that would change the shared owner account, so the Settings forms are untested.

## Status of previously reported issues

| # | Issue (source) | Status |
|---|---|---|
| A-M1 / B-1 | Deliverables links go to `/undefined` | **Fixed**: the links download `…-site-visit.docx/.pdf`, `…-deck.pptx` |
| A-M2 | A failed requirement submit creates a company and wipes the form | **Fixed**: no company is created, and the values come back via `?v=` |
| A-M3 | `ilike` wildcard company match | **Fixed**: "Zentrix_Analytic%" creates a new company and does not attach to Zentrix Analytics |
| A-M4 | Raw Postgres error on headcount | **Fixed**: "Headcount (max) must be at most 1,00,00,000." |
| A-M5 | Negative or inverted values accepted | **Fixed** for company headcount, building area and requirement min>max |
| A-M6 / B-3 | Tooltip causes overflow at 375 | **Fixed** on /today, /contacts, /documents, /research/*, /meetings/[id], /toolkit/quotes, /capture/documents/[id] |
| A-M7 / B-4 | Tables and cards overflow at 375 | **Partly fixed**: /legal, /requirements/[id], /toolkit/compare/new, /toolkit/occupancy, /assistant/commands and the /outreach list are fixed. **Still broken:** /fees, /toolkit/fitout(+[id]) (also at 1440), /toolkit/compare/[id], /toolkit, /outreach/[id] (see Major) |
| B-2 | Outreach list cards overflow at 375 | **Fixed** |
| A-m1 / B-5 | Raw UUIDs | **Partly fixed**: /approvals, /assistant/memory ("by you") and /research/[orgId] are fixed. **Still broken:** /tasks "(extraction 9cf1cacf-…)". New cases are listed under Minor |
| A-m2 | `null` in Legal clause parse | **Fixed**. The raw token "amount basis per_sf" remains |
| A-m3 | Raw enums | **Still broken**: /assistant/memory "from draft_edit" |
| A-m4 / B-7 | Unlabelled controls | **Partly fixed**: the workspace switcher, capture selects and /tasks are fixed. Remaining cases are under Minor |
| A-m5 | /tasks renders about 310 forms | **Improved** to 179 forms, but still heavy |
| A-m6 | Slow pages | /admin 4.9s (1440) and 4.6s (375); /database 3.8s (375); /automation?view=notifications 3.1s. Tutorials are no longer slow |
| A-m7 | Long optional company fields silently dropped | **Changed**: they are now saved, apparently truncated (a ~610-character `domain` stored as 499 characters) with no message, and there is still no format check on `domain` (`<b>x</b> 🚀…` accepted) |
| B-6 | Financing accepts absurd input | Not retested (the time went to the new areas) |
| B-8 | Deliverables time in UTC | **Fixed**: shows "11 Nov 2026, 14:06 IST" |
| B-9 | Icon button with no name on /research/[orgId] | **Fixed** |
| B-10 | Test workspaces in the switcher | **Still present**: "Radar keys radar-keys-62n33z", "Pune real-data test" (test residue) |
| B-11 | Tutorial videos slow | **Fixed**: deal-pipeline loads, plays from Supabase storage, and has no errors |

### The 7 original issues
1. **"+ Add" visible in folded sections (person/building/requirement): Fixed.** Folded sections that have an add action read "Empty · add ▸" and show "+ Add floor / unit" or "+ Add lease" when opened (`src/modules/admin/ui/parts.tsx:98`). Gap: on a person, the folded Interactions / Meetings & visits / Outreach / Decision role sections have no add link when opened, even where one exists elsewhere (Polish P1).
2. **Import dedupes places (Kharadi): Fixed.** A UI import of "  KHARADI " and "kharadi" reported "Locations 0 new · 1 you already had", and no new geography row was created. `geography-dedupe.test.ts` also passes (2/2).
3. **Notes picker: Fixed.** On /assistant/notes at 375px, the Meeting and Company comboboxes return results. After choosing Zentrix, the Requirement picker reads "Open requirements at Zentrix Analytics" and offers only that company's requirement. The hidden ids are set and there is no overflow.
4. **Business card PNG detected as "property photo": Fixed.** `HR-retest-business-card.png` was detected as "Business card". Re-uploading the same bytes says "Already uploaded — showing the earlier result."
5. **Negotiation offer name kept: Fixed.** "HR Offer Alpha" shows as "Offer 1 — HR Offer Alpha". The counter form pre-fills it, and a renamed counter shows as "Offer 2 — HR Counter Beta".
6. **Calculator rejects 5e66 escalation: Fixed.** The message is "Escalation must be written as a plain number (no exponent like 5e6)". 500 and -20 give "Escalation must be between 0 and 100 %".
7. **Review failed-jobs queue: Fixed.** The queue was empty, so I inserted one synthetic dead job. It was listed as "Processing an uploaded file · gave up 5/5 tries", the Review badge read "Failed jobs 1", and Retry moved it back to queued. The queue works at 375px. I then deleted the synthetic job.

---

## Blocker
None.

## Major

**MA1. Review → "External drafts" and "Documents" tabs link to pages that do not exist (404).**
- Steps: /approvals → tab "Outreach drafts 14" or "External drafts" → click any draft. It opens `/drafts/8314e28e-…` and returns 404 "This page could not be found". The Documents tab links to `/documents/<id>`, which also returns 404.
- Neither route exists: `src/app/(app)/drafts/` and `src/app/(app)/documents/` have only `page.tsx`.
- Suspected file: `src/app/(app)/approvals/page.tsx:133` and `:148`. Link to `/outreach/<item>` or `/drafts?focus=<id>` instead, and for documents to the owning analysis or document page.

**MA2. A meeting can be rescheduled into the past (2001) with no warning.**
- Steps: /meetings/[id] → Reschedule → date 2001-01-01 10:00 → Reschedule.
- It is accepted: the page shows "MON, 1 JAN, 2001", the meeting status becomes "rescheduled" and the reminder is set to 2000-12-31.
- Expected: reject dates in the past, or at least ask for confirmation.
- Suspected: the reschedule action in the meetings module (integrations/brief `meeting_prep` reschedule). I restored the demo meeting afterwards.

**MA3. Horizontal overflow at 375px that remains.**
- `/meetings?tab=upcoming|past|prep|cancelled` (398px). The "Import from your calendar" section's `<input type=file>` widens the grid column. Fix with `min-w-0` on the sections or `w-full` / `max-w-full` on the input (`src/app/(app)/meetings/page.tsx:64-67`).
- `/toolkit` (736px). This is no longer the tooltip: a requirement list `LI` ("Glasswing Retail Tech Centre — …") with `truncate` spans has no `min-w-0` on the flex parent, and the "No analysis" pill is `whitespace-nowrap` (`src/app/(app)/toolkit/page.tsx`).
- `/outreach/[id]` (792px). The "Compose message" section and its `To`/`Subject` inputs are 771px wide.
- `/fees` (620, `table.min-w-[560px]` not in a scroll wrapper).
- `/toolkit/fitout` and `/toolkit/fitout/[id]` (1170px at 375, and 1502px at **1440**).
- `/toolkit/compare/[id]` (721).
- `/imports/[id]` (620, only when "Technical details" is open).

## Minor

- **mi1. Raw IDs still visible.**
  - /tasks: "Assistant: terms from attached document (extraction 9cf1cacf-…)". The title is stored in the DB rows, so the fix also needs a data backfill (`src/modules/assistant/tools/documents2.ts:168`).
  - /approvals?tab=documents: document rows are titled with bare UUIDs (`d.title ?? d.file_name ?? d.id`, `approvals/page.tsx:148`).
  - /toolkit/compare/[id] version note: "Recalculated by the orchestrator: a requirement change [evt:ee434170-…:reassess.requirement:recalculate]" (orchestrator reassess writer).
- **mi2. `javascript:` URLs are accepted and stored.**
  - People → New → Public profile URL `javascript:alert(1)` is saved, and so is a Signal "Add supporting" source URL.
  - React blocks the link on render, so it is not exploitable in the UI. They would still leak into exports, and the schemes should be validated server-side (http/https only).
  - Suspected files: the people create action in `src/modules/admin/`, and the signal evidence action in `src/app/(app)/signals/[id]/page.tsx` / intelligence signals service.
- **mi3. An outreach draft accepts an invalid recipient.** "Save changes" with To = `not-an-email` stores it (`draft.recipient_address`) with no warning (`src/modules/integrations` draft save action).
- **mi4. A signal can be snoozed until a past date.** `until=2001-01-01` is accepted, and the date input has no `min` (signals/[id] snooze form).
- **mi5. Unlabelled inputs remain:**
  - list filters `q` on /companies, /people, /buildings
  - /approvals "What's missing?" `note`
  - /today `evidence` and `days`
  - /finance `cam_rate`, `cam_fixed`, `parking_*`
  - entity pages `reason` (Request archive)
  - /capture/[id] `text`
  - /imports/[id] `note`
  - /deals/[id] `category`, `objection`, `response`
  - /meetings/[id] attendee `email`/`title`, link `title`/`url`
  - /outreach/[id] `reason`
  - /requirements/[id] quote revision `rent`, `rent_free_months`, `valid_until`, `evidence`
  - /toolkit/negotiation `discount` (also see P2)
- **mi6. 600 queued jobs are overdue and nothing surfaces them.**
  - The Demo workspace has 601 `queued` jobs dating from 06:00 UTC: scoring.recalc 457, brief.replan 33, deals.req_tasks 22, and others. Nothing appears to be running `/api/cron/tick` on this box.
  - /automation shows "Running now 0" and Failed jobs shows "Nothing has failed", so the backlog is invisible (rule S10).
  - Suggestion: show a "N jobs overdue by > 15 min" health line on /automation. This is partly environmental.
- **mi7. A run detail's progress contradicts its steps.** A paused run showed "0% · 0 done · 2 in progress · 0 failed · 3 waiting" while every step read "Waiting to start" or "Waiting for an earlier step" (`src/modules/orchestrator/ui/service.ts` loadRun counts vs `src/app/(app)/automation/runs/[runId]/page.tsx`).
- **mi8. Raw tokens in the UI:**
  - /legal/[id] "amount basis per_sf"
  - /assistant/memory "from draft_edit"
  - /automation?view=budgets resource/unit values "model tokens", "usd", and "research:cal…" keys in usage

## Polish

- **P1.** Person folded sections (Interactions, Meetings & visits, Outreach, Decision role) offer no add link when opened. Examples: "Plan outreach" or "Log a meeting", and "Assess the CRE role" is plain text, not a link (`src/app/(app)/people/[id]/page.tsx`, the `Section` footers).
- **P2.** On /toolkit/negotiation (and the lease calculator), `discount` is `required` but has no default, no placeholder and no label. The first submit fails with a native "Please fill out this field" on a field the user did not notice.
- **P3.** On a workflow page, "Priority: Normal (60)" sits next to a select whose "Normal" is 50. The select also offers "Current (60)", so the wording is confusing.
- **P4.** Meeting live view: saving an empty note shows "Saved." even though nothing is stored.
- **P5.** Pausing a workflow leaves "Run now" enabled. Starting manually may be intended, but it needs a hint.
- **P6.** Demo data is polluted by test runs: Today and Meetings list three "Zentrix — intro call (demo 07:39/07:49/08:00)" at 9:00 (the nav reads "15 meetings today"), and test workspaces appear in the switcher.
- **P7.** The notification bell lives in the account block. At 375px it is only reachable after opening the menu drawer. It works there (Done / Snooze / Dismiss, panel fits).

## Checked OK
- No console errors or page errors, and no 5xx, on any of the 134 + 75 URLs at either width.
- Run pages that returned 404 during the crawl were runs deleted in the meantime by parallel agents. The current runs open correctly.
- Pages and features checked:
  - Company tabs (all 10), Review queues (records, merges, history, conflicts, stale, outdated with Refresh/Dismiss, jobs).
  - Search accounts mode: the natural-language query "companies in Kharadi with lease expiry next year" was parsed to chips with 1 match. Odd characters in `q` were handled.
  - Buildings map: Leaflet with 63 markers, no overflow.
  - Automation: Overview, Daily, Weekly, Budgets (native validation on limit < 0 and alert > 100), Notifications. On a workflow: Pause / Switch on with a confirm dialog, and Save priority.
  - Signal "Create task", meeting "Structure my notes", and outreach "Shorter" / "Show 3 versions" in mock mode.
  - Create forms at 375px: requirement, company, person, building, meeting.

## Cleanup
- **Archived:**
  - assets "HR-Retest Tower A/B"
  - import batch `fb34caf1`
  - deal_analysis "HR-retest nego"
  - capture_document `c6355be0`
  - organisations "HR-retest Co long", "Zentrix_Analytic%"
  - person "HR-retest Person"
  - requirement "HR-retest req pct"
  - task "HR-retest signal task"
  - signal_evidence `8dea02d3`
  - meeting_note `0986abf4`
- **Deleted:** the synthetic job `1a6b9b0f`.
- **Restored:**
  - meeting_visit `efb8ca05` time (11 Nov 09:00 IST) and meeting_prep `39ff0fac` (status brief_ready, reminder, outcome cleared)
  - signal `8c0e2f57` (status new, priority 80, confidence medium, no snooze or task)
  - outreach draft `8314e28e` (original body and recipient, re-approved with a matching hash) and outreach_item `5c49e9af` (approved)
  - workflow `assist.prepare_meetings` priority back to 60
- **Left as is:** audit rows, signal_review history rows, and the outreach_item `script` alternatives generated by "Show 3 versions".
