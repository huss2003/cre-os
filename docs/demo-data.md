# Demo data (synthetic) — `demo-pune` workspace

**Opt-in only.** CRE OS starts empty. The real tenant workspace (WS1, `10000000-0000-4000-8000-000000000001`) stays
empty until the owner imports their real files. For sales demos and UI testing there is a **separate** workspace
filled with clearly synthetic data:

| | |
|---|---|
| Workspace | **Demo — Pune CRE (synthetic)** |
| Slug | `demo-pune` |
| Id | `de000000-0000-4000-8000-000000000001` (hard-coded; the scripts never touch any other workspace) |
| Member | `owner@cre-os.local` (`00000000-0000-4000-8000-000000000001`), role `owner`, all four classifications, sees all accounts |
| Marker | `workspace_setting` key `demo_workspace` = `{ synthetic: true, seed_version, anchor_date }` |

> **Never run this against a real tenant or a production database.** The seeder only ever writes rows with
> `workspace_id = de000000-…0001` (asserted in code before any write), refuses to run against a non-local Supabase
> URL unless `--allow-remote` is passed, and aborts if the slug `demo-pune` belongs to another workspace. Do not
> point it at a production project to "show a client something" — use a local or dedicated demo stack.

## Running

Add these npm scripts (package.json is shared; ask the coordinator):

```json
"demo:seed":  "tsx --env-file=.env.local scripts/demo-seed.ts",
"demo:reset": "tsx --env-file=.env.local scripts/demo-reset.ts"
```

```bash
npm run demo:seed                         # create or top up; idempotent (existing rows are left untouched)
npm run demo:seed -- --refresh            # overwrite existing demo rows in place (re-anchors relative dates to today)
npm run demo:seed -- --today=2026-10-31   # pin the anchor date => byte-identical dataset
npm run demo:reset -- --yes               # delete the demo workspace and everything in it
```

Then sign in as `owner@cre-os.local` / `password123` and switch to *Demo — Pune CRE (synthetic)*.
The colleague user is **not** a member, so it sees nothing (useful for RLS demos).

Requirements: local stack running, `supabase/seed.sql` applied (the owner user must exist), `.env.local` with
`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SECRET_KEY` (seed) and `DATABASE_URL` (reset).

### Idempotency & determinism
- Every row id is a UUID v5 of (demo workspace, entity kind, fixture key) — `did()` in `scripts/demo-data/core.ts`.
- All variation comes from a seeded PRNG (mulberry32, one stream per generator), so the same anchor date always
  produces the same rows. Writes are `upsert … on conflict (id) do nothing` (or `do update` with `--refresh`), so
  re-running never duplicates. Verified: two consecutive runs → identical counts (1,523 business rows).
- Dates are relative to the anchor date (today in IST by default). Rows keep the dates from when they were first
  seeded; to move the demo "to today" run `demo:reset -- --yes && demo:seed`, or `demo:seed -- --refresh`
  (refresh increments `row_version` and writes audit rows for every updated row).

### Why reset uses `pg` instead of supabase-js
Business tables have an audit trigger that writes `audit_event(workspace_id)` on delete, so a plain cascading
`delete from workspace` fails. `demo-reset.ts` opens one transaction, deletes the demo workspace's rows table by
table (retrying FK-ordered tables), then deletes the workspace row (cascading its audit trail). It discovers all
tables with a `workspace_id` column at run time, so module tables created later are cleaned up too. Every statement
is filtered by the demo workspace id; it refuses to run without `--yes` or against a non-local DB without
`--allow-remote`.

## What it creates (core tables only)

