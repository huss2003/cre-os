# intelligence module (P1)

Prospect researcher, network intelligence, legal desk, deal strategist, market analyst, content editor and insights.
Everything works in mock-AI mode (empty `OPENAI_API_KEY`): every gateway call passes a deterministic `mock`, and every
AI failure (`budget_exceeded`, `paused`, `no_api_key`) falls back to rule output that is labelled as such.

## Migration
`supabase/migrations/20261031001500_intelligence.sql` (re-runnable; drops only this module's tables). All tables use
`app.make_business_table`: `research_dossier` (versioned; one current per org via unique partial index),
`research_source_registry`, `watchlist`, `evidence_finding`, `legal_document`, `clause_extract`, `clause_comparison`,
`negotiation_log`, `concession_item`, `market_note`, `content_post`, `playbook_item`, `experiment`, `experiment_subject`.

## Code layout
| Path | What |
|---|---|
| `research/dossier.ts` | Pure dossier contract (17 sections, per-claim dates/expiry/evidence tier, unknown stays unknown, hiring ≠ size), person-move confidentiality filter, refresh policy, rule synthesis + falsification questions |
| `research/service.ts` | `generateDossier` (skip on unchanged fingerprint/interval; budget degrade), `upsertWatch` (tier capacity warnings), `addPastedEvidence` (replay-deduped), `webResearch` (only with key + allowed registry source + rate limit; never LinkedIn), `dueForResearch` |
| `research/patrol*.ts` | Evidence conflict & expiry patrol → `evidence_finding` (deduped) |
| `network/graph.ts`, `network/service.ts` | Intro paths (permission required for 2-hop), multi-threading gap detector, `recordJobMove` (claim + `proposeChange`, prior employment preserved), `draftReconnect` (`createDraft`, never sent) |
| `legal/clauses.ts`, `legal/service.ts` | Heading/regex extractor (rent, escalation, lock-in, notice, term, deposit, CAM, fit-out, reinstatement, termination, indemnity) with locators; model output validated against source; word redline; exposure checklist; always "not legal advice" |
| `strategy/strategist.ts`, `strategy/service.ts` | Transparent deal-health points, gaps, BATNA questions, concession ladder (values via finance scenarios), risks; daily snapshot to `negotiation_log` |
| `market/series.ts`, `market/service.ts` | Definition/date/source/unit gate, annual trends with unknown gaps, comparability flags, no stock summation, no vacancy from gross absorption, months-of-supply rules, per-basis comparables, market-note drafts (deterministic facts + labelled commentary) |
| `content/editor.ts`, `content/service.ts` | Weekly plan, voice-sample drafts, brand/confidentiality checklist, approve → manual publish |
| `insights/metrics.ts`, `insights/service.ts` | Cohort funnel vs 120/170 (first actual outbound per company; drafts/follow-ups/inbound excluded), stage conversion, time-to-stage with censoring, lost reasons, freshness, portfolio view, landlord concentration, procurement-cycle map, experiments with sample warnings, playbook |
| `jobs.ts` | `intelligence.patrol` (05:30 local), `intelligence.research` (05:45 local); `budgetLatch` stops AI calls after the first budget refusal |
| `ui/`, `api.ts` | Module presentational helpers, form-action wrapper, HTTP error mapping |

Exported for other modules: `strategyFor(db, ws, opportunityId)`, `generateDossier(db, ws, orgId, opts)`,
`threadingGaps(db, ws, opportunityId?)`, `runPatrol(db, ws)`.

## Routes
Pages: `/research`, `/research/[orgId]`, `/network`, `/market`, `/legal`, `/legal/[id]`, `/legal/compare/[id]`,
`/content`, `/insights`, `/insights/deals/[id]`.

API (mutations require `Idempotency-Key`, editor role):
- `GET|POST /api/v1/research/watchlist`, `GET|POST /api/v1/research/dossiers/[orgId]` (`{force}`), `POST /api/v1/research/evidence`,
  `GET|POST /api/v1/research/findings`, `POST /api/v1/research/network/job-moves`, `POST /api/v1/research/network/reconnect`,
  `GET /api/v1/research/network/gaps?opportunityId=&orgId=`
- `GET|POST /api/v1/legal/documents`, `GET /api/v1/legal/documents/[id]`, `POST /api/v1/legal/comparisons`
- `GET /api/v1/market/overview`, `GET /api/v1/market/comparables`, `GET|POST /api/v1/market/notes`, `POST /api/v1/market/notes/[id]`
- `GET|POST /api/v1/content/posts`, `POST /api/v1/content/posts/[id]` (`action`: draft|save|approve|published|discard), `POST /api/v1/content/plan`
- `GET /api/v1/insights`, `GET|POST /api/v1/insights/deals/[id]`, `POST /api/v1/insights/playbook`, `GET|POST /api/v1/insights/experiments`

Natural dedupe on replays: watchlist upsert, evidence (org+type+day+text), legal docs (family+sha256), comparisons
(unique per engine version), dossier (fingerprint), job-move proposals (claim-derived keys), weekly plan (week+topic),
strategy snapshot (per day).

## Settings
`workspace_setting` keys (admin-only writes): `content.voice_samples` (string[]), `content.brand_rules` (string[]).
No env vars beyond the shared ones.

## Tests
`npx vitest run src/modules/intelligence` — pure (`intelligence.test.ts`) and DB-backed (`intelligence.db.test.ts`):
person-move confidentiality, unknowns/expiry, rerun skip, budget degrade + latch, prompt injection, clause extract +
redline, market series rules (historical periods), cohort counting, strategist, content checklist, loader smoke as
owner and restricted colleague.

## Known gaps
- Patrol and research jobs run with the service role; patrol from the UI runs over the caller's visible rows only.
- Market observations come from imports; there is no manual observation entry form.
- Experiments: no subject assignment UI or API yet (rows must be inserted into `experiment_subject` directly).
- Deal strategist links to `/deals/[id]` (owned by the deals module).
- Cross-tenant FK checks (security review M4) are not added for these tables; relies on the core generic fix.
