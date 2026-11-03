# intelligence module (P1)

Prospect researcher, network intelligence, legal desk, deal strategist, market analyst, content editor and insights.
Everything works in mock-AI mode (empty `OPENAI_API_KEY`): every gateway call passes a deterministic `mock`, and every
AI failure (`budget_exceeded`, `paused`, `no_api_key`) falls back to rule output that is labelled as such.

## Migration
`supabase/migrations/20261031001500_intelligence.sql` (re-runnable; drops only this module's tables). All tables use
`app.make_business_table`: `research_dossier` (versioned; one current per org via unique partial index),
`research_source_registry`, `watchlist`, `evidence_finding`, `legal_document`, `clause_extract`, `clause_comparison`,
`negotiation_log`, `concession_item` (**deprecated** — see round 2), `market_note`, `content_post`, `playbook_item`, `experiment`, `experiment_subject`.

## Code layout
| Path | What |
|---|---|
| `research/dossier.ts` | Pure dossier contract (17 sections, per-claim dates/expiry/evidence tier, unknown stays unknown, hiring ≠ size), person-move confidentiality filter, refresh policy, rule synthesis + falsification questions |
| `research/service.ts` | `generateDossier` (skip on unchanged fingerprint/interval; budget degrade), `upsertWatch` (tier capacity warnings), `addPastedEvidence` (replay-deduped), `webResearch` (only with key + allowed registry source + rate limit; never LinkedIn), `dueForResearch` |
| `research/patrol*.ts` | Evidence conflict & expiry patrol → `evidence_finding` (deduped) |
| `network/graph.ts`, `network/service.ts` | Intro paths (permission required for 2-hop), multi-threading gap detector, `recordJobMove` (claim + `proposeChange`, prior employment preserved), `draftReconnect` (`createDraft`, never sent) |
| `legal/clauses.ts`, `legal/service.ts`, `legal/upload.ts` | PDF (unpdf) / DOCX (mammoth) / TXT upload → original in storage + `source_object`; scanned PDFs → `ocr_status='ocr_needed'`, no clauses. Extractor for 21 clause types (adds obligations, possession/commencement dates, renewal, assignment, permitted use, insurance, force majeure, disputes, parking, taxes) with line/char/page/¶ locators; model output validated on the WHOLE clause + every value re-derived from the wording; same-family guard (cross-family needs confirmation); per-clause + full-document redline; exposure items carry document version + locator; always "not legal advice", never signs |
| `strategy/strategist.ts`, `strategy/service.ts`, `strategy/ui.tsx` | Transparent deal-health points, stakeholder + evidence gaps, fact-tailored BATNA questions and concession ladder, risks — every item cites recorded facts (`basis`) and lists assumptions; fingerprinted snapshot to `negotiation_log`; ladder seeded into deals' `concession_step` |
| `market/series.ts`, `market/analysis.ts`, `market/service.ts`, `market/chart.tsx` | Gate; series per metric × resolved geography × unit × period family (annual / quarterly / monthly — never mixed, never dropped: superseded/revised rows listed with reasons); definition changes break comparability + flag; geography resolution (id / approved alias / name-only / unmapped) with raw-name → geography proposals via `proposeChange` (alias on `geography`); forecasts labelled, "not a forecast" only when true; `MarketChart` always shows period, unit, source name + release date and sample, refuses mixed units; notes store facts with source + release date, sources, sample size, caveats; `market_analysis` runs (trigger/scheduled/manual) with flags + in-app notice |
| `content/editor.ts`, `content/service.ts` | Weekly plan with planned publish dates (+ calendar), drafts from APPROVED market notes / public-source facts only, deterministic fact check (numbers, dates, companies, trend/superlative claims vs approved evidence; unmatched block approval), brand rules parsed and enforced in `checklistPasses` (non-parseable rules need a body-hash-bound manual confirmation), confidential terms setting + client names, licensed-content flag (licence must allow publication), private-shareable redacted version; approve = ready; publishing manual |
| `insights/metrics.ts`, `insights/service.ts` | Cohort funnel vs 120/170 (first actual outbound per company; drafts/follow-ups/inbound excluded), stage conversion, time-to-stage with censoring, lost reasons, freshness, portfolio view, landlord concentration, procurement-cycle map, experiments with sample warnings, playbook |
| `jobs.ts` | `intelligence.patrol` (05:30 local), `intelligence.research` (05:45 local); `budgetLatch` stops AI calls after the first budget refusal |
| `jobs-b.ts` | `intelligence.market_analysis` (SQL trigger on `market_observation` inserts → one deduped job per workspace × source/release key, due +1 min so chunked inserts coalesce; also monthly on the 1st 06:15 local), `intelligence.content_plan` (Mondays 07:10 local, dedupe per week) |
| `ui/`, `api.ts` | Module presentational helpers, form-action wrapper, HTTP error mapping |

Exported for other modules: `strategyFor(db, ws, opportunityId)`, `generateDossier(db, ws, orgId, opts)`,
`threadingGaps(db, ws, opportunityId?)`, `runPatrol(db, ws)`.

## Routes
Pages: `/research`, `/research/[orgId]`, `/network`, `/market`, `/legal`, `/legal/[id]`, `/legal/compare/[id]`,
`/content`, `/content/calendar`, `/insights`, `/insights/deals/[id]`.

API (mutations require `Idempotency-Key`, editor role):
- `GET|POST /api/v1/research/watchlist`, `GET|POST /api/v1/research/dossiers/[orgId]` (`{force}`), `POST /api/v1/research/evidence`,
  `GET|POST /api/v1/research/findings`, `POST /api/v1/research/network/job-moves`, `POST /api/v1/research/network/reconnect`,
  `GET /api/v1/research/network/gaps?opportunityId=&orgId=`
- `GET|POST /api/v1/legal/documents` (`assetId`, `orgId`, `leaseId` optional), `POST /api/v1/legal/documents/upload` (multipart: file,
  title, doc_kind, family_key, lease_id, org_id, asset_id), `GET /api/v1/legal/documents/[id]`, `GET /api/v1/legal/documents/[id]/file`
  (hash-checked original), `POST /api/v1/legal/comparisons` (`confirmCrossFamily`)
- `GET /api/v1/market/overview`, `GET /api/v1/market/comparables`, `GET|POST /api/v1/market/notes` (`seriesKey`), `POST /api/v1/market/notes/[id]`,
  `GET|POST /api/v1/market/geography-mappings`, `GET|POST /api/v1/market/analysis`
- `GET|POST /api/v1/content/posts`, `POST /api/v1/content/posts/[id]` (`action`: draft|save|brand_confirm|link_note|public_fact|remove_evidence|plan|approve|published|discard),
  `POST /api/v1/content/plan`, `GET /api/v1/content/calendar`, `GET|POST /api/v1/content/settings` (admin)
- `GET /api/v1/insights`, `GET|POST /api/v1/insights/deals/[id]`, `POST /api/v1/insights/playbook`, `GET|POST /api/v1/insights/experiments`

Natural dedupe on replays: watchlist upsert, evidence (org+type+day+text), legal docs (family+sha256), comparisons
(unique per engine version), dossier (fingerprint), job-move proposals (claim-derived keys), weekly plan (week+topic),
strategy snapshot (per day).

## Settings
`workspace_setting` keys (admin-only writes, edited under Content → Guardrails / Your voice): `content.voice_samples` (string[]),
`content.brand_rules` (string[]; auto-checked forms: `avoid: a, b`, `max N hashtags`, `no hashtags`, `no emojis`, `no exclamation marks`,
`max N characters`, `max N words`, `must include: …`), `content.confidential_terms` (string[]). A licensed source permits publication only
when one of its `allowed_purposes` mentions publication/marketing/external.
No env vars beyond the shared ones.

## Tests
`npx vitest run src/modules/intelligence` — pure (`intelligence.test.ts`) and DB-backed (`intelligence.db.test.ts`):
person-move confidentiality, unknowns/expiry, rerun skip, budget degrade + latch, prompt injection, clause extract +
redline, market series rules (historical periods), cohort counting, strategist, content checklist, loader smoke as
owner and restricted colleague.

## intel-B round 2 (migration `20261101000650_intel_b_legal_market_content.sql`)
New columns: `legal_document.file_kind/page_count/ocr_status/extraction_notes/lease_id` (uploads also set `org_id` + `asset_id`, from the
chosen lease when given, so Lease Radar can match clauses), `clause_extract.validation`, `clause_comparison.base_version/compare_version/
same_family/cross_family_confirmed/full_redline` (check: different family ⇒ confirmed), `market_note.sources/sample_size/caveats/has_forecast/unit`,
`content_post.planned_publish_on/fact_check/private_version/content_flags/brand_confirmed_sha256`. New table `market_analysis`
(make_business_table). Trigger `market_observation_release_enqueue` (statement-level, SECURITY DEFINER `mudar_app.intel_market_release_enqueue`).
Comparisons use engine `legal-v2` (older comparisons stay; re-compare for full redlines). Tests: `intel-b.test.ts` (pure), `intel-b.db.test.ts`.

## Known gaps
- Patrol and research jobs run with the service role; patrol from the UI runs over the caller's visible rows only.
- Market observations come from imports; there is no manual observation entry form.
- Scanned PDFs are not OCR'd (no vision call): they are stored as "OCR needed" and the user supplies verified text as the next version.
- Fact check is lexical: company detection covers known workspace organisations and names with corporate suffixes; claims are tied to
  evidence by metric keyword and the sign of stated changes. Units of matched numbers are not cross-checked.
- Geography mapping proposals are routine-risk change proposals (applied from /approvals); they add an alias rather than rewriting rows.
- Experiments: no subject assignment UI or API yet (rows must be inserted into `experiment_subject` directly).
- Deal strategist links to `/deals/[id]` (owned by the deals module).
- Cross-tenant FK checks (security review M4) are not added for these tables; relies on the core generic fix.

## Round 2 (intel-A: workflows 05, 06, 15)
Migration `supabase/migrations/20261101000600_intelligence_round2.sql` (re-runnable): table `introduction_consent`
(business table), unique live source name in `research_source_registry`, `negotiation_log.kind` + `evidence_gaps`,
`concession_item` marked DEPRECATED (comment), and AFTER triggers that only enqueue jobs:
`intel_strategy_on_stage` (opportunity stage change), `intel_strategy_on_quote` (new quote / revision),
`intel_strategy_on_objection` (objection_log insert) → `intelligence.strategy`; `intel_research_on_signal`
(rule-detected signal on an active watchlist company) → `intelligence.research_org`. Dedupe key per event.

**05 Prospect Researcher**
- `research/sources.ts` (pure): registry rules (always-prohibited methods, licensed sources need a licence link + rights,
  LinkedIn only native alert/export, web search needs a rate limit) and `evidencePolicy` for pasted evidence: must cite an
  allowed registry source (link host must match) or be a manual note (tier capped at single_unverified); licensed sources
  need a valid licence (expiry, purpose) and store the claim `licensed_restricted`; such claims are excluded from AI
  synthesis unless the licence permits AI (then the call is classified licensed_restricted → data-lane check).
- `research/registry.ts` + `/research/sources` (admin): add / edit / disable / re-enable sources.
- Claim dating (`dossier.ts`): `date_basis` = source | internal_record | event | generated | unknown and
  `record_updated_on`; internal records show “internal record (last updated …)”; undated stakeholder / intro / evidence
  claims stay “date unknown” (never today’s date).
- `research/signals.ts`: rule-based detection (expansion, consolidation, RTO, GCC, hiring/hiring surge, leadership change,
  funding; negation-aware) → hypothesis claims (`ai_inference`, tier `inference`, `value_json.source_claim_id`, expiry ≤
  source expiry; hiring keeps the “not an office-size commitment” note). Runs on every paste, from the dossier page, and
  in the daily research job over the last day’s evidence.

**06 Network Intelligence**
- `network/relationships.ts`: record / update / end relationships (never sets intro permission), record and revoke
  introduction consent (who gave it, method, date; recorded by owner_user_id/created_at; mirrored to
  `consent_permission` purpose/channel `introduction`), `draftIntroRequest` (draft only, refused without active consent).
- Intro paths use consent records (not the bare flag) and drop suppressed people (`findIntroPaths(..., opts)`).
- Job moves: open candidate claim reused on replay; deduped verification task (`network.verify_job_move:<person>:<org>`);
  “unverified” until `verifyJobMove` or the employment proposal is applied.
- UI: relationship + consent panel on `/people/[id]` (`network/ui.tsx`), relationship form, consent state, “Mark
  confirmed” and intro-draft buttons on `/network`.

**15 Deal Strategist**
- Reads `objection_log` (deals) plus `interaction.objections`; quotes with version/terms/evidence; stage history;
  shortlisted availability; unsourced org claims. Evidence gaps: stale/expired or unevidenced quotes, unverified or stale
  availability, unconfirmed stakeholders/requirement, claims without evidence.
- Concession ladder canonical table = `concession_step` (status planned→offered/accepted/rejected/withdrawn, `quote_id`,
  `value_json.finance_type` + `finance_value` (from a requirement target vs the quoted term, else one illustrative step: +1 month rent-free, −1 pp escalation, −1 deposit month; absent when unknown, never 0) for deals' `deals.concession_npv`; `npv_equivalent` shown when the engine fills
  it). Existing steps and user statuses are never modified. **`concession_item` is deprecated — nothing writes it.**
- Suggestion-only: jobs and snapshots never change stage, price or terms and never send anything.

New jobs: `intelligence.research_org` (payload `org_id`, `signal_claim_id`; refreshes the dossier, in-app `notify`
“research.signal” to the watch owner), `intelligence.strategy` (payload `opportunity_id`, `reason`, `ref`).

New API (mutations need `Idempotency-Key`): `GET|POST /api/v1/research/sources` (POST admin), `POST /api/v1/research/sources/[id]`
(full update with `expectedVersion`, or `{allowed}`), `POST /api/v1/research/signals` `{orgId}`, `GET|POST /api/v1/network/relationships`,
`POST /api/v1/network/consents`, `POST /api/v1/network/consents/[id]/revoke`, `POST /api/v1/network/job-moves/[id]/verify`,
`POST /api/v1/network/intro-drafts` `{edgeId}`. `POST /api/v1/research/evidence` now requires `sourceId` or `manualNote: true`.

Tests: `intel-a.round2.test.ts` (pure) and `intel-a.round2.db.test.ts` (DB).

Known gaps (round 2): no UI for colleagues as introducers (relationships are “me” or a person); concession NPV values are
not computed here (the deals finance engine must fill `npv_equivalent`); signal detection is English keyword rules only
(no Hindi/Marathi); triggers enqueue a strategy job for every open opportunity on the quote’s requirement.

## Real-data fix — comparables locality (`market/comps-locality.test.ts`)
`marketComparables` used only the linked building's locality; tracker deals link to a building only on an exact key, so
2 of 40 Kharadi deals were comparables. Falls back to the source row's `extras.locality_raw` (`txLocality`).
