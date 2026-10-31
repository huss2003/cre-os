# Traceability — the spec's 72 answered items → CRE OS

Source: `docs/spec.txt`, Part III "Traceability: all 72 answered items" (columns *Q*, *Recovered answer / requirement*,
*Design treatment*; "B" = blueprint section of Part I). This table adds where each item lives in CRE OS and an honest
build status.

## Status key

| Status | Meaning |
|---|---|
| **built** | Schema + service code + user-facing page or API route exist, with tests where the spec has an acceptance test |
| **partial** | Some layers exist (schema and/or service/job code, maybe tests) but the page/API route or an important piece is missing |
| **planned** | Not started in code (or deliberately out of v1 scope); design noted |
| **doc** | Satisfied by documentation, configuration or process rather than code |

**Status snapshot: 31 Oct 2026, end of the docs pass.** At that moment the module service layers, job handlers and
migrations existed, but **no module pages (`src/app/(app)/<route>/page.tsx`) or `/api/v1/*` routes had landed yet** —
only the shell, login, cron and health routes. That is why nothing below is marked *built*. Re-assess with:

```bash
find src/app -name page.tsx -o -name route.ts | sort      # which screens / endpoints exist
ls src/modules/*/README.md                                 # each module's own "what's built / known gaps"
npx vitest run src/modules/<m>                             # acceptance tests per module
```

Tenant-specific names in the spec (Colliers, Jasfo, CRE Matrix) are per-tenant configuration in CRE OS:
`template_asset`, `partner`, `licensed_source`, `data_lane`, `workspace_setting`.

## Table

