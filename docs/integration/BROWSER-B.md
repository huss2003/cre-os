# Browser test B — Transactions (M16), Supply (M14), Today/Review/Ask AI, nav

Date 2026-11-12 · http://localhost:3100 · owner@cre-os.local · Demo workspace · Playwright + Chrome · 1440 and 375 px.
Screenshots are in `/tmp/bt-b/`. Scripts are in `/tmp/btb-scripts/`.
Test records (7 `BTB-*` transactions, TX-261112-LBG00 plus one per type) and the lease handed off from them (30438849…) are archived.

## Results

| # | Step | Result | Notes / screenshot |
|---|---|---|---|
| 1 | Create a transaction from a deal (deal page → "Transaction workspace") | PASS | The deal is preselected. The requirement is **not** preselected (I picked it by hand). tx-01, tx-02 |
| 2 | Stage plan for each of the 7 types | PASS | Conventional 15 stages, managed office 12, coworking 9, renewal 11, relocation 13, build-to-suit 12, investment 11. All match the spec §3.2 |
| 3 | Offer v1 plus counteroffer v2 (with parent link) | PASS | A counteroffer with no reason is rejected ("needs the reason for the change"). Version diffs are shown. tx-03 |
| 4 | Package comparison (lower headline rent is not decisive) | PASS | v2 has lower rent (76 vs 80) but higher CAM, more deposit and no rent-free. Result: "cannot say… a lower headline rent alone does not make it cheaper". Lists missing inputs and assumptions. tx-04 |
| 5 | Three positions kept separate (client 70 / adviser 74 / counterparty 76) | PASS | Separate columns; none converted into another |
| 6 | Commercial point: agree without evidence is blocked; agree with evidence works | PASS | |
| 7 | Issues: owner, next action, due date; overdue and blocking | PASS | Missing due date and missing reason is rejected. The issue appears in Blocking and Next actions |
| 8 | Inspection plus clarification (discrepancy) | PASS (minor bug B6) | |
| 9 | Document request: received ≠ verified | PASS | Shows "received — not verified", then "verified" |
| 10 | Stakeholder plus assigned pending action | PASS | |
| 11 | LOI v1 → v2 clause diff; term reconciliation | PASS | Rent modified, clause 5 added; "Differs from agreed terms" is flagged. tx-05 |
| 12 | Approval bound to a version; a new version invalidates it | PASS | The v1 approval shows "invalidated: superseded by version 2" and a v2 reassessment opens as pending |
| 13 | Agreement v1/v2 compare | PASS | 1 added, 2 modified (rent, notice). tx-06 |
| 14 | Deposit due vs paid | PASS | "Due — not paid". Paid without evidence is rejected ("payment needs supporting evidence"). Display issue B5 |
| 15 | Execute → possession → handover | PASS | Execute without an executed agreement is rejected. Then: executed agreement → executed; possession; checklist generated (8 items); one item closed with evidence |
| 16 | Closure pack download | PASS | DOCX, 200, 10.9 KB (`/tmp/bt-b/closure-pack.docx`). Complete stays disabled while blockers remain (listed correctly) |
| 17 | Lease handoff visible in /leases | PASS (bugs B3, B4) | Lifecycle hand-off "delivered". The lease appears in /leases with reference TX-…, status Executed. lease-handoff-detail |
| 18 | /buildings/supply: inventory, operators, match with explanations, reconfirm warning | PASS (bugs B7–B9) | Banner: "20 of 96 availability observations are stale — reconfirm before presenting". Match shows fails / satisfies / advantages / missing / verification required |
| 19 | Today: active transactions, blockers, lease events | PASS | Both active transactions are shown with their blockers and next action; lease alerts are counted |
| 20 | Review: new transaction-approvals section plus badge | PASS (bug B2) | "Transaction approvals waiting for you (3)"; the badge count is shown |
| 21a | Ask: leases expiring next year | PASS (B10) | 19 leases with coverage note; grounded |
| 21b | Ask: available 20,000 SF in Kharadi | **FAIL (B1)** | Only "5 eligible of 10 option(s)." — no options listed |
| 21c | Ask: what's blocking my transactions | **FAIL (B1)** | Only "2 active transaction(s), 2 with recorded blockers." — no names or blockers. ask-3 |
| 21d | Ask: who can introduce me to X | **FAIL (B1, B11)** | "Northwind GCC" → 0 companies found. The full name gives "2 introduction path(s)." with no paths listed |
| 21e | Ask: which companies to approach today | PASS | Ranked list with reasons and coverage |
| 21f | Ask: prepare tomorrow's meeting | PARTIAL (B12) | Lists the next 7 days, today included, not tomorrow. Blocked step shows raw tool name |
| 22 | Nav: Leases, Transactions, Supply, Intelligence, Automation reachable | PASS | Leases and Transactions are under Work. Intelligence and Automation are under More. Supply is reachable from /buildings (2 links), not in the sidebar. 375 drawer works |
| 23 | Console errors | PASS | None on any page tested at either width |
| 24 | Overflow at 375 | PASS | No horizontal overflow on the transaction workspace, supply (3 tabs), today, approvals, transactions or assistant |

