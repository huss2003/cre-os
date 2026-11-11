# Assistant — morning brief + notes → updates (round 2, briefs agent)

## Morning brief (`briefs/morning.ts`, `briefs/jobs.ts`)
- `assembleMorningBrief(ctx, now)` — deterministic: meetings today (prep status + link), tasks/commitments + outreach follow-ups due/overdue,
  new signals since the previous working day on top-N scored accounts (`score_result` company/lead), leases whose 12/6/3-month window opened
  since then (`edate`), approvals waiting (change proposals + assistant approvals), stale memories. Each source time-boxed (8 s);
  failures become "Not checked — …" blocks and `failed[]` (S10). No LLM.
- `deliverMorningBrief` — pinned `assistant_conversation` "Morning brief — <date>" + one assistant message with blocks; one per user per day
  (`assistant_morning_brief` unique row).
- Opt-in: `assistant_brief_setting` (enabled, time_local, timezone, top_n, next_run_at). UI: card at top of `/home` (toggle + time, "Build now").
- Job `assistant.morning_brief` (dedupe `assistant.morning_brief:<user>:<date>`), `schedule(now)` enqueues due settings and advances to next weekday.
  **Lead: register `handlers` + `schedule` from `briefs/jobs.ts`.**

## Notes → updates (`notes/service.ts`, `/assistant/notes`)
- `analyseNotes` — capture's extractor (`defaultExtractor`, mock = rule engine) + `enforceRules`; candidates from `search_entity_candidates`
  as the user; only unambiguous matches are linked. Writes only an `assistant_note` review row (dedupe on body hash while pending).
- `approveNotes(noteId, selectedIds)` — interaction (+links) for the note; requirement fields → one `proposeChange` per requirement;
  commitments/next steps → `createTask`; roles/objections/details/property feedback → `saveMemory`. Unselected = discarded. Idempotent.
- Tool file `tools/briefs.ts`: `capture_meeting_notes` (B), `morning_brief` (A); suggested group `briefs`.

Known gaps: preferred_geography and constraint details are memories, not requirement patches; the job reads with the service role
(workspace + user filters), so workspace-wide signals/leases are not re-checked against per-record shares.
