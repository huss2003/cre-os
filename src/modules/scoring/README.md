# Module 3 — Scoring Engine

Decides who to focus on first, and shows why. Six separate, versioned, configurable models — never one blended number.

| Model | Scores | Entity |
|---|---|---|
| company | Company attractiveness | organisation |
| lead | Lead priority (not readiness to transact) | organisation |
| contact | Contact relevance + role class (decision-maker / influencer / evaluator / gatekeeper / operational / unknown) | person |
| requirement | Requirement quality, plus separate completeness / urgency / commercial size / verification | requirement |
| opportunity | Opportunity attractiveness (separate from stage; no win probability without validated history) | opportunity |
| relationship | Relationship strength (Strong / Active / Developing / Weak / None) incl. owner assessment | organisation |
| property | **Reused**: requirement-specific matching (`deals/matching`, match-v1) — must-haves first, then weighted fit | shortlist_option |
| signal | **Reused**: Module 2 signal priority (kept separate from lead priority) | signal |

## How a score is calculated (`engine.ts`, pure, deterministic)
`score = round(Σ weight × value / Σ counted weights × 100)`, value ∈ [0,1] from `features.ts` (rules over Module 1 + Module 2 data; no AI).
Unknown policy per factor: **exclude** (not negative), **neutral** (0.5), **zero**. Completeness = known weight share.
Confidence = completeness + strength of the evidence behind it. Mandatory failures disqualify (score 0) and cannot be outweighed.
Same inputs + same model version → same score (`inputs_hash`); unchanged inputs do not add history rows.

## Tables (`20261108000400_scoring_engine.sql`)
`scoring_model`, `scoring_model_version` (immutable, rollback = activate older), `score_result` (every calculation = history row; one `is_current`),
`score_override` (manual priority + relationship assessments; never overwrites the calculated score), `score_feedback`.
All via `make_business_table` (RLS, audit). Trigger `scoring_enqueue` on signal / lease / lease_event / requirement / opportunity / employment enqueues `scoring.recalc` (deduped per company per minute).

## Jobs
`scoring.recalc` (event-driven, per company: company → relationship → requirements → contacts → lead → opportunities),
`scoring.bulk` (02:30 daily, unscored or >7 days old, 150 companies/run). Manual: "Recalculate" per record, "Score everything now" (admin).

## Screens
`/scoring` dashboard (stats, tabs per model + property matches, filters, sort), `/scoring/[model]/[id]` (breakdown with evidence per factor, missing info, risks, override, feedback, history), `/scoring/models` (admin: weights, unknown policy, thresholds, industry weights, focus cities, preview on a record, versions, on/off).

## Known gaps
- AI is not used in scoring yet (rules only); Module 2 already uses AI to extract evidence.
- Interactions don't trigger recalculation directly (covered by the nightly run and manual recalculation).
- Feedback is stored for review; it does not retrain anything automatically.
- Filters for industry / micro-market / lease expiry / assigned user are via search, not dedicated dropdowns.