| Q | Recovered answer / requirement | Spec design treatment | CRE OS implementation (module · route · table/code) | Status |
|---|---|---|---|---|
| 1 | Manager, occupier services; not independently acquiring mandates | Separate opportunity, mandate and corporate account-owner fields; B2/B8 | deals · `/deals` · `opportunity.mandate_status`, `account_owner_user_id`, `requirement.mandate_status/conflict_status` | partial |
| 2 | Pune primarily, other cities demand/reference based | Geography hierarchy, no Pune-only schema; B2/B6 | core schema · `geography` (hierarchy), `entity_alias`; imports `normalize.ts` | partial |
| 3 | Conventional, managed, coworking, GCC, renewals, relocation, consolidation, BTS and investment | Shared lifecycle with transaction-specific modules; B2/B8 and annex | deals · `requirement.objective/transaction_kinds`, `opportunity.stage`; finance engine scenario types (`deals/finance/engine.ts`) | partial |
| 4 | Above 5,000 and under 200,000 SF | Strict configurable eligibility, exception review; B2/B3 | admin settings `size_rules` (default 5,000/200,000, strict) · `workspace_setting`; imports `classifySize`; deals matching hard filters | partial |
| 5 | GCC, IT/ITES, BFSI, manufacturing, engineering, pharma, startups, Indian corporates and MNCs | Broad sector coverage; prioritise evidence and fee/time yield; B9/B13 | `organisation.sector` (no sector exclusion); brief scoring (`brief/scoring.ts`) ranks by evidence not sector | partial |
| 6 | 120/15/1 and six-month cycle | Cohort math, ramp and capacity; B12 | admin settings `cohort_targets` (120/170); brief capacity (`brief/priority.ts computeCapacity`); intelligence insights · `/insights` | partial |
| 7 | ≥1/month; ₹5 crore FY; ₹30 lakh average | 12 vs 17-deal distinction, credit share and FY gap; B12 | deals fees · `/fees` · `fee_milestone`, `opportunity.expected_fee/credit_share`; high-value threshold ₹30 lakh in `changes.ts` | partial |
| 8 | Balanced coverage, 80-90% back office with human loop | Measured eligible-task automation, human gates; B1/B13 | job queue (`job`, `/api/cron/tick`), `change_proposal` + `approval`; time-saved measurement not built | partial |
| 9 | Personal items plus corporate laptop/Microsoft | Separate ownership and restricted data lane; B4 | `data_lane`, `classification` on every row, `membership.allowed_classifications` | partial |
| 10 | Outlook, Teams, internal property/research, CRM | Approved adapters and Graph, official CRM authority; B5/B14 | integrations Graph mail/calendar (`providers/microsoft.ts`); deals `crm_export`, `opportunity.crm_external_id`; **Teams not built** | partial |
| 11 | No existing approved AI assistant | Start existing Plus in permitted lane; API processor separately configured; B5/B14 | single AI gateway `src/lib/ai/gateway.ts` (OpenAI only, `store:false`); processor approval in `data_lane.approved_processors` | partial |
| 12 | External software/APIs/workflows permitted | Proceed within stated permission and actual connector scope; B5/B14 | integrations read-only scopes (`integrations/config.ts`, `FORBIDDEN_SCOPES`) | partial |
| 13 | External cloud processing can be approved | Two data lanes and processor approval dependency; B4/B14 | `data_lane` (`approved_processors/regions`, `approval_evidence`); [launch-dependencies.md](launch-dependencies.md) T1 | partial |
| 14 | Separate database permitted | Relational master in permitted environment; B4/B6 | Supabase Postgres, Mumbai; core migrations | partial (local only until deployed) |
| 15 | No additional approval for routine integrations stated | Respect explicit manual outbound gate; B10/B14 | `draft` lifecycle + `app.integrations_draft_guard`; no send route; `src/lib/services/drafts.ts` | partial |
| 16 | Design personal-productivity and fuller enterprise versions | Plus-only pilot and hybrid/colleague lanes; B4/B15 | multi-tenant `workspace`/`membership`/roles/`record_share`; cost scenarios in [costs.md](costs.md) | partial |
| 17 | Incomplete personal + Colliers data, continuous updates | Provenance, classification, append observations; B3/B6 | `source_object` (sha256, versions), append-only `availability`, `market_observation`, imports revision handling | partial |
| 18 | 50 sheets, 500 buildings, 8k companies, 25k contacts | Scalable relational store; observed 645 building keys; B2 | Postgres with indexes/trigram/tsvector; `app.search_entities` | partial |
| 19 | All file types, OneDrive, email and images | Multimodal authorised intake; B2/B8 | imports xlsx/csv (`imports/parse.ts`); `.eml` import (`integrations/eml.ts`); capture image/audio (schema only); OneDrive selected-files scope opt-in; **PDF/OCR intake not built** | partial |
| 20 | Laptop | Plus/local fallback, hosted availability explained; B5/B15 | hosted on Vercel + Supabase; brief does not depend on a laptop | partial (not deployed yet) |
| 21 | Estimated 90% clean, fragmented | Measured file audit supersedes untested cleanliness estimate; B3 | imports reconciliation · `import_batch`, `staged_row`, `import_exception`, quarantine | partial |
| 22 | Pune 2022/2023 trackers; more later; no individual broker | Firm-broker context retained; historical observations, not full mover labels; B3/B8 | imports `adapters/transactions.ts` · `market_transaction` (historical_observed) | partial |
| 23 | Monthly/quarterly updates | Release-driven market observations and freshness; B9 | `market_observation` with period/definition; imports period resolution; intelligence market · `/market` | partial |
| 24 | Detailed linked master database as moat | Entities, temporal relations, claim provenance; B6 | core domain schema (organisation, person, employment, asset, space, lease, lease_event, signal_claim, relationship_edge…) | partial |
| 25 | No reliable existing company/building identifier | Generate UUIDs, reviewed aliases and source-to-master mapping; B6 | UUID keys; `entity_alias`, `import_entity_key`, `identity_match_candidate` (reviewed, no silent merge) | partial |
| 26 | Representative samples can be shared | All eleven supplied sources inspected read-only; B3 | imports adapters for the audited files (`adapters/assets.ts`, `leases.ts`, `transactions.ts`) · `adapter_mapping` | partial |
| 27 | CRE Matrix | Entitled export/API and licence registry, no assumed redistribution; B14 | `licensed_source` registry, `licensed_restricted` classification, `source_object.licensed_source_id` | partial |
| 28 | Comprehensive dossiers | Standard dossier contract and evidence; B8 | intelligence `research/dossier.ts`, `research/service.ts` · `/research` · `research_dossier`, `research_source_registry` | partial |
| 29 | Personal context for warm relationships | Voluntary/relevant context, restrictions, no sensitive inference; B9/B14 | `permitted_personal` classification, `consent_permission`, `relationship_edge`; gateway guard forbids invention | partial |
| 30 | Identify prospects across signals | Public trigger radar, bounded watchlists; B8/B9 | intelligence `watchlist`, `research/patrol.ts`, `signal_claim`, `evidence_finding` | partial |
| 31 | Named companies and discovery | Both named and signal-driven queues; B8 | intelligence `upsertWatch`, `dueForResearch` (tiered refresh) | partial |
| 32 | LinkedIn crucial | Compliant native/manual/API-limited intelligence; B9 | manual capture / pasted evidence (`addPastedEvidence`), `recordJobMove`; **no scraping by design** | partial |
| 33 | Complete network, approved way claimed | Evaluate actual authorised method; no promise of automated full-graph access; B9 | intelligence network `findIntroPaths`, `relationship_edge` from permitted data only | partial |
| 34 | Reliable but retain unverified | Separate claims, confidence and client-use gates; B6/B9 | `fact_status` enum (`currently_confirmed` / `reported` / `historical_observed` / `ai_inference` / `unknown`), `signal_claim`; search returns status | partial |
| 35 | All Pune micro-markets | Geography aliases and corridor/locality mapping; B2/B6 | `geography` + `entity_alias` | partial |
| 36 | Detailed property information | Asset/space/availability/technical fields; B6/B8 | `asset`, `space`, `availability`, `asset_observation`; admin `/buildings` | partial |
| 37 | Incomplete assets and spaces | Building/floor/unit hierarchy, completeness and snapshot status; B6 | asset (campus > tower) / space hierarchy; append-only availability snapshots | partial |
| 38 | Automatic recommendations | Hard filters then explained scoring; B8 | deals `matching/match.ts` (hard eligibility, weights, fit vs completeness, tests) · `shortlist_option`, `shortlist_version` · `POST /v1/requirements/{id}/shortlist` (route pending) | partial |
| 39 | All descriptive, scenario, statistical and later predictive analysis | Staged analytics with period/definition validation and out-of-time tests; B8/B9 and annex | intelligence market/insights (descriptive: median/percentile); **no predictive models by design** | partial |
| 40 | Map extensive infrastructure and likely building impacts | Dated infrastructure registry, map layers and scenario-only impacts; annex | — no infrastructure registry or map layer yet | planned |
| 41 | 3-12 months most important | Expiry priority plus notice/fit-out reverse planning; B9 | brief `lease-radar.ts` (`reversePlan`, `callWindowFor`, notice vs lock-in vs expiry), imports `inThreeToTwelveMonthWindow` · `/leases` | partial |
| 42 | No preferred tool; easiest/fastest | Concrete minimal-subscription stack; B5 | Next.js + Supabase + Vercel + OpenAI; [costs.md](costs.md) | doc |
| 43 | 500 leads, 600 relationships; double later; 1-1.5k research | Tiered refresh and scale envelope; B2/B9 | intelligence research tiers (`dueForResearch`, `nextRefreshAt`); AI budget cap | partial |
| 44 | Rare multiple independent requirements; mandates difficult | Company > multiple requirements, separate mandate status; B6/B8 | `requirement.org_id` (many per company), `opportunity.mandate_status` | partial |
| 45 | Recommend priorities and weights | Initial rubric, calibration and capacity controls; B9 | brief `scoring.ts` (100-point rubric, tiers 75/50), `priority.ts selectTargets` · `lead_score`, `daily_plan` | partial |
| 46 | Company + person views; searchable interactions | Stable person, employment history, chronology; B6/B7 | admin `search.ts` + `app.search_entities` (tests), `entities.ts getCompany/getPerson` with as-of · `/search`, `/companies`, `/people` (pages pending) · `interaction` | partial |
| 47 | Automatic movement, inform and undo | Change digest, risk gates, compensating reversal; B10 | `proposeChange` + `classifyRisk` (`src/lib/services/changes.ts`); SQL `app.approve_change/apply_change/reverse_change`, `change_conflict` · `/approvals` (page pending) | partial |
| 48 | Preserve person history, flag old/new companies | Employment episode changes and confidential-context separation; B6 | `employment` episodes; intelligence `recordJobMove`, `detectFormerContacts` | partial |
| 49 | Outlook, occasional Gmail, WhatsApp, calls, LinkedIn, Teams | Explicit integration/fallback boundaries; B5/B14 | Outlook + Gmail read-only connectors, `.eml` import; WhatsApp/LinkedIn as drafts only; calls via capture; **Teams not built** | partial |
| 50 | 4-5 new contacts/day, ≤15 follow-ups, 10 meetings + 10 visits/week | Throughput mismatch and human capacity model; B12 | brief `computeCapacity`, `selectTargets`; `user_preference` capacity | partial |
| 51 | All external communication approved | No-send MVP, manual release; B10 | hash-bound draft approval, `draft_event`, DB guard trigger; no send capability | partial |
| 52 | Individualised campaigns | Evidence/persona/relationship draft sequences and suppression; B8 | integrations `sequences.ts` (3-touch/21-day default, pause on reply) · `outreach_sequence`, `sequence_enrollment`, `suppression_tombstone`, `account_touch` | partial |
| 53 | Read permitted inbox, signals, summaries, tasks, replies; hot after hours | Inbox triage, reconnect/failure state, private urgency rules; B7/B8 | integrations inbox sync · `inbound_message`; `alerts.ts` + brief `urgent.ts` (DND, dedupe) · `outbox` | partial |
| 54 | Manual sending queue | Draft approval and mark-sent distinction; B8/B10 | `draft.state` drafted → approved → opened_for_send → marked_sent → reconciled_sent · `/drafts` (page pending) | partial |
| 55 | Market intelligence content brand/LinkedIn | Public-source editorial queue, brand review; B8 | intelligence `content_post`, `market_note` · `/content` | partial |
| 56 | No templates; individual voice, audience variants | Obtain approved templates; build style samples, no invented Colliers standard; B11 | `template_asset` registry (per tenant); **writing-sample/style store not built** | partial |
| 57 | 10 AM-9 PM inefficient current day | Protected call blocks, morning preparation, travel grouping; B7/B12 | brief `priority.ts` daily plan (call blocks, travel settings), `calendar_event`, `meeting_visit` | partial |
| 58 | Phone capture, laptop analysis, flexible | Responsive workbench and editable Office outputs; B7/B11 | mobile-first shell (375 px rule S9); `pptxgenjs`/`docx`/`exceljs` outputs (deals documents) | partial |
| 59 | Daily voice/chat/image debrief and ambiguity questions | Capture contracts and confirmation UX; B8 | capture schema (`capture`, `capture_span`) + changes SQL; **extraction/ambiguity pipeline and `/capture` page not built yet** | partial |
| 60 | Permitted calls; meetings often not recorded; Hindi/English/Hinglish | Consent reference and transcription benchmark; B8/B14 | `capture.consent_reference`, `language_hint`; gateway `transcribe()` with Hinglish/Pune prompt; benchmark pending | partial |
| 61 | Proactive 8 AM, meeting briefs, routes, reconciliation/reviews | Durable scheduled/event jobs and fallback; B7 | brief `scheduler.ts` (07:00 recalc → 08:00 deliver, 07:55 health check, 08:05 alert, T-60, 20:30 reconcile, Fri weekly) · `brief`, `brief_health_run` · `/today` (page pending) | partial |
| 62 | Advanced financial comparisons, simple professional presentation | Deterministic model, equal horizons, editable financial outputs; B11 | deals `finance/engine.ts` (decimal.js; NPV/TCO/escalation/free rent/deposit; tests) · `finance_scenario`, `finance_cashflow` · `/finance` (page pending) | partial |
| 63 | Jasfo reliable partner | Actual terms as inputs, partner neutrality and finance model; B8/B11 | `partner` (per tenant, `reliability_preference`), finance `compareFinancingOffers`, `concessionEquivalence` | partial |
| 64 | All stage deliverables, editable and Colliers format | Stage/template registry and brand dependency; B11 | `template_asset` + `document_version` (input_versions, approved_hash, stale) · `/documents`; generator not yet present | partial |
| 65 | Surface legal comparison, Colliers legal review team | Legal desk scope and human authority; B8/B10 | intelligence `legal/clauses.ts`, `legal/service.ts` · `legal_document`, `clause_extract`, `clause_comparison` · `/legal` | partial |
| 66 | Nontechnical after setup | Four primary screens, training and recovery runbooks; B7 | Today/Capture/Approvals/Search + Health; [operator-guide.md](operator-guide.md), [admin-runbook.md](admin-runbook.md) | partial (docs done; screens pending) |
| 67 | External developer once, code if saves, avoid if possible | Small custom core vs extra subscriptions; maintenance made explicit; B5/B17 | handover docs (this folder), migrations, env template; maintenance in [admin-runbook.md §12](admin-runbook.md#12-monthly--quarterly-checklist) | doc |
| 68 | Plus; second model provider if advantage | One provider initial, benchmark before second; B5/B15 | single provider via gateway; model pins in `pricing.ts`; 50-case benchmark not built | partial |
| 69 | "Recommend," question missing | Architecture, reliability and governance recommendations labelled proposals | docs label defaults as proposals (retention, pricing, weights) | doc |
| 70 | Price all three, cheapest, Plus-only dream | Three cost cases, licensing, workload and exclusions; B15 | [costs.md](costs.md) (SaaS model using spec rates and workloads) | doc |
| 71 | Foundation in 30-45 days | Prioritised roadmap and gates; B16 | module build order follows spec launch order; acceptance gates in [deploy.md go-live checklist](deploy.md#12-go-live-checklist) | doc |
| 72 | Personal ownership, +1-2 colleagues; 90-day productive work and one deal | IP/data split, roles, measured outcomes, six-month caveat; B4/B12/B16 | roles + `record_share` + classifications for colleagues; IP position = [launch-dependencies.md](launch-dependencies.md) T11; outcome metrics in insights (partial) | partial |

## Summary at snapshot

| Status | Count |
|---|---:|
| built | 0 |
| partial | 66 |
| planned | 1 (Q40 infrastructure registry/map) |
| doc | 5 (Q42, 67, 69, 70, 71) |

Q66 counts as partial: the docs are done, the screens aren't. Biggest gaps to close before pilot, in the spec's launch order: capture extraction +
`/capture` and `/approvals` pages; `/today` page; `/drafts` page; requirements/shortlist/finance pages and the
document generator; `/api/v1/*` routes; then Teams, PDF/OCR intake, writing-style samples, infrastructure registry.
