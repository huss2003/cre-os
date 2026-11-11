# Module 13 — gap analysis (memory slice: §3, §4, §5.1/5.3, §7.1/7.2, §10, §14 A–E)

Rule followed: reuse Module 1 records and existing services; **no new tables** for this slice. Memory items are derived on
read (RLS via `ctx.db`). See `CONTRACT.md` for the API.

| Spec bullet | Already existed | Gap → what was built (`src/modules/intelligence/memory/…`) |
|---|---|---|
| §3.1 identity, current/previous company & designation | `person`, `employment` (start/end, is_current, fact_status) | `entity/person.ts`: current vs previous employment as MemoryItems, verified/reported/inferred from `fact_status` |
| §3.1 seniority, department, decision authority | `employment.seniority/function`, `stakeholder.role`, `contact_role_assessment` | merged into `decisionRoles` (current vs historical by employer) |
| §3.1 preferences, communication preferences | `assistant_memory` (stated/inferred, supersede), `person.preferred_channel` | surfaced as preferences; stated ≠ inferred kept |
| §3.1 interaction history, commitments, objections, last/next interaction | `interaction(+link)` with `promises`/`objections` JSON, `meeting_visit`; accounts `loadContactExtras` (UI-shaped) | `data.ts` commitment/objection extraction (pending/overdue), next meeting |
| §3.1 "don't transfer A's opportunities to B" | — | `opportunities` (current employer only) vs `formerEmployerOpportunities` (stay with company) |
| §3.2 company identity, subsidiaries/BUs | `organisation`, `organisation_relation` | `relatedOrgs` with current/past |
| §3.2 locations, occupancy, rent history | `lease` (tenant_org_id), `market_transaction` | `locations`, `rentHistory` items (current/historical by expiry) |
| §3.2 historical/current requirements, opps, decision-makers, contacts | accounts `loadAccount` (UI), deals | `entity/company.ts` split current/historical; DM from stakeholder roles (approver/sponsor) |
| §3.2 unresolved questions | deals `missingQuestions`, tasks | mandatory missing questions + open tasks |
| §3.3 alternate names, developer/landlord/PM | `entity_alias`, `asset.*_org_id` | `entity/property.ts` |
| §3.3 historical quotations, rent/CAM changes | `quote`, `availability` (append-only) | quotes always `historical`/`superseded` ("not current pricing"); snapshot diffs → `valueChanges` |
| §3.3 client interest, rejections + reasons | `shortlist_option`, `meeting_property_feedback` (explicit_rejection) | explicit "client said no" vs "did not fit" (disqualifiers) |
| §4.1 relationship history | interactions, `contact_relationship_level` | `relationship/service.ts` `relationshipHistory` |
| §4.2 strength with evidence; frequency ≠ strength | scoring `relationshipFeatures` (org-level, frequency-led), accounts `suggestLevel` | `relationship/strength.ts` pure, per-person, frequency capped 10/100, trust-less contact capped "weak", factor notes + caveats |
| §4.3 / §14E timeline | account timeline (org only) | `context/timeline.ts` + page `/intelligence/timeline` (filters: company, contact, building, requirement, deal, dates, type) |
| §5.1 requirement history | `requirement_version` immutable snapshots, deals service | `requirement/service.ts` + `confidence.ts` diff (area/seats/budget/location/timeline/purpose), previous value kept + `previousObsolete` |
| §5.3 confidence classes | deals `field_status` (client_confirmed/reported/estimated/unknown) | mapping → confirmed/indicative/estimated/inferred/outdated/conflicting/unknown (conflict from `capture_observation.conflict_with`; outdated = closed or >180 d unchanged) |
| §7.1 retrieval on open | per-page loaders (admin/accounts/deals) | `getCompanyContext/getPersonContext/getPropertyContext/getRequirementContext` |
| §7.2 meeting preparation | meetings module brief (`meeting_prep`, AI brief) | `context/meeting.ts` deterministic context incl. suggested points; for Module 7 to consume |
| §10 contacts ≠ companies ≠ opps | data model | enforced in person/company contexts; tested (§17 #6) |
| §12 MemoryItem shape | `assistant_memory` partially | `types.ts` `MemoryItem` (entity, category, value, source, observed, verified, verification, confidence, version, related, status) |
| §14 A–D panels | page sections exist (admin/accounts) | `ui/panels.tsx` collapsible panels on company, person, building, requirement and deal pages |
| AI summaries, changes, recommendations in panels | gateway, changes/recommend services | `ui/panels.tsx` `Extras`: "AI summary" (hidden on error/no facts), Important changes, Recommendations (Done/Dismiss via `ui/actions.ts`); meeting memory `ui/meeting.tsx`; pages `/intelligence`, `/intelligence/recommendations`, `/intelligence/changes` |

Not in this slice (other agent): §6 change detection, §8 consolidation, §9 recommendations, §12 quality scans, §11 integrations.
Known gaps: no per-business-unit requirement link beyond `organisation_relation`; "voluntary information" approximated as
inbound meaningful interactions; introductions read from `relationship_edge` only.
