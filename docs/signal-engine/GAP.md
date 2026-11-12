# Signal Engine — gap analysis (backend, spec §1–§20)

Before = state on 2026-11-12 before this pass (code in `src/modules/signals`, migration `20261108000100_signal_engine.sql`).
After = state after this pass. Evidence = file / table.

| § | Item | Before | Evidence (before) | After |
|---|---|---|---|---|
| 1 | Reuse Module 1, no second DB | DONE | signal tables in `mudar`; reuse signal_claim, lease_event, task, change_proposal | DONE |
| 2 | Six questions per signal | PARTIAL | summary/cre_relevance/evidence/missing_info/recommended_action; no fact/inference labels | DONE (`labels`, card sections) |
| 3A | Expansion sub-types | PARTIAL | `engine.ts` CLAIM_CATEGORY kinds only (expansion/gcc/hiring/funding) | DONE `taxonomy.ts` 13 sub-types |
| 3B | Restructuring incl. closure/M&A/layoffs≠reduction | PARTIAL | consolidation/rto rules only; layoff counter text | DONE sub-types + outcomes, layoff counter kept |
| 3C | Lease events distinguished, past expiry → verification | PARTIAL | `leaseSignal` (6 types, past expiry = unknown) but no task, no handover/managed office | DONE handover, managed expiry, renewal; past expiry auto verification task |
| 3D | Commercial value (same rent basis only) | MISSING | only from claims of type rent_benchmark | DONE `commercial.ts` like-for-like scan |
| 3E | Leadership (person match, unverified obs., proposal, tasks old/new) | PARTIAL | job_move claims → signal; prev-employer task on approve; no proposal / person resolution | DONE `leadership.ts` |
| 3F | Infrastructure facts vs forecasts | MISSING | category exists, no detection/labels | DONE detection + forecast labelling |
| 3G | Macro only with plausible CRE link | MISSING | category exists, no gate | DONE `plausibleCreLink` gate |
| 4 | Source registry fields | PARTIAL | `research_source_registry` (name, kind, method, allowed, cadence, last_success, paused) – no permission status/purposes/retention/connection status/usage | DONE columns + `sources.ts` |
| 4 | Adapter interface | MISSING | paste only (`ingestText`) | DONE `SourceAdapter` + manual_paste, database, user_upload, rss (registered as unavailable — no allowed fetch path exists) |
| 5 | Pipeline statuses + error handling + provenance | PARTIAL | `signal.processing_status` only; no per-source-item record | DONE `signal_source_item` (status + history + error + attempts) + `source_object` provenance |
| 6 | Entity resolution rules | PARTIAL | exact name / alias / fuzzy suggestions; no external IDs, no reasons, no person rules | DONE `resolve.ts` (external IDs → alias → multiple identifiers → fuzzy suggestions with reasons; person never by name alone) |
| 7 | Fact/inference/hypothesis/unknown | PARTIAL | one `verification` value per signal | DONE per-signal `labels` + per-evidence `label` |
| 7 | Derived fields via versioned rules | PARTIAL | confidence/priority hard-coded, RULE_VERSION const | DONE `rules.ts` + `signal_rule_version` |
| 7 | Hiring checks; funding alone; repeats not independent | PARTIAL | hiring caveat text; dedupe by key | DONE `derived.hiring`, `fundingOnly`, `independent_evidence_count` |
| 8 | Grouping/dedupe display fields | PARTIAL | dedupe_key grouping; no first/last confirmation, independent count, contradictions | DONE columns + card grouping section |
| 9–10 | Card/actions/views/filters (backend) | PARTIAL | listSignals: view/q/confidence/status/assigned/date | DONE all §10 filters + `getSignalCard` + `filterOptions` |
| 11 | Module 1 context + contextual summary | PARTIAL | `orgContext` + `contextual()` appended text | DONE `contextSummary()` (Kharadi example form), private notes excluded |
| 12 | Next actions per table; tasks; no outbound | DONE | `nextAction`, `createTask` | DONE (+ sub-type actions, record_outcome) |
| 13 | Priority model, reasons, override (reason/user/date/review date) | PARTIAL | override stored; review date not surfaced; no history | DONE `priority_review_on`, overrideReviewDue, clear_override, `signal_assessment` history |
| 14 | Counter-evidence list | PARTIAL | 9 rules; no "property no longer available", "infra no effect", "outdated lease" | DONE all §14 examples |
| 15 | Refresh tiers, universe cap, researched_at, dup-job prevention, pause/reconnect, failed visibility | PARTIAL | research.ts cadences, scan daily, watchlist last_researched_at | DONE `refresh.ts` (tiers, cap 1,200, lease windows, event trigger, sync runs, failed items/jobs) |
| 16 | Security | PARTIAL | RLS, untrusted text regex-only | DONE + source entitlement gate before processing, private notes excluded, tests |
| 17 | Storage & idempotency keys | PARTIAL | dedupe_key, task idempotency | DONE source item idempotency key, assessment history, rule version id |
| 18 | AI usage (code-only default) | DONE | policy `signals.assess` code | DONE (unchanged) |
| 19 | End-to-end workflow | PARTIAL | signals.db.test.ts covers ingest→approve→task | DONE `e2e.db.test.ts` full chain + reject/correct/snooze/re-evaluate |
| 20 | Tests (functional/integrity/security/reliability) | PARTIAL | 4 test files | DONE (see README) |

## Notes on "After"
- Every DONE row is backed by an executed test: `src/modules/signals/engine2.test.ts` (15 pure tests) and
  `src/modules/signals/e2e.db.test.ts` (15 DB tests), plus the existing signals / journey suites (all passing 2026-11-12).
- **Requires external access (not faked):** live news / RSS / job boards / professional networks / licensed CRE feeds.
  The `rss` adapter is registered with `connection_status = needs_access`; processing through it is refused.
- **Partial:** "infrastructure has no material effect" counter-evidence is coarse; rule versions have no admin UI
  (`publishRules` service only); next-action kinds "meeting preparation" / "requirement discovery" are not yet emitted
  by rules (research / contact_verification / lease_event_verification / property_research / relationship_follow_up are).
- UI items of §9–§10 are owned by the UI agent (contract in `CONTRACT.md`).
