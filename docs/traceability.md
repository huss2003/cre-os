# Traceability — the spec's 72 answered items → CRE OS

Source: `docs/spec.txt`, Part III "Traceability: all 72 answered items" (columns *Q*, *Recovered answer / requirement*,
*Design treatment*; "B" = blueprint section of Part I). This table adds where each item lives in CRE OS and an honest
build status.

**Re-audited 31 Oct 2026, after all seven modules were finished** (module READMEs, `src/app/(app)/**/page.tsx`,
`src/app/api/**/route.ts`, `supabase/migrations/*`). Test suite: 348 tests in 40 files, all passing.

| Status | Count |
|---|---:|
| **built** | **57** (5 of them satisfied by documentation/process: Q42, 67, 69, 70, 71) |
| **partial** | **14** (Q8, 10, 11, 19, 27, 35, 46, 49, 53, 56, 60, 64, 68, 72) |
| **planned** | **1** (Q40 infrastructure registry / map) |

"Built" describes the code. Nothing is deployed yet: production needs the platform items in
[launch-dependencies.md](launch-dependencies.md) (Supabase Pro, Vercel Pro, OpenAI key, OAuth apps) and each tenant's
items (data-processing agreement, templates, writing samples, CRM/licence rights). Until then AI and connectors run in
mock mode.

## Status key

| Status | Meaning |
|---|---|
| **built** | Works end to end in code: schema + service + page/API route (or scheduled job) + tests. Documentation/process items count as built when the document exists. Known gaps from the module README are noted in the row. |
| **partial** | The main path works, but a part of the requirement is missing (named in the row) |
| **planned** | Not in code; design noted |

Tenant-specific names in the spec (Colliers, Jasfo, CRE Matrix) are per-tenant configuration in CRE OS:
`template_asset`, `partner`, `licensed_source`, `data_lane`, `workspace_setting`.

Re-check with:

```bash
find src/app -name page.tsx -o -name route.ts | sort      # which screens / endpoints exist
ls src/modules/*/README.md                                 # each module's "what's built / known gaps"
npx vitest run src/modules/<m>                             # acceptance tests per module
```

## Table

