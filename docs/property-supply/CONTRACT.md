# Property Supply — service contract (Module 14)

Import from `@/modules/deals/supply` (barrel `src/modules/deals/supply/index.ts`). All DB functions take a
`DealsCtx` (`{ db, workspaceId, userId }`, user-scoped client — RLS enforced; never the service role). Pure functions
take plain rows and are deterministic (no LLM, no clock — pass `asOf` as `YYYY-MM-DD`).

## Statuses
`SupplyStatus = "immediately_available" | "future_available" | "under_negotiation" | "tentatively_held" | "under_offer"
| "occupied" | "unconfirmed" | "withdrawn" | "leased"` — stored on `availability.supply_status` (nullable; when null it
is derived from the legacy coarse `availability.status`).

## Pure
| Function | Purpose |
|---|---|
| `availabilityStatus(av, { asOf, assetStatus?, assetCompletion?, leaseExpiry?, decayDays? })` | → `{ status, immediate, offerable, confidence: "high"/"medium"/"low"/"none", stale, lastVerifiedOn, reasons[] }`. A lease expiry alone never yields an available status (→ `unconfirmed`, `leaseExpiryOnly: true`). Future/under-construction supply is never `immediate`. |
| `commercialTerms(av, quote?, { asOf })` | Normalised terms; each term `{ value, status: "known"/"missing"/"historical", source }`. Missing CAM stays `missing` (never 0). Pricing from a `historical_observed`/stale snapshot is `historical`, not current. |
| `combineSpaces(spaces)` | Combines spaces only when they share asset + `contiguous_group`; returns `{ groups, refused[] }`. |
| `explainOption(result, candidate, req)` | Per-property explanation: why, satisfies, fails, advantages, disadvantages, missing, availabilityConfidence, verificationRequired. |
| `reconfirmationChecks(candidate, { asOf, pricingMaxAgeDays?, decayDays? })` | → `{ code, text }[]` for stale availability, outdated pricing, expired/superseded quote, missing technical details. |

## DB
| Function | Purpose |
|---|---|
| `matchRequirement(ctx, requirementId, { asOf?, propertyTypes? })` | Hard filters (incl. supply status + property category) before preference scoring; returns ranked `SupplyMatch[]` = match-v1 `OptionResult` + `explanation` + `supplyStatus`. Ineligible options are returned with their failures (never hidden). Read-only (use `runShortlist` from `deals/matching/service` to persist). |
| `findAlternatives(ctx, criteria)` | `criteria = { requirementId }` or lease-style `{ areaMinSf?, areaMaxSf?, areaBasis?, budgetMax?, budgetBasis?, localityIds?, occupationDate?, propertyTypes?, excludeSpaceIds?, excludeAssetIds? }`. Same engine; for Module 15/16 (renewal benchmark / deal-fallback alternatives). |
| `availabilityStatusForSpace(ctx, spaceId, asOf?)` | Latest snapshot → `availabilityStatus` (+ lease expiry hint via `lease_space` when present). |
| `operatorCentres(ctx, { operatorOrgId?, localityId?, minSeats? })` | Managed office / coworking centres with seats, private offices, pricing, services, amenities, contract terms, extra charges, brokerage, source, last verification. |
| `upsertOperatorCentre(ctx, input)` | Create/update a centre (optimistic concurrency via `row_version`). |
| `reconfirmationDue(ctx, requirementId, { asOf? })` | For shortlisted/visited/proposed options of the latest shortlist: items needing reconfirmation. |
| `assertReadyToPresent(ctx, requirementId, { asOf?, purpose: "presentation"/"site_visit" })` | Throws `DealsError(422)` listing items when anything needs reconfirmation. |
| `recordShortlistFeedback(ctx, { optionId, kind: "client_feedback"/"rejection", reasonCode?, comment? })` | Feedback / rejection reasons (rejection also sets option status). |
| `shortlistHistory(ctx, requirementId)` | Versions + per-option status + feedback. |

Job types: none. Events emitted: none (callers own workflow events).
