# Module 13 Intelligence Layer — memory contract (entity / relationship / requirement / context)

Owner: memory agent (`src/modules/intelligence/memory/{entity,relationship,requirement,context,ui}/**`).
Consumers: changes / consolidate / recommend / quality / integrate agents, meetings (Module 7), assistant (Module 12).

Import from `@/modules/intelligence/memory` (server-only barrel `index.ts`). Pure types/functions from
`@/modules/intelligence/memory/types` and `@/modules/intelligence/memory/relationship/strength` (no `server-only`, safe in tests).

**No new tables.** Every memory item is *derived on read* from Module 1 records through RLS (`ctx.db`):
employment, interaction(+link), meeting_visit, requirement + `requirement_version` (immutable snapshots),
shortlist_option, `meeting_property_feedback` (explicit rejections), quote, availability, asset, space, opportunity
(+stage_history), stakeholder, organisation_relation, relationship_edge, contact_relationship_level, assistant_memory,
capture_observation, signal, market_transaction, lease, task. The Database stays the source of truth (§16.1); nothing
here writes canonical fields. If consolidation needs persisted consolidated items, that table belongs to the consolidate agent.

## Context object
```ts
type MemCtx = { db: SupabaseClient /* ctx.db, RLS */; workspaceId: string; userId: string };
```
Every query filters `workspace_id` explicitly as well as relying on RLS (S2). Never pass an admin client from a user path.

## Types (`types.ts`)
```ts
type EntityType = "organisation" | "person" | "asset" | "requirement" | "opportunity" | "meeting";
interface EntityRef { type: EntityType | string; id: string; label?: string }
interface SourceRef { type: string; id: string; label: string; href: string | null }   // e.g. {type:"interaction", id, href:"/people/<pid>#i-<id>"}

type MemoryStatus = "current" | "historical" | "superseded" | "unverified" | "conflicting";
type Verification = "verified" | "reported" | "estimated" | "inferred" | "unverified" | "unknown";
type RequirementConfidence = "confirmed" | "indicative" | "estimated" | "inferred" | "outdated" | "conflicting" | "unknown";

interface MemoryItem {
  entityId: string; entityType: EntityType | string;
  category: string;              // e.g. "employment", "designation", "requirement.area", "quote", "availability", "commitment", "objection", "preference"
  label: string;                 // plain-words label
  value: unknown;                // raw value (null = unknown — never coerced)
  display: string;               // human text; "Unknown" when value is null
  sourceRef: SourceRef | null;   // null => flagged "no source" by quality
  observedAt: string | null;     // ISO
  lastVerifiedAt: string | null;
  verification: Verification;
  confidence: number | null;     // 0..1, null = not assessed (never artificial certainty)
  version: number | null;        // requirement_version.version, quote.version, etc.
  related: EntityRef[];
  status: MemoryStatus;
}

type TimelineEventType = "interaction" | "meeting" | "employment" | "requirement_version" | "opportunity_stage"
  | "quote" | "availability" | "commitment" | "objection" | "rejection" | "signal" | "relationship_level" | "transaction";
interface TimelineEvent { id: string; at: string; type: TimelineEventType; title: string; detail: string | null;
  refs: EntityRef[]; sourceRef: SourceRef | null; verification: Verification }
interface TimelineFilters { orgId?; personId?; assetId?; requirementId?; opportunityId?; from?: string; to?: string;
  types?: TimelineEventType[]; limit?: number }
```

## Functions (`index.ts`)
| Function | Returns |
|---|---|
| `getPersonContext(ctx, personId)` | `PersonContext` — identity, `currentEmployment[]`, `previousEmployment[]` (each a MemoryItem, verification from `fact_status`), designations, seniority, decision role (stakeholder/contact_role_assessment), responsibilities, preferences (assistant_memory, stated vs inferred), interactions, commitments (from `interaction.promises`), objections, last/next interaction, relationship (`RelationshipAssessment`), opportunities **of current employer only** (via stakeholder→requirement whose org is current), memories, `unknowns: string[]` |
| `getCompanyContext(ctx, orgId)` | `CompanyContext` — overview, related orgs (subsidiary/business-unit via organisation_relation), locations (leases→assets), occupancy, current vs historical requirements, people (current/former), decision-makers, rent history (leases/transactions), opportunities (active/previous — stay with company even if contact left), interactions, commitments, objections, developments (signals), unresolved questions (requirement missing questions + open tasks), recent changes |
| `getPropertyContext(ctx, assetId)` | `PropertyContext` — identity, alternate names (`entity_alias`), location, developer/landlord/PM orgs, inventory (latest availability per space), **historical quotations (status always `historical`, never "current pricing")**, rent/CAM changes (availability snapshot diffs), client interest (shortlist_options + feedback), rejections + reasons (explicit only), specs |
| `getRequirementContext(ctx, requirementId)` | `RequirementContext` — `current: MemoryItem[]` per field with `RequirementConfidence`, `history` (requirement_version snapshots), `changes: RequirementChange[]` (field, from, to, at, version, source, obsolete=true), options, rejections+reasons, decision-makers, outstanding questions |
| `getMeetingContext(ctx, meetingId)` | `MeetingContext` (§7.2) — attendees w/ current designation, previous interactions, last discussion, pending commitments, requirements, objections, commercial discussions (quotes), pending questions, developments, suggested discussion points (deterministic) + optional AI summary |
| `getTimeline(ctx, filters)` | `TimelineEvent[]` newest first |
| `relationshipStrength(evidence)` (pure) | `RelationshipAssessment { level: "unknown"|"none"|"weak"|"developing"|"good"|"strong"; score: number|null; factors: {key,label,points,max,note}[]; explanation: string[]; caveats: string[] }` — frequency is capped (max 10/100); trust signals (voluntary info, introductions, kept commitments, meetings, responsiveness) carry the weight |
| `gatherRelationshipEvidence(ctx, personId)` | `RelationshipEvidence` for the function above |
| `requirementConfidence(status, opts)` (pure) | maps field_status + staleness + conflicts → `RequirementConfidence` |
| `diffRequirementVersions(a, b)` (pure) | `RequirementChange[]` |
| `summariseContext(ctx, kind, ctxObj, ai?)` | `{ text, aiGenerated: true, model, mock }` — gateway with deterministic mock; evidence-only, labelled AI |

Rules honoured: unknown stays `null`/"Unknown"; inferred never shown as confirmed; employer-moves keep old employment
as `historical` and do NOT move opportunities; quotes always historical with date+source; permissions via RLS.
