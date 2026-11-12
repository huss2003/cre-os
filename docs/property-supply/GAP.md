# Module 14 — Property Supply and Matching: gap analysis

Spec: docs/integration/MASTER-SPEC.md §Module 14. "Before" = state on 2026-11-12 prior to this work; "After" = now.
Code: `src/modules/deals/supply/**` (new), `src/modules/deals/matching/{match,service}.ts` (extended),
page `/buildings/supply`, migration `supabase/migrations/20261112000400_property_supply.sql`.

| Item | Before | After | Where |
|---|---|---|---|
| **A. Hierarchy** campus / building / tower | DONE (`asset.asset_kind`, `parent_asset_id`) | DONE | core |
| floor / unit | DONE (`space.floor_text`, `unit`) | DONE | core |
| divisible space | MISSING | DONE — `space.divisible` (null = unknown), `min_divisible_sf`; `canDivide()` keeps unknown unknown | migration, supply.ts |
| contiguous space | PARTIAL (`contiguous_group` column, unused) | DONE — `combineSpaces()` combines only same building + same group; refusals listed | supply.ts |
| **B. Categories** conventional / managed / coworking / campus / business park / configurable | MISSING | DONE — `asset.category` (configurable slug, defaults `DEFAULT_CATEGORIES`); category hard filter in matching; operator centres typed managed_office/coworking | migration, service.ts |
| **C. Supply info** property, developer, landlord, location, micro-market, area, floor, unit, availability date, furnishing (fit-out), tech specs | DONE | DONE | core |
| property manager | MISSING | DONE — `asset.property_manager_org_id` | migration |
| area type, possession conditions, furnishing detail | MISSING | DONE — `availability.area_type`, `possession_conditions`, `furnishing` | migration |
| source | PARTIAL (`source_object_id` only) | DONE — + `source_label`, shown on inventory | migration, page |
| last verification date | PARTIAL (`as_of` only) | DONE — `availability.last_verified_on`; drives staleness/confidence | migration, supply.ts |
| **D. Terms** rent, CAM, deposit, escalation, rent-free | PARTIAL (columns from journey fixes; CAM from quote only in matching) | DONE — matching uses snapshot CAM; `commercialTerms()` per-term known/missing/historical | match.ts, supply.ts |
| lock-in, lease duration, parking, fit-out cost, brokerage, other charges | MISSING | DONE — new availability columns + `commercialTerms()` | migration, supply.ts |
| **E. Statuses** (9) | PARTIAL (5 coarse: available/under_offer/leased/unverified/withdrawn) | DONE — `availability.supply_status` (9 values); refines, never loosens, the coarse status in match-v1 | migration, match.ts, supply.ts |
| **F. Operator intelligence** centre, capacity, seats, private offices, pricing, services, amenities, contract terms, extra charges, brokerage | MISSING | DONE — `operator_centre` table (RLS via make_business_table), `operatorCentres`/`upsertOperatorCentre`, Operators tab | migration, service.ts, page |
| **G. Matching** area, budget, location, timeline, technical, parking, furnishing | DONE (match-v1) | DONE | matching/match.ts |
| property type | MISSING | DONE — `propertyTypes` / `constraints.values.property_types` hard filter (unknown category → verification) | service.ts |
| hard filters before preference scoring | DONE (tiered ranking) | DONE — supply-status + category filters merged then re-tiered | service.ts |
| **H. Explanation** why / satisfies / fails / advantages / disadvantages / missing / availability confidence / verification | PARTIAL (qualifies, disqualifiers, verification) | DONE — `explainOption()` on every `SupplyMatch`; Match tab | supply.ts, page |
| **I. Shortlists** shortlists + history | DONE (`shortlist_version`, `shortlist_option`) | DONE — `shortlistHistory()` | service.ts |
| commercial comparison | DONE (toolkit comparison / comparison_xlsx) | DONE | toolkit |
| client feedback, rejection reasons | PARTIAL (visit feedback only; no per-option reasons) | DONE — `shortlist_feedback` table; `recordShortlistFeedback()` (rejection requires reason, sets status) | migration, service.ts |
| **J. Reconfirmation** stale availability, outdated pricing, expired quotes, missing technical | PARTIAL (stale + expired quote flags only) | DONE — `reconfirmationChecks()`, `reconfirmationDue()` | supply.ts, service.ts |
| reconfirm before presentation / site visit | MISSING | DONE — `assertReadyToPresent()` (422 with list) + page button | service.ts, page |
| **Rule** lease expiry ≠ vacancy | PARTIAL (implicit) | DONE — lease-only → `unconfirmed`, `leaseExpiryOnly`, confidence none | supply.ts |
| **Rule** historical pricing ≠ current | MISSING | DONE — historical/aged pricing marked `historical`; match-v1 adds `pricing_historical` verification | supply.ts, match.ts |
| **Rule** future supply ≠ immediate | PARTIAL (readiness date) | DONE — `future_available`, `immediate=false` for future dates / under-construction | supply.ts |
| **Rule** no incorrect combination of non-contiguous inventory | MISSING | DONE — `combineSpaces()` | supply.ts |
| **Rule** missing CAM ≠ 0 | DONE (quote path) | DONE — snapshot path too; `commercialTerms` marks missing | match.ts, supply.ts |
| **Rule** preserve historical quotations | DONE (quote versions, `superseded_by`) | DONE — expired/superseded quotes reported, not used as current | supply.ts |
| **Rule** never hide hard-filter failures behind a high score | DONE (tiering) | DONE — failures returned with reasons, ranked last | service.ts |
| **Visible result** supply engine page | MISSING | DONE — `/buildings/supply` (Inventory / Operators / Match), 375px-friendly, empty states | page |

Known gaps: `combineSpaces` is not yet used to create combined match candidates (spaces are matched individually);
category list is not yet editable in settings (slug values accepted, defaults in code); no API routes (`/api/v1/...`) —
pages use server actions and other modules call the service functions.
