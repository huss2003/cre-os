# deals/supply — Module 14 Property Supply and Matching

Contract: `docs/property-supply/CONTRACT.md`. Gap analysis: `docs/property-supply/GAP.md`.

- `supply.ts` (pure): 9-status model `availabilityStatus`, `commercialTerms` (known/missing/historical; missing CAM ≠ 0),
  `combineSpaces`/`canDivide` (contiguous/divisible), `explainOption`, `reconfirmationChecks`.
- `service.ts` (DB, RLS ctx): `matchRequirement`, `findAlternatives`, `matchCandidates` (pure core), `availabilityStatusForSpace`,
  `operatorCentres`, `upsertOperatorCentre`, `recordShortlistFeedback`, `shortlistHistory`, `reconfirmationDue`, `assertReadyToPresent`.
- `actions.ts`: server actions for `/buildings/supply`.
- Tables: `operator_centre`, `shortlist_feedback`; columns on `asset` (category, property_manager_org_id), `space` (divisible,
  min_divisible_sf), `availability` (supply_status, last_verified_on, source_label, terms…). Migration `20261112000400_property_supply.sql`.
- Job types: none. Env vars: none. Settings read: `deals.availability_decay_days` (default 30).
- Tests: `supply.test.ts` (pure), `supply.db.test.ts` (WS1, tagged, fixtures archived afterwards).