## Bugs

- **B1 (Ask AI, high):** Transaction, supply and introduction answers show only a one-line count. The items behind it are not rendered: which options, which transactions and blockers, which paths. The tool runs, but its rows are not shown. Compare the leases and priority answers, which render tables.
- **B2 (Review, medium):** "Transaction approvals waiting for you" still lists approvals of an **archived** transaction (TX-261112-DG8WH, archived 02:46). The query needs to exclude transactions where `archived_at` is set, or archive approvals together with their transaction.
- **B3 (Leases/handoff, medium):** The lease from the handoff shows "Property unknown", although the transaction had property labels (Tower A Kharadi…). Lease start is unknown although the executed text said "Lease start 1 March 2027", so lock-in completion is "not calculable".
- **B4 (Leases detail, low):** The Overview shows "Transaction 3ae6d7b7-…" as a raw UUID. It should be the TX code with a link.
- **B5 (Transactions, low):** The deposit amount is shown as `19000000`, with no ₹ and no Indian grouping. The Stages column dumps raw booleans ("proposed: true · approved: false …").
- **B6 (Transactions, low):** For a clarification with only a numeric minimum (`required_num`), the Requirement column shows "—", even though the status correctly says discrepancy.
- **B7 (Transactions, low — raw codes):** Several raw codes reach the page:
  - Stage badges (`in_progress`) and the /transactions list ("stage: property_shortlist").
  - Document status and signing selects (`client_review`, `counterparty_review`, `partially_signed`) and the doc-kind badge `executed_agreement`.
  - Timeline entries ("created (conventional_leasing)", "client_commercial approval…").
  - The timeline lease handoff line shows the full lease UUID.
- **B8 (Transactions §3, low):** Property options are rendered as "Space {uuid.slice(0,8)}", a UUID fragment instead of a building, floor or unit label (page.tsx line 94).
- **B9 (Supply, low):**
  - Match rows read "Floor Floor 13" and "Floor Floors 5–6" (doubled label).
  - Inventory shows the raw stack code "contiguous block cantonment_house:stack".
  - Areas are unformatted (40618 SF).
  - The #1 match is an option with fit 0, data 14% and "availability none" that "meets all hard requirements" only because the area is unknown. It ranks above better-known options; check the ordering.
- **B10 (Ask leases, low):** The "Fact status" column shows `historical_observed`, and areas are unformatted.
- **B11 (Ask intros, medium):** Short company names ("Northwind GCC") don't resolve to "Northwind Halberd GCC India". The answer says 0 companies found when it should resolve or ask which company.
- **B12 (Ask meeting prep, low):** "tomorrow" is not honoured (it covers today through +7 days). It shows raw `brief_ready` and "generate_meeting_brief:" in the blocked text.
- **B13 (Transactions create, low):** Coming from a deal preselects the deal but not its confirmed requirement. The user has to find it by hand.
- **Other modules' raw codes seen (FYI):** Today shows deal stages `approach_attempted`, `options_visits`, `proposal_negotiation`. Review/approvals shows `cam_per_sf`, `lockin_months`, `spreadsheet_import`, `per_sf_per_month`, etc.

## Fixes (Ask AI B1, B10, B11, B12)
- **B1:** `transaction_blockers`, `match_requirement_supply`, `find_alternative_space` and `find_intro_paths` now return table blocks: each transaction with its blockers, approvals and next actions; each option with its result, availability, reasons and what to check; each intro path with its route, warmth, last contact and permission (`assistant/tools/crossmodule.ts`).
- **B10:** The leases table shows plain fact labels and formatted areas, via `factLabel` / `areaSf` in `assistant/tools/shared.ts`.
- **B11:** A multi-word name now matches when all its words appear in order, so "Northwind GCC" finds "Northwind Halberd GCC India" (`engine/context.ts tokensInOrder` + an ordered ilike). If more than one company ties, the assistant asks which one.
- **B12:** "tomorrow" and "today" now limit meeting prep to that IST day (`engine/mock.ts meetingWindow`). Status lines and readiness use plain words instead of tool and status codes (`engine/run.ts plainToolName`).
Tests: `assistant/engine/browser-b.test.ts`.
