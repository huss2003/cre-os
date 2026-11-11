# search — advanced NL + structured search (spec §2.9, §14.4)

## What's built
- **Account finder** (`finder.ts`, `filter.ts`): typed zod filter → `mudar_app.find_accounts(ws, filter jsonb, today, limit)`
  (SECURITY INVOKER, RLS + explicit workspace filter). The filter is bound as a jsonb parameter; no SQL is built from text (S7).
  Filters: occupied area range + basis (sum of current in-place leases on that basis), places (geography + descendants,
  via lease building micro-market/locality or `org_location`), building grade, lease event type + window (expiry /
  lock-in end / notice / break; contractual expiry stands in when no expiry event was computed), sector, known contact,
  signal kind + since, lead score band (`score_result` model `lead`, current), requirement status, open opportunity.
  Each hit carries the leases, events, contacts (with basis), signals, requirements and deals that made it match.
  **Coverage**: `areaUnknown` / `eventsUnknown` = companies passing every other filter whose lease area (on the requested
  basis) or lease dates are unknown — never treated as zero (S6). Unresolved place names are reported.
- **Known contact rule**: a person with a *current* employment at the company AND (≥1 non-archived interaction linked to
  the person OR a live `relationship_edge` to them OR a `relationship_context` row).
- **NL parser** (`parse.ts`): deterministic first (numbers + SF/sq ft/k/lakh, ranges, over/under, basis, workspace
  geography names/aliases, grade, 'next year', 'within 6 months', 'this year', lease event words, 'contact I know',
  sectors, signals, priority, requirement, deals). `nlToFilter` then optionally calls `callStructured`
  (`search.nl_filter`, mock returns `{}`) which may only FILL fields the parser left empty; model places are kept only if
  they exist in the geography table.
- **Expanded global search** (`everything.ts`): `mudar_app.search_everything(ws, q, types, from, to, statuses, geography,
  source, limit)` = original 5 types (via `search_entities`) + lease, space (floor/unit), meeting, task, signal,
  document (document_version), legal_document, quote, conversation (assistant_conversation). Filters by type, place,
  date (each type's key date), status, source. `everythingHref` links each hit to its record.

## Exported services
`findAccounts(db, ws, filter, {today, limit})`, `nlToFilter(db, ws, text, {today, useModel})`, `loadPlaces`,
`resolvePlaceIds`, `parseAccountQuery(text, places, today)`, `accountFilterSchema`, `resolveWindow`, `filterChips`,
`dropChip`, `encodeFilter`/`decodeFilter`, `filterFromForm`, `searchEverything(db, ws, params)`,
`parseEverythingQuery`, `everythingHref`, `EVERYTHING_TYPES`.

## Routes
- `/search` — tabs "Search everything" and "Find accounts" (`?mode=accounts&nl=…` or `&f=<base64url filter>`), chips
  (tap to remove), Edit filters form, result cards, coverage panel, "Save as command" → `/assistant/commands?new=1&prompt=…`.
- `GET /api/v1/search` — unchanged 5-type contract; `?mode=everything` for the expanded search.
- `GET /api/v1/search/accounts?nl=…|f=…[&ai=0]`.

## Assistant
`src/modules/assistant/tools/search2.ts` exports `search2Tools` (`find_accounts`, category A; text and/or typed filter).
Register in `src/modules/assistant/tools/index.ts` (not done here — lead owns the registry).

## Migration / tests
`supabase/migrations/20261111001400_search.sql` (re-runnable). `npx vitest run src/modules/search`.

## Known gaps
- Area = sum of current leases in scope; no de-duplication of overlapping/amended leases (`amends_lease_id`).
- Lease `status` values other than expired/terminated/surrendered count as current; leases with unknown expiry count as current.
- Grade filter has no "unknown grade" coverage count.
- Location filter in global search excludes types without a location (meetings, tasks, signals, documents, chats).
- Global search has no `as_of` (the admin 5-type search still does via the API's default mode).
- Model schema for `callStructured` uses optional fields; a real OpenAI strict-schema run may need nullable variants.
- No semantic/vector search over document text here (§14.4) — `search_documents` assistant tool covers that.
