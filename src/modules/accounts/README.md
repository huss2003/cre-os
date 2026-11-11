# accounts — account & contact workspaces

Spec §2.1–2.3, 2.5, 2.7, 2.10 (visible result: complete account view), §4.7 (separate scores), §5 (stakeholder map).

## What's built
- **Company workspace** `/companies/[id]?tab=…` — tabs with counts: Overview (identity, industry, website, CRM ref, Locations, group structure/brands, previous transactions + broker, evidence trail), Occupancy (current + historical leases: building/floor/unit, leased/carpet/chargeable area with basis, seats, start/expiry/tenure/lock-in/notice/break, source + fact status), People (stakeholder map by function and influence, relationship level, best verified channel, warm intro paths, past people), Requirements (each separate with readiness score + missing info), Signals (evidence, counter-evidence, verification), Scores (lead priority, requirement readiness, deal health, relationship strength, company attractiveness — each with why / missing / completeness / delta vs previous), Timeline (interactions incl. promises & objections, outreach), Meetings, Deals, Documents, Next actions (deterministic).
- **What changed since you last looked** strip: per user per company baseline in `account_view`; diffs signals, current scores, interactions, requirements, leases created/updated after it.
- **Contact workspace** `/people/[id]` — existing sections + relationship level (manual setter with history, derived suggestion), decision role, meetings, outreach, commitments, related companies (current + past employers) and opportunities, assistant-memory link, contact-method type chips (switchboard / business mobile…). `/contacts/[id]` stays as the enrichment & verification view and links to the workspace.
- Every section is time-boxed (4 s) and shows a visible "Couldn't load …" on failure.

## Exported services (`service.ts`)
`loadAccount(db, ws, userId, orgId)`, `loadContactExtras(db, ws, personId)`, `setLevel(db, ws, userId, personId, level, reason, accepted?)`, `currentLevels(db, ws, personIds)`, `levelHistory`, `lastViewed`, `markViewed`. Pure rules in `rules.ts` (`suggestLevel`, `groupStakeholders`, `diffSince`, `nextActions`, `scoreDelta`, `bestChannel`, `timeboxed`).

## Data
Migration `supabase/migrations/20261111001100_accounts.sql` (re-runnable):
- `account_view(org_id, user_id, viewed_at)` unique per workspace/org/user.
- `contact_relationship_level(person_id, level, reason, basis manual|accepted_suggestion, set_by_user_id, set_at)` — append-only; latest row is current. Levels: not_interacted, spoke_on_call, met_once, met_few, good, not_interested (same keys as `outreach/rules.ts` Level).

## Rules
- Suggestions never set "Good relationship" and are never written automatically; the user clicks "Use suggestion" or picks a level.
- Unknown values render as "unknown", never 0.

## Known gaps
- Viewers cannot insert `account_view` (business-table RLS requires editor), so viewers get no "since last looked" baseline.
- `outreach/rules.relationshipLevel` still derives `good` automatically for drafts; it should read `contact_relationship_level` instead (outreach module's call).
- Occupancy "occupancy type" and "renewal conditions" are not modelled on `lease`; break options rely on a `break_option` lease_event type.
- No job types; no `/api/v1` routes (pages use server actions).
