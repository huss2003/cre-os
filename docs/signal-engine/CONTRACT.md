# Signal Engine (Module 2) — backend contract for the UI

Owner of backend: `src/modules/signals/*.ts` (not `ui/`). UI lives in `src/app/(app)/signals/**`, `src/modules/signals/ui/**`,
`src/modules/signals/actions.ts`. All functions take the caller's client (`ctx.db` from `requireContext()`, RLS enforced) and the
workspace id. Every write is persisted and audited (`make_business_table` audit trigger + `signal_review` history).
Nothing here sends email/WhatsApp/LinkedIn (S3). AI policy `signals.assess` stays code-only.

Import paths: `@/modules/signals/<file>`.

## 1. Lists, views, filters — `service.ts`

```ts
listSignals(db, ws, f: ListFilter): Promise<Row[]>          // rows = signal.* + org{display_name,sector} + person{full_name} + evidence[]
countsByView(db, ws) / counts(db, ws): Promise<Record<View | Category, number>>
filterOptions(db, ws): Promise<FilterOptions>                // dropdown values (service.ts; re-exported from card.ts)

type View = "all" | "high" | "expansion" | "restructuring" | "lease" | "commercial" | "leadership" | "infrastructure" | "unverified" | "closed"
const VIEWS: Record<View, string>                            // labels A–J (spec §10)

interface ListFilter {
  view?: View; q?: string;                                   // q searches title, summary, location, raw entity name, company name, evidence excerpt
  orgId?: string; industry?: string; microMarket?: string; category?: Category; subType?: string;
  eventFrom?: string; eventTo?: string;                      // event_date range (YYYY-MM-DD)
  from?: string; to?: string;                                // detection date range
  freshDays?: number;                                        // latest evidence within N days
  confidence?: "high"|"medium"|"low"|"insufficient";
  urgency?: "high"|"medium"|"low";                           // = priority_band
  status?: string; source?: string;                          // source name (matches signal.source_names)
  assigned?: "me" | "unassigned" | string;                   // string = user id
  userId?: string;                                           // required when assigned = "me"
  sort?: "priority" | "detected" | "event";
}
interface FilterOptions { companies: {id,name}[]; industries: string[]; microMarkets: string[]; sources: string[]; subTypes: {category, subType, label}[]; assignees: {id, name}[] }
```

New signal columns usable in the list: `sub_type`, `derived` (see §3), `labels`, `independent_evidence_count`,
`contradictory_count`, `last_confirmed_on`, `detected_at` (= first detected), `contextual_summary`, `entity_candidates`,
`entity_resolution`, `source_names`, `micro_market`, `priority_review_on`, `processing_status`.

## 2. Signal card — `card.ts`

```ts
getSignalCard(db, ws, id): Promise<SignalCard | null>

interface SignalCard {
  id; header: {
    company: string | null; companyId: string | null; person: string | null; signal: string /*title*/;
    category: Category; categoryLabel: string; subType: string | null; subTypeLabel: string | null;
    location: string | null; detected: string /*ISO*/; eventDate: string | null; eventDateBasis: string | null;
    evidenceSummary: string;  /* "Press release + 2 more (1 independent)" */ creRelevance: string | null;
    confidence: Confidence; confidenceReasons: string[]; verification: "fact"|"inference"|"hypothesis"|"unknown";
    status: string; statusLabel: "New"|"Reviewing"|"Approved"|"Dismissed"|"Snoozed"|"Rejected"|"Already known"|"Converted to action";
    processingStatus: string; priority: number; urgency: "high"|"medium"|"low"; priorityReasons: string[];
    priorityOverride: { band, reason, user_id, at, review_on } | null; overrideReviewDue: boolean;
    recommendedAction: string | null; actionKind: string | null; assignedUserId: string | null; snoozedUntil: string | null;
    ruleVersion: string;
  };
  sections: {                                              // spec §9 expandable details 1–12
    whatHappened: string; whyItMatters: string; contextualSummary: string | null;
    evidence: EvidenceItem[];                              // role support, newest first
    grouping: { firstDetected: string; mostRecentConfirmation: string | null; supportingSources: number; independentEvidenceCount: number; contradictoryCount: number };
    relatedCompany: { id, name, sector, relations: {id,name,relation}[] } | null;
    officeLocations: string[]; occupancy: { leaseId, asset, areaSf, expiry }[];
    leaseEvents: { type, typeLabel, date, basis, confirmed }[];
    contacts: { personId, name, title, creRole: boolean }[]; requirements: { id, title, status }[];
    opportunities: { id, name, stage, outcome }[];
    counterEvidence: { text: string; source: "rule" | "user" | "evidence" }[];
    missingInfo: string[]; nextSteps: { text: string; actionKind: string }[];
    labels: { facts: string[]; inferences: string[]; hypotheses: string[]; unknowns: string[] };
    derived: Derived;                                      // see §3
    entity: { resolved: boolean; method: string | null; candidates: { id, name, reasons: string[] }[]; rawName: string | null };
  };
  task: { id, title, status, due_at, completion_evidence } | null;
  history: { action, from_status, to_status, reason, data, actor_user_id, created_at }[];  // signal_review, newest first
  assessments: { rule_version, confidence, priority, priority_band, reasons, created_at }[];   // signal_assessment history
  sourceItems: { id, adapter, status, title, url, published_on, error }[];                     // pipeline provenance
  actions: SignalAction[];                                  // actions valid for current status
}
interface EvidenceItem { id; role: "support"|"counter"|"context"; sourceName; url; excerpt; publishedOn; tier; factStatus; label: "fact"|"inference"|"hypothesis"|"unknown"|null; independenceKey: string|null; sourceItemId: string|null; note }
```

