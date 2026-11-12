# Module 2 — Signal Engine

Turns Module 1 data and permitted source material into reviewable **signals**: what happened, who it affects, why it may
matter, the evidence, what is unconfirmed, and what to do next. Spec: `docs/signal-engine/SPEC.md`; UI contract:
`docs/signal-engine/CONTRACT.md`; gap analysis: `docs/signal-engine/GAP.md`.

## Reused from Module 1 (no duplicates)
`signal_claim` (evidence atoms), `lease_event` / `lease` / `availability` (lease + commercial scans), `research_source_registry`
(source registry, one row per adapter), `source_object` (original material + provenance), `task` (all follow-ups),
`change_proposal` via `proposeChange` (opportunity + employment proposals), `audit_event` (automatic), `watchlist`
(refresh tiers, researched_at), `workspace_setting.signals` (focus cities, weights, universe cap), job queue.

## Tables
- `20261108000100_signal_engine.sql`: `signal`, `signal_evidence`, `signal_review` (append-only decisions).
- `20261112000100_signal_engine.sql` (v2): `signal_source_item` (pipeline item: status + history + error + attempts +
  idempotency key + raw text), `source_sync_run`, `signal_rule_version` (admin-write), `signal_assessment` (append-only
  assessment history); signal columns `sub_type, derived, labels, independent_evidence_count, contradictory_count,
  last_confirmed_on, entity_candidates, entity_resolution, priority_review_on, contextual_summary, source_names,
  micro_market, rule_version_id`; evidence `independence_key, source_item_id, label`; registry `adapter, permission_status,
  permitted_purposes, retention_days, connection_status, usage_count`.

## Code
- `engine.ts` — pure rules: lease windows, counter-evidence (§14 list), confidence, priority (reasons, override), next action, missing info.
- `taxonomy.ts` — categories A–G, ~70 sub-types, `detectAll` text rules (facts vs forecasts, macro CRE-link gate), leadership roles.
- `rules.ts` — versioned rule set, derived fields, hiring checks, funding-alone rule, independent-evidence grouping, labels, contextual summary.
- `resolve.ts` — entity resolution: external IDs → exact alias/name → multiple identifiers → fuzzy suggestions with reasons; people never by name alone.
- `sources.ts` — adapter interface + registry (`manual_paste`, `user_upload`, `database`, `rss` = unavailable/needs access), entitlement gate, pause/reconnect.
- `pipeline.ts` — `processSourceItem` (§5 statuses, idempotent, failure → `failed` + retry), `retrySourceItem`, `processCapture`, `listSourceItems`.
- `service.ts` — `upsertSignal` (grouping), `reassess`, scans (lease incl. handover/managed/past-expiry verification task, claims), `actOnSignal`, `listSignals` (all §10 filters), `filterOptions`, `ingestText` (= manual paste via pipeline).
- `card.ts` — `getSignalCard` (header + 12 sections + history + assessments + provenance + valid actions).
- `commercial.ts` — like-for-like rent comparison (same micro-market, same rent basis, latest availability snapshot).
- `leadership.ts` — `recordLeadershipChange` (unverified observation, employment proposal, review tasks for both orgs, no transfer).
- `refresh.ts` — tiers, bounded universe (default 1,200), `refreshCompany`/`refreshNow`, `refreshStatus`, `setUniverseCap`.
- `assess.ts`, `research.ts` — company assessment / web research (AI policy: `signals.assess` code-only; research needs AI).

- `text.ts` — pure text helpers: company name from text (blank Company field), event date from text (`announced` for a calendar
  date, `estimated` for month/quarter/year/"next quarter"), counter-evidence cues, short task titles, plain labels for stored codes.
- Pasted counter-evidence ("hires will work remotely", "no additional office space") naming a company with an open signal (or
  passed with `signalId`) is attached to that signal as AGAINST evidence and re-assessed (priority drops); `ingestText` returns `counterFor`.
- `syncCompletedTasks(db, ws, ids?)` (service.ts): a follow-up task completed in /tasks writes one `task_completed` history event
  (with the completion evidence) and marks the signal converted. Runs on card load, /signals load (editors) and in `signals.scan`.
- Micro-market comes from the geography (locality/micro-market names + aliases) named in the text, over the company's record;
  a mismatch adds a location note. Detected-date filters use IST day boundaries.

## Jobs (`jobs.ts`)
`signals.scan` (daily 06:00 local), `signals.refresh_plan` (daily 06:15 → one `signals.refresh_company` per due company,
dedupe per company per day), `signals.refresh_company` (scheduled / event / retry; sync-run dedupe makes retries no-ops),
`signals.research` (05:30), `signals.discover` (Mon 05:15). `triggerEventRefresh(ws, orgId)` for event-triggered refresh.

## Tests
`npx vitest run src/modules/signals` — `engine.test.ts`, `engine2.test.ts` (pure §3/§7/§8/§11/§13/§14/§15/§16),
`assess.test.ts`, `signals.db.test.ts`, `research.db.test.ts`, `e2e.db.test.ts` (§19 workflow + §20 functional,
data-integrity, security, reliability). Journey: `tests/journey/m2-signals.test.ts`.

## Known gaps
- Company page evidence trail (admin module, `src/modules/admin/ui/parts.tsx`) still shows raw `Tier single_unverified` and
  claim predicates like `expansion_terms` — outside this module.
- No live news/RSS/job-board/LinkedIn adapters: no approved fetch path or licence exists; `rss` is registered as
  "unavailable — needs access". Manual paste and capture uploads are the text adapters.
- Infrastructure "no material effect" check is coarse (any recorded lease + named city).
- Rule versions are editable only via `publishRules` (no admin UI yet).
