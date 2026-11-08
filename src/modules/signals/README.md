# Module 2 — Signal Engine

Turns Module 1 data and pasted evidence into reviewable **signals**: what happened, who it affects, why it may matter,
the evidence, what is unconfirmed, and what to do next.

## Reused from Module 1 (no duplicates)
- `signal_claim` — evidence atoms (incl. `job_move` from network/recordJobMove). Pasted text becomes `signal_claim` rows (status `ai_inference`).
- `lease_event` — expiry / lock-in / notice / break / escalation / renewal option (never merged).
- `research_source_registry` — source registry (+ `paused`, `last_sync_at`, `last_sync_status`).
- `task` — every follow-up (idempotency key `signal:<id>`). `change_proposal` — "Propose deal" goes to Review.
- `audit_event` — automatic via `make_business_table`. `workspace_setting` key `signals` — focus cities, weights, universe cap.
- `detectSignals` rules from `intelligence/research/signals.ts`.

## New tables (migration `20261108000100_signal_engine.sql`)
- `signal` — grouped event; `dedupe_key` unique per workspace (same company + kind + month = one signal).
- `signal_evidence` — support / counter / context links to claims, lease events, URLs.
- `signal_review` — append-only decision history.

## Code
- `engine.ts` — pure rules: categories A–G mapping, lease windows, counter-evidence, confidence, priority (weights + reasons, override), next action, missing info.
- `service.ts` — `resolveOrg`, `orgContext`, `scanLeaseEvents`, `scanClaims`, `scanWorkspace`, `ingestText`, `actOnSignal`, `listSignals`, `signalDetail`, `counts`.
- `actions.ts` — server actions. `jobs.ts` — `signals.scan` daily 06:00 local (dedupe per day).
- UI: `/signals` (views A–J, filters, search, paste evidence, Scan now), `/signals/[id]` (12 detail sections + all actions).

## Labels
`verification`: fact (contractual/confirmed) · inference (reported) · hypothesis (rule-detected) · unknown (e.g. passed expiry).
`confidence` = evidence strength only. Priority high needs timing, a contact or commercial context — not evidence alone.

## Known gaps
- No live web/news/job-board adapters (no licensed feeds configured); manual paste is the adapter. Registry rows for other methods are kept but not fetched.
- Categories D (commercial value), F (infrastructure), G (macro) only fire from claims of those types; no automatic rent comparison yet.
- AI summarisation not wired (rules only, mock-safe, zero credits).
- Industry / micro-market filters use search; dedicated dropdowns pending.