## 3. Derived fields (`rules.ts`)
`signal.derived` = `{ ruleVersion, category, subType, companyRelevance, geographicRelevance, creRelevance, timingRelevance,
evidenceStrength, sourceReliability, freshness, commercialImpact /* each {level:"high"|"medium"|"low"|"unknown", reason} */,
missingInfo: string[], nextAction: {text, actionKind}, hiring?: {location, remote, roleType, occupancyImplication, existingCapacity},
fundingOnly?: boolean }`. Rule set is versioned in `signal_rule_version` (`activeRules(db, ws)`), default `signals-2`.

## 4. Actions — `service.ts`

```ts
actOnSignal(db, ws, userId, id, action: SignalAction, data?: Record<string, string|undefined>)
type SignalAction =
  | "approve"            // creates task (idempotent), status converted
  | "reject"             // data.reason required
  | "dismiss"            // data.reason required
  | "snooze"             // data.until YYYY-MM-DD > today
  | "investigate"        // status reviewing
  | "known"              // mark as already known
  | "assign_me"
  | "create_task"        // data.title optional
  | "link_opportunity"   // data.opportunity_id
  | "propose_opportunity"// data.name optional -> change_proposal (Review)
  | "add_evidence"       // data.text, data.source, data.url, data.published_on
  | "add_counter"        // data.text
  | "correct_company"    // data.org_id (also used to pick an entity candidate)
  | "override_priority"  // data.band high|medium|low, data.reason required, data.review_on optional YYYY-MM-DD
  | "clear_override"     // data.reason optional
  | "record_outcome"     // data.outcome required; completes the linked task (completion_evidence) and keeps history
  | "reevaluate"         // re-runs assessment against current evidence + Module 1 context
  | "reopen"
```
Errors are thrown as `SignalError` (message is user-safe).

## 5. Sources, pipeline, refresh

```ts
// sources.ts
listSourceRegistry(db, ws): Promise<RegistryView[]>        // ensures built-in adapters are registered first
interface RegistryView { id; name; type; adapter; accessMethod; permissionStatus: "permitted"|"pending"|"denied"|"unavailable";
  permittedPurposes: string[]; retentionDays: number|null; refreshDays: number|null; lastRetrieval: string|null;
  connectionStatus: "connected"|"paused"|"unavailable"|"error"|"needs_access"; lastError: string|null; usageCount: number; paused: boolean }
setSourcePaused(db, ws, registryId, paused: boolean)
reconnectSource(db, ws, registryId)                          // stays "needs_access" for adapters without an access path (RSS)
ADAPTERS: SourceAdapter[]                                    // manual_paste, database, user_upload, rss (unavailable)

// pipeline.ts
processSourceItem(db, ws, input: SourceItemInput): Promise<{ itemId; status; signalIds: string[]; created: number; duplicateOf?: string; error?: string }>
interface SourceItemInput { adapter: "manual_paste"|"user_upload"|"database"; text: string; title?; url?; sourceName?; publishedOn?;
  companyName?; orgId?; captureId?; idempotencyKey?; actorUserId?; registryId? }
retrySourceItem(db, ws, itemId)
listSourceItems(db, ws, { status?, limit? })                 // pipeline monitor; statuses per spec §5
processCapture(db, ws, captureId, { companyName?, orgId?, actorUserId? })  // user-uploaded document adapter
// ingestText(db, ws, {text, companyName, orgId, sourceName, sourceUrl, publishedOn, actorUserId}) in service.ts = manual_paste via the pipeline;
// returns { signals: {id, created}[], detected, resolution, itemId, status }. Throws SignalError('Source not permitted: …') when the source is paused/unavailable.
PIPELINE_STATUSES / STATUS_LABEL

// refresh.ts
refreshNow(db, ws, { orgId?, actorUserId? })               // manual refresh (company or workspace)
refreshStatus(db, ws): { syncRuns, failedItems, failedJobs, universe: { cap, size }, due, tiers }  // failed-job visibility (failedJobs only for admins)
refreshCompany(db, ws, orgId, { trigger?, dedupeKey?, actorUserId? })  // -> { runId, created } | { skipped }
dueCompanies(db, ws) / TIER_LABEL / TIER_CADENCE_DAYS / DEFAULT_UNIVERSE_CAP
setUniverseCap(db, ws, cap)                                 // admin; default 1,200
```

## 6. Leadership — `leadership.ts`
```ts
recordLeadershipChange(db, ws, userId, { personName, email?, toOrgName?, toOrgId?, title?, fromOrgId?, text, sourceName?, sourceUrl?, publishedOn? })
// -> { signalId, personId|null, candidates, proposalId|null, taskIds[] }
```

## 7. Rules — `rules.ts`
```ts
activeRules(db, ws) / publishRules(db, ws, userId, version, partialRules, notes?)   // admin only (RLS); old versions kept
DEFAULT_RULES, RULES_VERSION = "signals-2"
```
## 8. Taxonomy — `taxonomy.ts`
`SUB_TYPES` (sub-type → {category, label, outcomes?}), `subTypeLabel(s)`. Lease sub-types: lease_expiry, lease_expiry_past,
lockin_end, notice_deadline, break_option, renewal, handover, escalation, managed_office_expiry (never interchangeable).