| Q | Recovered answer / requirement | Spec design treatment | CRE OS implementation (module · route · table/code) | Status |
|---|---|---|---|---|
| 1 | Manager, occupier services; not independently acquiring mandates | Separate opportunity, mandate and corporate account-owner fields; B2/B8 | deals · `/deals`, `/requirements`, `/api/v1/opportunities/**` · `opportunity.mandate_status`, `account_owner_user_id`, `requirement.mandate_status/conflict_status` | built |
| 2 | Pune primarily, other cities demand/reference based | Geography hierarchy, no Pune-only schema; B2/B6 | core `geography` (hierarchy) + `entity_alias`; imports creates micro-market geographies with aliases (`pipeline.ts`); nothing Pune-specific in schema | built |
| 3 | Conventional, managed, coworking, GCC, renewals, relocation, consolidation, BTS and investment | Shared lifecycle with transaction-specific modules; B2/B8 and annex | deals · `requirement.objective/transaction_kinds` (`requirements/contract.ts`), `opportunity.stage` (`pipeline/stages.ts`), finance scenario types (`finance/engine.ts`) · `/requirements`, `/deals`, `/finance` | built |
| 4 | Above 5,000 and under 200,000 SF | Strict configurable eligibility, exception review; B2/B3 | admin `/settings` → `workspace_setting.size_rules` (strict 5,000/200,000); imports `classifySize` (boundaries flagged for review, small rows kept); deals matching hard filters. Imports now read the Settings `size_rules` (with `imports.size_rules` as an override) | built |
| 5 | GCC, IT/ITES, BFSI, manufacturing, engineering, pharma, startups, Indian corporates and MNCs | Broad sector coverage; prioritise evidence and fee/time yield; B9/B13 | `organisation.sector` (no sector exclusion); brief `scoring.ts` ranks on evidence/timing, not sector · `/today` | built |
| 6 | 120/15/1 and six-month cycle | Cohort math, ramp and capacity; B12 | admin settings `cohort_targets` (120/170); brief `priority.ts computeCapacity`; intelligence `insights/metrics.ts cohortFunnel` · `/today`, `/insights` | built |
| 7 | ≥1/month; ₹5 crore FY; ₹30 lakh average | 12 vs 17-deal distinction, credit share and FY gap; B12 | deals `fees/fees.ts` (`feeSummary`, `feeProtectionIssues`), `pipeline/stages.ts funnel` · `/fees`, `POST /api/v1/opportunities/funnel` · `fee_milestone`, `opportunity.expected_fee/credit_share` (official fee rules = tenant item T10) | built |
| 8 | Balanced coverage, 80-90% back office with human loop | Measured eligible-task automation, human gates; B1/B13 | job queue (`job`, `/api/cron/tick`, module `jobs.ts`), `change_proposal` + `approval` · `/approvals`. **Gap:** time-saved / automation-share measurement not built | partial |
| 9 | Personal items plus corporate laptop/Microsoft | Separate ownership and restricted data lane; B4 | `data_lane`, `classification` on every row, `membership.allowed_classifications`; admin `/settings/lanes`, `/settings/members`; RLS tests (`tests/rls.test.ts`, `tests/security/*`) | built |
| 10 | Outlook, Teams, internal property/research, CRM | Approved adapters and Graph, official CRM authority; B5/B14 | integrations Graph mail/calendar (`providers/microsoft.ts`) · `/settings/connections`; deals `crm/export.ts` · `crm_export`, `opportunity.crm_external_id`. **Gaps:** no Teams; live Graph adapter not yet exercised against a real tenant | partial |
| 11 | No existing approved AI assistant | Start existing Plus in permitted lane; API processor separately configured; B5/B14 | single gateway `src/lib/ai/gateway.ts` (OpenAI only, `store:false`, budget, kill switch, mock mode); processors recorded in `data_lane.approved_processors` (`/settings/lanes`). **Gap:** the gateway does not check the lane's processor approval before a call | partial |
| 12 | External software/APIs/workflows permitted | Proceed within stated permission and actual connector scope; B5/B14 | integrations read-only scopes + `FORBIDDEN_SCOPES` check (`config.ts`, `oauth.ts`), tests | built |
| 13 | External cloud processing can be approved | Two data lanes and processor approval dependency; B4/B14 | `data_lane` (`approved_processors/regions`, `approval_evidence`, `permits_ai_processing`) · `/settings/lanes`; T1 in [launch-dependencies.md](launch-dependencies.md). Enforced at the AI gateway (`assertProcessingAllowed`): once lanes exist, data needs an approved lane listing `openai` for its classification; licensed-restricted data is blocked without one. **Gap:** callers send the default classification (corporate_confidential) rather than per-record classification | built |
| 14 | Separate database permitted | Relational master in permitted environment; B4/B6 | Supabase Postgres (Mumbai), core + module migrations; cloud project pending (P1) | built |
| 15 | No additional approval for routine integrations stated | Respect explicit manual outbound gate; B10/B14 | `draft` lifecycle + `app.integrations_draft_guard`, definer `app.approve_draft/open_draft_for_send/mark_draft_sent` (`001410`); no send route · `/drafts` | built |
| 16 | Design personal-productivity and fuller enterprise versions | Plus-only pilot and hybrid/colleague lanes; B4/B15 | multi-tenant `workspace`/`membership`/roles/`record_share`; admin `/platform`, `/settings/members`; cost cases in [costs.md](costs.md) | built |
| 17 | Incomplete personal + Colliers data, continuous updates | Provenance, classification, append observations; B3/B6 | `source_object` (sha256, versions), append-only `availability`, `market_observation`, `asset_observation`; imports revision diff · `/imports/[id]` | built |
| 18 | 50 sheets, 500 buildings, 8k companies, 25k contacts | Scalable relational store; observed 645 building keys; B2 | Postgres indexes/trigram/tsvector, `app.search_entities`; imports `scale.test.ts` (815 lease rows, idempotent re-run) | built |
| 19 | All file types, OneDrive, email and images | Multimodal authorised intake; B2/B8 | imports xlsx/csv · `/imports`; `.eml` import (`integrations/inbox.ts importEml`) · `/drafts` triage tab; capture voice/text/photo · `/capture`. **Gaps:** no PDF/OCR intake (photo caption is the content; legal desk takes pasted text with an "OCR unverified" flag); OneDrive selected-files scope only, no file download; email attachments metadata only; no watched-folder intake | partial |
| 20 | Laptop | Plus/local fallback, hosted availability explained; B5/B15 | hosted design: Vercel (`vercel.json` cron) + Supabase; brief runs server-side, not on a laptop; deploy pending (P1/P2) | built |
| 21 | Estimated 90% clean, fragmented | Measured file audit supersedes untested cleanliness estimate; B3 | imports reconciliation (`reconcile.ts`) · `/imports/[id]`, `GET /api/v1/imports/{id}/reconciliation` · `import_batch`, `staged_row`, `import_exception`, quarantine | built |
| 22 | Pune 2022/2023 trackers; more later; no individual broker | Firm-broker context retained; historical observations, not full mover labels; B3/B8 | imports `transactions_2022_v1`/`2023_v1` adapters · `market_transaction` (`historical_observed`). Gap (README): links to buildings only on exact building+locality key | built |
| 23 | Monthly/quarterly updates | Release-driven market observations and freshness; B9 | `market_observation` with period/definition; imports `market_matrix_v1`; intelligence `market/series.ts` · `/market`, `/api/v1/market/**`. Gap (README): no manual observation entry form | built |
| 24 | Detailed linked master database as moat | Entities, temporal relations, claim provenance; B6 | core domain schema (organisation, person, employment, asset, space, lease, lease_event, signal_claim, relationship_edge…); admin `/companies`, `/people`, `/buildings` with as-of | built |
| 25 | No reliable existing company/building identifier | Generate UUIDs, reviewed aliases and source-to-master mapping; B6 | UUID keys; `entity_alias`, `import_entity_key`, `identity_match_candidate` (reviewed; link = merge proposal) · `/imports/[id]` identity review, `POST /api/v1/imports/matches/{id}` | built |
| 26 | Representative samples can be shared | All eleven supplied sources inspected read-only; B3 | imports adapters for the audited files (`adapters/*`, detection by header fingerprint) · `adapter_mapping` (admin approval) | built |
| 27 | CRE Matrix | Entitled export/API and licence registry, no assumed redistribution; B14 | `licensed_source` registry · `/settings/sources`; `licensed_restricted` classification (owner-only import, RLS); restricted originals under `<ws>/private/imports/`. `permits_ai_processing` enforced by the AI gateway when callers pass `licensedSourceIds`. **Gap:** research/import callers don't pass source ids yet | partial |
| 28 | Comprehensive dossiers | Standard dossier contract and evidence; B8 | intelligence `research/dossier.ts` (17 sections), `research/service.ts` · `/research`, `/research/[orgId]`, `/api/v1/research/dossiers/{orgId}` · `research_dossier`, `research_source_registry` | built |
| 29 | Personal context for warm relationships | Voluntary/relevant context, restrictions, no sensitive inference; B9/B14 | `permitted_personal` classification, `consent_permission`, integrations `consent.ts` (suppress/revoke/erase with tombstones), `relationship_edge`; gateway prompts forbid invention | built |
| 30 | Identify prospects across signals | Public trigger radar, bounded watchlists; B8/B9 | intelligence `watchlist`, `research/patrol*.ts` (`intelligence.patrol` 05:30), `signal_claim`, `evidence_finding` · `/research`, `/api/v1/research/watchlist`, `/findings` | built |
| 31 | Named companies and discovery | Both named and signal-driven queues; B8 | intelligence `upsertWatch`, `dueForResearch` (tiered refresh, `intelligence.research` 05:45) | built |
| 32 | LinkedIn crucial | Compliant native/manual/API-limited intelligence; B9 | manual pasted evidence (`addPastedEvidence`, `POST /api/v1/research/evidence`), `recordJobMove`; LinkedIn messages are drafts only; **no scraping/automation by design** | built |
| 33 | Complete network, approved way claimed | Evaluate actual authorised method; no promise of automated full-graph access; B9 | intelligence `network/graph.ts findIntroPaths` (2-hop needs permission), threading gaps · `/network`, `/api/v1/research/network/**`; edges from permitted data only | built |
| 34 | Reliable but retain unverified | Separate claims, confidence and client-use gates; B6/B9 | `fact_status` enum on facts, `signal_claim`; search and entity pages show status; dossier per-claim evidence tier | built |
| 35 | All Pune micro-markets | Geography aliases and corridor/locality mapping; B2/B6 | `geography` + `entity_alias`; micro-markets created from market imports. **Gap:** no screen to build/edit the corridor > micro-market > locality mapping; mapping comes only from imported labels | partial |
| 36 | Detailed property information | Asset/space/availability/technical fields; B6/B8 | `asset`, `space`, `availability`, `asset_observation` · `/buildings`, `/buildings/[id]`. Gap (README): spaces/availability are added via imports/captures, not from the building page | built |
| 37 | Incomplete assets and spaces | Building/floor/unit hierarchy, completeness and snapshot status; B6 | asset (campus > tower, towers never collapsed) / space hierarchy; append-only availability snapshots; admin `vacancyState` | built |
| 38 | Automatic recommendations | Hard filters then explained scoring; B8 | deals `matching/match.ts` (match-v1: hard eligibility, weights, fit vs completeness), `matching/service.ts runShortlist` · `/requirements/[id]`, `GET/POST /api/v1/requirements/{id}/shortlist` · `shortlist_option`, `shortlist_version` | built |
| 39 | All descriptive, scenario, statistical and later predictive analysis | Staged analytics with period/definition validation and out-of-time tests; B8/B9 and annex | intelligence `market/series.ts` (definition/date/unit gate, trends with gaps), `insights/metrics.ts` (conversion, time-to-stage with censoring); deals finance scenarios/sensitivities · `/market`, `/insights`, `/finance`. Predictive models deliberately not in v1 | built |
| 40 | Map extensive infrastructure and likely building impacts | Dated infrastructure registry, map layers and scenario-only impacts; annex | — no infrastructure registry, map layer or impact scenarios | planned |
| 41 | 3-12 months most important | Expiry priority plus notice/fit-out reverse planning; B9 | brief `lease-radar.ts` (`reversePlan`, `callWindowFor`, notice ≠ lock-in ≠ expiry ≠ break), imports `lease-events.ts` · `/leases`, radar tasks. Gap (README): no holiday calendar for business-day notice | built |
| 42 | No preferred tool; easiest/fastest | Concrete minimal-subscription stack; B5 | Next.js + Supabase + Vercel + OpenAI; [costs.md](costs.md) (doc) | built |
| 43 | 500 leads, 600 relationships; double later; 1-1.5k research | Tiered refresh and scale envelope; B2/B9 | intelligence research tiers (`dueForResearch`, capacity warnings in `upsertWatch`), `budgetLatch`; gateway monthly budget cap | built |
| 44 | Rare multiple independent requirements; mandates difficult | Company > multiple requirements, separate mandate status; B6/B8 | `requirement.org_id` (many per company), `opportunity.mandate_status` · `/requirements`, `/deals` | built |
| 45 | Recommend priorities and weights | Initial rubric, calibration and capacity controls; B9 | brief `scoring.ts` (100-point rubric, tiers 75/50), `priority.ts selectTargets` (exploration share, displaced item) · `lead_score`, `daily_plan` · `/today` | built |
| 46 | Company + person views; searchable interactions | Stable person, employment history, chronology; B6/B7 | admin `search.ts` + `app.search_entities` · `/search`, `GET /api/v1/search`; `entities.ts getCompany/getPerson` (as-of, employment history, interaction chronology) · `/companies/[id]`, `/people/[id]`. **Gap:** global search covers companies, people, buildings, requirements, opportunities — not interaction text | partial |
| 47 | Automatic movement, inform and undo | Change digest, risk gates, compensating reversal; B10 | `proposeChange` + `classifyRisk` (`src/lib/services/changes.ts`); SQL `app.approve_change/apply_change/reverse_change`, `change_conflict`; `changes/service.ts changeDigest`, batch undo · `/approvals`, `/api/v1/changes/**` | built |
| 48 | Preserve person history, flag old/new companies | Employment episode changes and confidential-context separation; B6 | `employment` episodes; changes `proposePersonMove`; intelligence `recordJobMove`, confidentiality filter in `dossier.ts` | built |
| 49 | Outlook, occasional Gmail, WhatsApp, calls, LinkedIn, Teams | Explicit integration/fallback boundaries; B5/B14 | Outlook + Gmail read-only connectors (`/settings/connections`), `.eml` import; WhatsApp/LinkedIn as drafts (`wa.me`/link + copy); calls via `/capture`. **Gaps:** no Teams; no push webhooks (polling 10–15 min) | partial |
| 50 | 4-5 new contacts/day, ≤15 follow-ups, 10 meetings + 10 visits/week | Throughput mismatch and human capacity model; B12 | brief `computeCapacity`, `selectTargets`; `user_preference` capacity; integrations sequence caps | built |
| 51 | All external communication approved | No-send MVP, manual release; B10 | hash-bound draft approval (`app.draft_content_hash`), `draft_event`, DB guard; no send capability; `tests/security/drafts.test.ts` | built |
| 52 | Individualised campaigns | Evidence/persona/relationship draft sequences and suppression; B8 | integrations `sequences.ts` (3-touch/21-day, pause on reply), `touches.ts` collisions · `outreach_sequence`, `sequence_enrollment`, `suppression_tombstone`, `account_touch`; `integrations.sequence_tick` | built |
| 53 | Read permitted inbox, signals, summaries, tasks, replies; hot after hours | Inbox triage, reconnect/failure state, private urgency rules; B7/B8 | integrations inbox sync + `triage.ts` · `inbound_message`, `/drafts` triage tab; `alerts.ts` + brief `urgent.ts` (opt-in, DND) → `outbox`, shown on `/today`; `StaleBanner` on failure. **Gaps:** urgent alerts are in-app only (no push/email to the adviser after hours); no model-based hot-reply detection | partial |
| 54 | Manual sending queue | Draft approval and mark-sent distinction; B8/B10 | `draft.state` drafted → approved → opened_for_send → marked_sent → reconciled_sent · `/drafts`, `/api/v1/drafts/**`; `integrations.sent_reconcile` | built |
| 55 | Market intelligence content brand/LinkedIn | Public-source editorial queue, brand review; B8 | intelligence `content/editor.ts`, `content/service.ts` (weekly plan, brand/confidentiality checklist, approve → manual publish) · `/content`, `/api/v1/content/**` · `content_post`, `market_note` | built |
| 56 | No templates; individual voice, audience variants | Obtain approved templates; build style samples, no invented Colliers standard; B11 | `template_asset` registry · `/settings/templates` (neutral layout, flagged, when none approved); voice samples `content.voice_samples` · `/content`. **Gaps:** voice samples are used by the content editor only, not by outreach/reply drafts; uploaded master .pptx/.docx files are not merged | partial |
| 57 | 10 AM-9 PM inefficient current day | Protected call blocks, morning preparation, travel grouping; B7/B12 | brief `priority.ts` daily plan (call blocks, travel buffers); integrations `calendar.ts` conflicts + `clusterByLocality` · `/today`, `/calendar` · `calendar_event`, `meeting_visit`. Gap (README): clustering by locality, not travel time | built |
| 58 | Phone capture, laptop analysis, flexible | Responsive workbench and editable Office outputs; B7/B11 | mobile-first pages (375 px, `scripts/smoke.mjs` at 390/1366 px); deals `documents/*` PPTX/DOCX/XLSX (real formulas) · `/documents` | built |
| 59 | Daily voice/chat/image debrief and ambiguity questions | Capture contracts and confirmation UX; B8 | capture `extract.ts` (zod contract, `ruleExtract`, `enforceRules`), `service.ts processCapture` (`capture.process`) · `/capture`, `/capture/[id]` review, `/api/v1/captures/**` · `capture`, `capture_span`. Gaps (README): no photo OCR; mock mode needs typed text for voice; no stakeholder-role extraction | built |
| 60 | Permitted calls; meetings often not recorded; Hindi/English/Hinglish | Consent reference and transcription benchmark; B8/B14 | `capture.consent_reference`, `language_hint`; gateway `transcribe()`. **Gap:** transcription benchmark not run (needs consented samples, tenant item T8) | partial |
| 61 | Proactive 8 AM, meeting briefs, routes, reconciliation/reviews | Durable scheduled/event jobs and fallback; B7 | brief `scheduler.ts` + `jobs.ts` (07:00 recalc → 08:00 deliver, 07:55 health check, 08:05 alert, T-60, 20:30 reconcile, Fri weekly), `watchdog.ts` · `brief`, `brief_health_run` · `/today`, `/api/v1/briefs/**` | built |
| 62 | Advanced financial comparisons, simple professional presentation | Deterministic model, equal horizons, editable financial outputs; B11 | deals `finance/engine.ts` (fin-1.0, decimal.js; hand-computed tests) · `/finance`, `/finance/[id]`, `/api/v1/finance/**` · `finance_scenario`, `finance_cashflow`; comparison XLSX. Gap (README): no occupied-seat scenarios or XNPV | built |
| 63 | Jasfo reliable partner | Actual terms as inputs, partner neutrality and finance model; B8/B11 | `partner` (per tenant) · `/settings/partners`; finance `compareFinancingOffers`, `concessionEquivalence` · `POST /api/v1/finance/financing`, `/concessions` | built |
| 64 | All stage deliverables, editable and Colliers format | Stage/template registry and brand dependency; B11 | deals `documents/service.ts` (`shortlist_deck`, `proposal`, `market_note`, `comparison_xlsx`; staleness, approve, release with leakage check) · `/documents`, `/api/v1/documents/**` · `template_asset`, `document_version`. **Gaps:** brand_json applied but uploaded master templates not merged; four document kinds, not every stage deliverable | partial |
| 65 | Surface legal comparison, Colliers legal review team | Legal desk scope and human authority; B8/B10 | intelligence `legal/clauses.ts`, `legal/service.ts` (extract with locators, redline, exposure checklist, "not legal advice") · `/legal`, `/legal/[id]`, `/legal/compare/[id]`, `/api/v1/legal/**` · `legal_document`, `clause_extract`, `clause_comparison` | built |
| 66 | Nontechnical after setup | Four primary screens, training and recovery runbooks; B7 | `/today`, `/capture`, `/approvals`, `/search` + `/admin` health; [operator-guide.md](operator-guide.md), [admin-runbook.md](admin-runbook.md) | built |
| 67 | External developer once, code if saves, avoid if possible | Small custom core vs extra subscriptions; maintenance made explicit; B5/B17 | handover docs (this folder), module READMEs, migrations, env template; maintenance in [admin-runbook.md §12](admin-runbook.md#12-monthly--quarterly-checklist) (doc) | built |
| 68 | Plus; second model provider if advantage | One provider initial, benchmark before second; B5/B15 | single provider via gateway; model pins in `pricing.ts`. **Gap:** 50-case model benchmark not built | partial |
| 69 | "Recommend," question missing | Architecture, reliability and governance recommendations labelled proposals | docs label defaults as proposals (retention, pricing, weights); retention policies need admin approval before purge (doc) | built |
| 70 | Price all three, cheapest, Plus-only dream | Three cost cases, licensing, workload and exclusions; B15 | [costs.md](costs.md) (doc) | built |
| 71 | Foundation in 30-45 days | Prioritised roadmap and gates; B16 | modules built in spec launch order; acceptance gates in [deploy.md go-live checklist](deploy.md#12-go-live-checklist) (doc) | built |
| 72 | Personal ownership, +1-2 colleagues; 90-day productive work and one deal | IP/data split, roles, measured outcomes, six-month caveat; B4/B12/B16 | roles + `record_share` + classifications for colleagues; outcome metrics in `/insights` (cohort funnel, stage conversion); IP position = tenant item T11. **Gap:** productive-work/time-saved outcome not measured (see Q8) | partial |

## What to close next

In rough priority order: enforce `data_lane` processor approval and `permits_ai_processing` in the AI gateway
(Q11, Q13, Q27); unify the size-rules setting key (Q4); push/email delivery for urgent alerts (Q53); voice samples for
outreach drafts and master-template merge (Q56, Q64); interaction search (Q46); geography mapping screen (Q35);
transcription and model benchmarks once tenant samples exist (Q60, Q68); time-saved measurement (Q8, Q72);
PDF/OCR intake (Q19); Teams (Q10, Q49); infrastructure registry (Q40). Per-module gaps:
[launch-dependencies.md § D](launch-dependencies.md#d-known-gaps-after-build).
