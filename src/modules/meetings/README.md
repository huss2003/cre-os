# Module 7 — Meeting Preparation Engine

Before each meeting, this builds a brief backed by your records: who's coming, what we know, what happened before,
what to ask, which objections may come up, and what outcome to aim for. After the meeting, your notes become
**proposed** updates that you approve.

## Built on existing pieces
- **The meeting itself** is `meeting_visit` (shared with calendar sync from the integrations module). Cancel and reschedule only change CRE OS's own record, never your external calendar.
- **Company:** `organisation`, `lease` + `lease_event`, and `market_transaction`.
- **Module 2:** `signal`. A signal that isn't confirmed is labelled as an inference.
- **Module 3:** `score_result`, used for lead, company, contact and opportunity scores.
- **Module 4:** `contact_role_assessment`, verified `contact_method` and `employment` history.
- **Module 5:** `outreach_item` (with replies), `interaction` and `interaction_link`.
- **Post-meeting:** an `interaction` (idempotent key `meeting:<id>`), a `task` for each of our commitments, and `proposeChange` for requirement and opportunity changes (these go to Review and never overwrite anything). An optional follow-up email is drafted via Outreach `createOutreach(meeting_followup)`, also for approval.

## New tables (`20261108000900_meeting_prep.sql`)
- `meeting_prep`: one per meeting. Holds the type, purpose, linked company/deal/requirement/properties, status (scheduled … rescheduled), readiness and its detail, the current brief, the checklist, the reminder time, the outcome (proposed / applied), and the source (manual / calendar / ics_import) with the raw event.
- `meeting_prep_attendee`: one row per attendee. Holds `person_id` (or the raw name/email), internal/external side, and `match_status` (matched / suggested / unresolved / manual) with a reason. A name alone is only ever a "suggested" match.
- `meeting_brief_version`: every generated, regenerated or edited brief, with its model, readiness and input references.
- `meeting_material`: a title plus a link or `document_version_id`, and `internal_only` (default true). Nothing is shared automatically.
- `meeting_note`: notes, actions, commitments and feedback captured in meeting mode.

## Rules (`rules.ts`, no AI)
- **Meeting types:** 10, each with a purpose, question groups and a target outcome. A type is inferred from the title for imported meetings.
- **Question bank:** each question has a check against records. Questions already answered move down and are flagged. The brief shows 5 essential + 5 additional + 3 strategic questions.
- **Objection bank:** grouped by meeting type, each with what it may mean, a response, a follow-up question and the evidence to have ready.
- **Site-visit checklist:** before / during / after.
- **Readiness:** 10 weighted factors. It explains what is missing and what is critical, and is kept separate from Module 3 scores.
- **.ics parser:** treats the file content as untrusted input.

## Services (`service.ts`)
| Function | What it does |
|---|---|
| `createMeeting` | Creates the meeting. Warns about duplicates (same company within ±60 min). A repeated calendar UID is a no-op. |
| `importIcs` | Imports an .ics file, ignoring cancelled events. |
| `syncFromCalendar` | Creates a prep for meetings the connected calendar has synced, matching attendees by email. |
| `gather` | Loads everything from records under RLS. |
| `matchProperty` | Compares a property with the requirement: fits / doesn't fit / unknown / to verify. Availability counts as verified only if the snapshot is under 45 days old and not just reported. |
| `assessReadiness` | Works out the readiness score and gaps. |
| `generateBrief` | Builds the brief, which has 11 sections plus properties. Every item is tagged `fact`, `history`, `inference`, `suggestion` or `unknown`, with its source. AI writes only the purpose analysis, attendee "why this person matters", strategy, objections, outcome and next steps. A failure is kept on screen and earlier versions stay. |
| `editBrief`, `markReviewed` | Edits create a new version. |
| `setMeetingPurpose`, `reschedule`, `cancelMeeting` | Meeting changes inside CRE OS only. |
| `addAttendee`, `resolveAttendee` | Add or confirm attendees. |
| `toggleChecklist`, `addMaterial`, `addNote` | Checklist, materials and notes. |
| `structureOutcome` → `applyOutcome(selection)` | Turns notes into proposed updates; applies only the parts you tick. |
| `remind` | Creates a prep reminder task from 24 hours before the meeting. |
| `briefMarkdown` | Exports the brief. |

## Routes
| Route | What's there |
|---|---|
| `/meetings` | Upcoming / needs preparation / past / cancelled, .ics import, "check calendar now" |
| `/meetings/new` | New meeting form |
| `/meetings/[id]` | The full brief, readiness, setup, attendees, materials, edit, site-visit checklist, after the meeting, reschedule/cancel |
| `/meetings/[id]/live` | Meeting mode for phone or tablet: purpose, attendees, 5 questions, talking points, earlier promises, key facts, properties, quick notes |
| `GET /api/v1/meetings/[id]/brief` | Markdown export. The page also prints cleanly to PDF. |

## Jobs
- `meetings.remind` (hourly): prep reminder tasks.
- `meetings.calendar` (hourly): creates preps for newly synced calendar events. Does nothing if no calendar is connected.

## Status
- **Fully implemented:** manual creation, .ics import with dedupe, attendee matching, company / attendee / history / opportunity intelligence, the brief (11 sections) with versions and export, prioritised questions, strategy, objections, property comparison, site-visit checklist, readiness, reminders, meeting mode, post-meeting structuring with approval, cancel and reschedule.
- **Requires credentials:**
  - live calendar sync (Google/Microsoft OAuth in the integrations module; `syncFromCalendar` uses whatever it has synced);
  - AI wording (Anthropic key; without it, rule-based wording is used).
- **Partially implemented:**
  - File uploads for materials: links only. Restricted files stay in Documents (Module 1 permissions apply).
  - Custom meeting types: the types are in code; there is no admin screen yet.
- **Not implemented, by design:** recording or transcription (needs consent and an authorised integration), and changing external calendar events.

## Tests
`meetings.db.test.ts` covers the spec §23 flow, plus:
- a first meeting with no history
- no company linked
- multiple attendees, including one unresolved
- an unverified signal
- reschedule and cancel
- .ics import and its duplicate
- calendar sync with no data
- isolation
- rules

Run with `npx vitest run src/modules/meetings`.

## Rollback
Drop `meeting_note`, `meeting_material`, `meeting_brief_version`, `meeting_prep_attendee` and `meeting_prep`, in that order, and remove `meetings` from `src/lib/jobs/registry.ts`.
`meeting_visit` rows created here stay as ordinary meetings.