| Table | Rows | Notes |
|---|---:|---|
| source_object | 1 | `kind=manual`, `meta.synthetic=true`; every evidence-bearing row points here |
| geography | 30 | Pune › 5 corridors › 6 micro-markets (SBD East, PBD West, SBD West, CBD, Magarpatta–Hadapsar, Pimpri-Chinchwad) › 18 localities (Kharadi, Viman Nagar, Yerwada, Kalyani Nagar, Hinjewadi Ph 1–3, Wakad, Baner, Balewadi, Aundh, Shivajinagar, Camp, Koregaon Park, Magarpatta, Hadapsar, Pimpri, Chinchwad), with aliases + approximate coordinates |
| organisation / organisation_relation | 40 / 8 | Invented names (e.g. *Pebblewick Software*, *Northwind Halberd GCC India*); IT, BFSI, GCC, pharma, engineering, developers, flex operators; `*.example.com` domains; CIN/GSTIN left null (unknown); parent/subsidiary/affiliate links |
| person | 80 | Fictional Indian names; `personal_notes` says SYNTHETIC; `public_profile_url` null |
| contact_method | 156 | `first.last@<org>.example.com`, `+91-90000-1xxxx` phones/WhatsApp; some people have no phone (unknown) |
| employment | 88 | 80 current + 8 closed previous jobs (job moves; 3 recent ones also appear as `job_move` signals) |
| relationship_edge | 54 | owner → 46 people (warmth mix; `intro_permission` explicitly true for 3 only) + 8 person↔person `worked_with` |
| consent_permission | 12 | 11 active + **1 suppressed** person (revoked; contact methods suppressed; inbound opt-out email logged) |
| asset | 60 | 14 campuses › 32 towers (2–3 per campus) + 14 standalone buildings; floor-size ranges, grades, LEED; 2 with `total_area_source_zero=true` (area null); a few towers under construction/planned |
| space / availability | 87 / 165 | Append-only snapshots; latest snapshot fresh / ageing / **stale (valid_until passed: 21 spaces)**; INR/sf/month chargeable or per seat for managed |
| lease / lease_event | 46 / 116 | Expiries: 6 past, 7 in 0–3 m, 10 in 3–12 m, 10 in 12–24 m, 12 beyond; lock-in ends, contractual notice deadlines, escalations; `EDATE(start, tenure)` convention; **1 fractional tenure (62.5 m) with expiry null + `needs_review`**; 1 renewal amending an expired lease; some unmatched tenants (raw name only) |
| market_transaction | 40 | 2022–2025, 10 per year, conventional/renewal/expansion/managed/coworking |
| market_observation | 192 | 6 micro-markets × 2018–2025 × {stock, supply, absorption: `msf`; rent: `INR/sf/month`}; `definition` documents each metric; `source_version=demo-synthetic-v1`; stock(y) = stock(y−1) + supply(y); COVID dip in 2020–21 |
| requirement / stakeholder | 6 / 17 | 3 `client_confirmed` (with confirming person) + 3 `estimated` |
| opportunity / stage_history | 14 / 66 | Every pipeline phase; 2 **lost** (`lost:went_direct_with_landlord`, `lost:budget_below_market`), 1 dormant, 2 won; some next actions overdue |
| quote | 8 | Versioned (v1 superseded by v2 ×2); **1 expired** and never superseded |
| fee_milestone | 5 | Collected, part-invoiced, pending, shared-credit |
| interaction / interaction_link | 59 / 118 | Emails/calls/meetings/WhatsApp in the last 60 days, linked to person + organisation |
| task | 25 | 6 overdue, 4 due today, upcoming, 2 snoozed, 5 done, 1 stale; one dependency |
| meeting_visit | 14 | Today & tomorrow in IST: calls/meetings plus site-visit loops clustered by locality (`route_group` kharadi-<date>, hinjewadi-<date>); past completed visits; one cancelled |
| signal_claim | 16 | hiring / expansion / funding / RTO / job_move / gcc_plan across all evidence tiers; 3 expired; one `ai_inference` claim contradicting another |

Plus: `workspace` (1), `membership` (1), `workspace_setting` (1). Module-owned tables are deliberately not seeded
(their schemas are still changing); modules can derive from these core rows.

## Code layout
- `scripts/demo-seed.ts` — preflight guards, workspace/membership upsert, batch upserts (500/chunk), count summary.
- `scripts/demo-reset.ts` — `--yes`-gated transactional delete of the demo workspace only.
- `scripts/demo-data/` — pure fixture generators (no DB access): `core.ts` (ids, PRNG, dates), `geography.ts`,
  `organisations.ts`, `people.ts`, `assets.ts`, `leases-market.ts`, `deals.ts`, `activity.ts`, `index.ts`
  (`buildDemoDataset(today)` in FK-safe order, asserts every row targets the demo workspace).

All names, numbers, rents, leases and market statistics are invented. Any resemblance to real companies or people
is coincidental.
