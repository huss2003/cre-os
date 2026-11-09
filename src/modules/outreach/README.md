# Module 5 — Outreach Engine

Answers "who should I contact today, why now, and what do I say?". It prepares drafts from your records.
A person approves and sends every message. **There is no send code anywhere.** "Send" opens the user's own
mail/WhatsApp/LinkedIn with the approved text; the user then presses **I sent it**.

## Built on existing pieces (no duplicates)
- `mudar.draft` + `src/lib/services/drafts.ts`. Each message is a draft.
  - Approval is hash-bound to the recipient, text and attachments (`approve_draft` RPC).
  - Any edit drops the approval (DB guard).
  - Suppression is re-checked at approval and at hand-off (`open_draft_for_send`).
  - Marking sent is idempotent.
- `interaction` + `interaction_link`.
  - A sent message creates an outbound interaction (`source_message_id = outreach:<id>`).
  - A reply creates an inbound interaction, with its promises and objections.
- `task`: our commitments taken from a reply (idempotency key `outreach:<id>:<n>`).
- `change_proposal`: an opportunity `stage`/`next_action` change from a reply goes to Review via `proposeChange`. It never writes the opportunity directly.
- Inputs from earlier modules:
  - `signal` (Module 2)
  - `score_result` lead score (Module 3)
  - `contact_role_assessment`, `contact_method` verification and `person.do_not_contact` (Module 4)
  - `relationship_edge` (warm-introduction paths)
  - `consent_permission` and `suppression_tombstone`

## New tables (migration `20261108000800_outreach_engine.sql`)
- `outreach_item`: one row per message.
  - Holds the plan step, scenario, channel, reason, value, facts used, assumptions, questions and the call script/forwardable note.
  - Also holds status, planned date, pause reason, response and sent evidence (`user_assertion` or `provider:<id>`).
  - Grouped into a conversation by `plan_key`.
- `outreach_version`: immutable text history (a trigger blocks edits). `learn = true` only when the user ticks "use as an example of my style".
- `outreach_event`: lifecycle events — drafted, edited, approval_requested/approved/rejected/invalidated, opened_for_send, sent_manual/sent_provider, response/meeting/declined, paused/resumed, closed.

## Services (`service.ts`)

| Function | What it does |
|---|---|
| `buildContext` | Collects permitted facts, each with its source. Lists unknowns. Works out relationship level and channel suppression. |
| `reasonFor` | Why now. Signals are described as "reports of…" unless confirmed. |
| `duplicateCheck` | Warns, never blocks, about other open outreach, sends in the last 21 days, interactions in the last 14 days and other drafts. |
| `createOutreach` | One draft per channel, each written for that channel. Refuses do-not-contact and suppressed recipients, and anyone who said they're not interested. |
| `editItem`, `aiEdit` | Edits and AI rewrites (`AI_OPS`: shorten/expand/tone/less salesy/Hindi/Hinglish/English/regenerate…). Each creates a new version and invalidates approval. |
| `requestApproval`, `approve(hash)`, `reject` | Approval steps. `approve` must receive the hash the approver reviewed. |
| `openForSend(hash)` | Confirms the recipient and text are unchanged, re-checks suppression and returns the link. |
| `markSent` | Records the interaction, pauses the other channel alternatives for that step and plans **only the next** follow-up (days 5 / 12 / 25). |
| `prepareFollowup` | Drafts a planned follow-up only when the user asks. It re-checks the pause rules first. |
| `sweep` | Applies the pause rules: reply, meeting, decline, objection, negotiation stage, closed opportunity, colleague contact, do-not-contact, suppression. |
| `recordResponse` | AI classifies the reply → interaction, tasks, proposals, pauses outdated follow-ups. "Do not contact" in a reply sets `person.do_not_contact`. |
| `suggestions` | Today's top 5: recent signals and lease dates in the next 12 months × the best non-busy contact, ranked by lead score. |
| `warmPaths` | Ranked introduction paths. Never implies the introducer has agreed. |
| `analytics` | Sends, contacts, companies, replies, meaningful replies, meetings and paused items, with rates that state their denominators. Drafts are not counted as outreach. |

Rules are pure in `rules.ts`: scenarios with their questions, role focus, relationship level, pause rules, follow-up gaps and offline templates.

## AI
- Calls go through `callStructured`, with workflows `outreach.draft` and `outreach.response`.
- The system prompt forbids inventing history, relationships, announcements, leases, availability or contacts.
- Reported signals must be worded as reported.
- Every call has a deterministic mock, so the whole flow works without a key.
- Permissions, suppression, duplicates, approval validity, pause rules and database writes are plain code.

## Routes
| Route | What's there |
|---|---|
| `/outreach` | Tabs: Today, Messages (drafts / waiting approval / ready to send), Conversations (awaiting reply / replies / history), Paused, Results |
| `/outreach/new?person=&signal=` | Context, warnings, scenario/channels/language and warm introductions |
| `/outreach/[id]` | Editor, AI rewrite, approval, confirm-and-open, I sent it, reply, why now, questions, history and versions |

"Plan outreach" button on `/contacts/[id]`.

## Jobs
`outreach.sweep` runs daily at 06:30 local time. It re-checks the pause rules and sends nothing.

## Settings
`workspace_setting` key `outreach` → `{ "sender_name": "…" }`. Until it is set, drafts show `[Your name]`.

## Status
- **Fully implemented:**
  - all six CRE scenarios, plus reconnect and meeting follow-up
  - email, WhatsApp, LinkedIn, call script, warm introduction and meeting follow-up
  - role focus and relationship-aware drafting
  - duplicate warnings, suppression checks, hash-bound approval and its invalidation
  - manual send hand-off, reply processing, follow-up planning with pause rules, and analytics
- **Partially implemented:**
  - Style learning: only versions the user explicitly marks are reused as examples. There is no automatic preference model.
  - Provider-observed sends: `markSent({ providerMessageId })` exists, but nothing calls it until a mail connector reconciles Sent Items.
  - Follow-up calendar: shown as dated lists, not a calendar grid.
- **Requires credentials:**
  - real AI drafts (Anthropic key)
  - provider reply/sent detection (Gmail/Outlook connectors from the integrations module)
- **Not implemented, by design:** automatic sending, campaigns, automatic follow-up sending.

## Tests
`outreach.db.test.ts` covers the spec §22 flow end to end, plus:
- rejection
- approval invalidated by a content change and by a recipient change
- duplicate warning
- do-not-contact blocking drafting and pausing planned items
- workspace isolation
- rules

Run with `npx vitest run src/modules/outreach`.

## Rollback
Drop `outreach_event`, `outreach_version` and `outreach_item`, in that order, and remove `outreach` from `src/lib/jobs/registry.ts`.
Drafts and interactions created by outreach stay as normal records.
