# Intelligence Layer — memory (Module 13: entity, relationship, requirement, context, UI)

Spec: `docs/intelligence-layer/SPEC.md` §3, §4, §5.1/5.3, §7.1–7.2, §10, §14 A–E. API: `docs/intelligence-layer/CONTRACT.md`.
Gap analysis: `docs/intelligence-layer/GAP.md`.

## What's built
- `entity/person.ts` `getPersonContext` — employment history (current/past, verification), decision roles, preferences
  (assistant_memory), interactions, commitments, objections, last/next interaction, relationship assessment, opportunities
  split current-employer vs former-employer (never transferred).
- `entity/company.ts` `getCompanyContext` — related orgs, locations/occupancy, current vs historical requirements, people,
  decision-makers, deals (active/previous), interactions, commitments, objections, developments, unresolved questions.
- `entity/property.ts` `getPropertyContext` — alternate names, developer/landlord/PM, inventory, availability history,
  quotations (always historical), rent/CAM changes, client interest, rejections + reasons.
- `requirement/` `getRequirementContext`, `requirementConfidence`, `requirementEvolution` — versions, what changed, confidence classes.
- `relationship/` `relationshipStrength` (pure, explained), `gatherRelationshipEvidence`, `relationshipHistory`.
- `context/` `getMeetingContext` (§7.2 for Module 7), `getTimeline`, `summariseContext` (gateway, mock, labelled AI).
- `ui/panels.tsx` — Company / Contact / Property / Requirement panels (requirement panel also on deal pages);
  page `/intelligence/timeline` (nav: More → Market & reports → Timeline).

## Data
No new tables or migrations. Reads through RLS (`ctx.db`) with explicit `workspace_id` filters. Nothing writes canonical fields.

## Jobs / env
None. AI summaries use `OPENAI_API_KEY`/gateway; mock mode returns a deterministic facts summary.

## Tests
`memory.test.ts` (pure), `memory.db.test.ts` (§17 scenarios 1–6, 14–15, 17, 20–22).

## Known gaps
AI summary not yet shown in panels; meeting context not yet wired into the meetings page (Module 7 owns it — call
`getMeetingContext`); business-unit-level requirement linking limited to `organisation_relation`.
