# Videos to re-record after the recent UI changes

Checked on 2026-11-12 against the running app (:3100) by reading every existing `flows-*.js` against the current pages
(`/today`, `/approvals`, `/capture`, `/signals`, `/leases`, sidebar `src/lib/nav.ts`). Each row says what breaks and the suggested step fix. "Hard" = the step uses `t.point`/`t.moveAndClick` and the flow FAILS;
"soft" = the flow records, but the step is skipped or the caption no longer matches the screen.

What changed in the app:
- Sidebar: **Lease radar is gone from More**. Leases is now under **Work → Leases** with tabs Leases (dashboard) · Calendar ·
  Renewals · Obligations · Portfolio · **Radar** (the old radar, unchanged, at `/leases/radar`). "Automations" is now **Automation**.
  New sidebar item **Work → Transactions**.
- Today: sections are now Getting started · Today's schedule · Priority tasks & follow-ups · Overdue commitments · Meetings needing
  prep · Recommended next actions · **Active transactions** · Capacity · Pending approvals · New signals · **Important lease
  events** · **Lease alerts** · Deals needing attention · Priority accounts. Gone: "Meetings — today…", "Follow-ups & commitments
  due", "Lease events", "Day plan", the "Generate brief now / Refresh brief" button, "Plan notice" and "Open task" links.
- Review (`/approvals`): new sections **Transaction approvals waiting for you**, **Lease dates needing review**, **Lease terms to
  confirm (possible conflicts)**, **Imports to review** above the tabs (Record changes · Identity merges · External drafts ·
  Documents · History & undo; Stale records is a link).
- Signals: card sections are "1. What happened" (no "?"), "12. Suggested next steps"; buttons "Add counter-evidence",
  "Propose opportunity" (was "Propose deal"); header has a **Sources** link; new view **Dismissed & snoozed**.
- Capture: Speak / Type / Photo are still `role="radio"` buttons (unchanged). "Link to a record" under Add files now also has
  **Lease** and **Transaction** search pickers (besides company / person / building / requirement / meeting selects). Photos are
  now read by **local OCR** (no AI) — the "photo text not read (AI not set up)" badge no longer appears for readable photos.

| # | File · slug | Step(s) | Kind | Suggested fix |
|---|---|---|---|---|
| 1 | `flows-records.js` · `lease-radar` | "Open More in the sidebar, then Lease radar." `navLink(p, "Lease radar")` | **Hard** | Replace with `await t.moveAndClick(navLink(p, "Leases")); await t.moveAndClick(main(p).getByRole("link", { name: "Radar", exact: true }));` and caption "Open Leases (under Work), then the Radar tab." Rest of the radar steps still match (`/leases/radar` content unchanged). Consider retitling to "Lease radar tab" and pointing to the new `leases-dashboard` video in the outro. |
| 2 | `flows.js` · `tour` | "Research looks into one company; Lease radar…" `navLink(p, "Lease radar")` | soft | Point at `navLink(p, "Leases")` (Work group) with caption "Leases: every lease, its dates, renewals and obligations — the radar is a tab inside." Add a step for `navLink(p, "Transactions")`: "Transactions: offers, approvals, execution and handover for a confirmed requirement." |
| 3 | `flows.js` · `tour` | "Automations: chains…" `navLink(p, "Automations")` | soft | `navLink(p, "Automation")` (label changed); caption "Automation: what runs in the background, schedules, chains and failures." |
| 4 | `flows.js` · `tour` | Today steps `H(p, /^Meetings — today/)`, `H(p, /^Lease events/)`, `H(p, /^Day plan/)` | soft | Use `H(p, /^Today's schedule/)` ("Today's schedule: every meeting with time, place and whether its brief is ready"), `H(p, /^Important lease events/)` + `H(p, /^Lease alerts/)` ("lease dates coming up and alerts from Leases"), and `H(p, /^Active transactions/)`. Drop the "Day plan / Re-plan" step (now Automation → Daily plan, covered by `daily-plan-v2`). |
| 5 | `flows-comms.js` · `today-plan` | "Generate brief now" button; "Plan notice" link; `/^Meetings — today/`; `/^Follow-ups & commitments due/`; `/^Lease events/`; "Open task" link | **Hard** (6 steps) | Rewrite on the new sections (or retire it — `flows-automation.js` `daily-plan-v2` already covers Today fully). Minimal fix: remove the brief-button step; point at `getByText(/^Today's schedule/)`, `/^Priority tasks & follow-ups/`, `/^Overdue commitments/`, `/^Important lease events/`; "open the first task" → `main(p).getByRole("link", { name: "All tasks" })` or click the first task title under Priority tasks. |
| 6 | `flows-intel.js` · `signal-paste-v2` | "'What happened' quotes the event…" `getByText("1. What happened?")` | **Hard** | `main(p).locator("summary", { hasText: /^1\. What happened/ })`. Optional: mention the Sources link and the new Dismissed & snoozed view; the full v2 walkthrough is now `signal-card-v2`. |
| 7 | `flows-intel.js` · `signals-review` | `"1. What happened?"` (soft); `"Propose deal"` (soft) | soft | `/^1\. What happened/`; button `"Propose opportunity"` with caption "…or propose a new opportunity — it goes to Review for approval." "Add counter" still matches "Add counter-evidence" (substring) — update the caption to the new label. |
| 8 | `flows.js` · `capture-v2` | "Link to a record ties the file to a company, person, building or requirement." | caption only | "…to a company, person, building, requirement, meeting, lease or transaction." Optionally point at `main(p).getByPlaceholder("Search tenant, company or building…")` (the new Lease picker). |
| 9 | `flows-ai.js` · `capture-files-v2` | "Optional: link it to a record first — company, person, building, requirement or meeting." | caption only | Add "lease or transaction" (new pickers). |
| 10 | `flows-input.js` · `capture-business-card` | "Practice mode cannot read photos ('photo text not read')…" and the two "Type the card text … Process again" steps | soft / wrong content | Photos are now read by local OCR without AI. Change the caption to "The card was read on the server by local OCR — no AI call." and drop the typing workaround if the PNG fixtures OCR cleanly (the fixtures are rendered text, like `card-capture.db.test.ts`); keep it as a fallback only when `getByText(/photo text not read/)` is visible. See the new `local-ocr-business-card` video. |
| 11 | `flows-ai.js` · `review-queues-v2` | "At the top: quick counts…" | soft (content) | Still passes, but add steps for the new sections: `getByText(/Transaction approvals waiting for you/)`, `/Lease dates needing review/`, `/Lease terms to confirm/` ("decisions from Transactions and Leases also wait here"). The tabs (Record changes, Identity merges, External drafts, Documents, History & undo) and the Stale records link are unchanged. |
| 12 | `flows.js` · `find-accounts` | "Each match shows why it matched: the lease and its dates…" `TX(p, /^Lease events:/)` | soft (check) | Verify on a dry run; if the match card no longer starts with "Lease events:", point at the lease date text instead. |
| 13 | `flows-intel.js` · `market-reports` | caption "Link it to a lease so Lease radar can use its clauses…" | caption only | "…so Leases (and its Radar tab) can use its clauses." |
| 14 | `flows-records.js` · `deal-pipeline` | outro "check the lease radar." | caption only | "check lease dates under Leases." |
| 15 | `flows-ai.js` · `ai-lease-extract` | whole flow | check | Lease terms from documents is now "code first, AI as backup" (`capture.lease_terms`, default Backup). The table may now say it was read by rules; re-run `--dry` and adjust the "parsed by code" captions if the labels changed. |

After fixing: `node scripts/tutorial-videos/record.js --group <group> --dry <slug>` for each, then record (see README).
New videos for these areas (prepared, not yet recorded): groups `leases`, `transactions`, `supply`, `signals2`, `ai-settings`.

## Status (2026-11-12): flows fixed, not recorded

All rows above are now applied in the flow files. Every changed video got a **new slug** so the storage sync (which never
overwrites) uploads the new file. `timings/<old-slug>.json` and the manifest still point at the old videos until each new
slug is recorded — rename/regenerate timings only when recording.

| # | File | Old slug → **new slug** | Dry run (`--dry`, :3100) |
|---|---|---|---|
| 1, 14 | `flows-records.js` | `lease-radar` → **`lease-radar-v2`** (Leases → Radar tab) | ok (11 steps) |
| 14 | `flows-records.js` | `deal-pipeline` → **`deal-pipeline-v2`** (outro caption) | ok (19 steps) |
| 2–4 | `flows.js` | `tour` → **`tour-v2`** (Leases/Transactions/Supply/Intelligence/Automation, new Today sections) | ok (41 steps; soft misses: Review evidence/Approve on an empty queue, Supply link hidden in this user's sidebar, Deals "research" column) |
| 8 | `flows.js` | `capture-v2` → **`capture-v3`** (Link to a record caption) | ok (25 steps) |
| 5 | `flows-comms.js` | `today-plan` → **`today-plan-v2`** (rewritten on the new Today sections) | ok (12 steps) |
| 6 | `flows-intel.js` | `signal-paste-v2` → **`signal-paste-v3`** ("1. What happened" summary; re-paste falls back to the Unverified view) | ok (13 steps) |
| 7 | `flows-intel.js` | `signals-review` → **`signals-review-v2`** (Propose opportunity, Add counter-evidence, 12. Suggested next steps; signal link skips the new Sources link; pins demo workspace) | ok (23 steps) |
| 13 | `flows-intel.js` | `market-reports` → **`market-reports-v2`** (caption) | ok (18 steps) |
| 9 | `flows-ai.js` | `capture-files-v2` → **`capture-files-v3`** (caption) | ok (16 steps) |
| 11 | `flows-ai.js` | `review-queues-v2` → **`review-queues-v3`** (+ Transaction approvals / Lease dates / Imports to review steps, optional pointers) | ok (20 steps) |
| 10 | `flows-input.js` | `capture-business-card` → **`capture-business-card-v2`** (local OCR caption; typing only if "photo text not read") | ok (16 steps) |
| 12 | `flows.js` | `find-accounts` — unchanged (`Lease events:` card text still exists) | data: 0 matches in Kharadi next year — run `setup-demo.ts` before recording |
| 15 | `flows-ai.js` | `ai-lease-extract` — unchanged ("parsed by code" captions still match) | ok (17 steps) |

**Recording caveat:** `getContext()` picks the first workspace by name when no `cre_ws` cookie is set; the owner now also
belongs to a test workspace named "Brief r2 …", which sorts before "Demo — Pune CRE (synthetic)". Flows that don't set the
cookie themselves then run in the wrong workspace (capture-v3, find-accounts, lease-radar-v2, deal-pipeline-v2,
ai-lease-extract, capture-files-v3 failed that way). The dry runs above pinned the demo workspace with a wrapper that adds
`cre_ws=de000000-0000-4000-8000-000000000001` to the login state; `record.js`/`harness.js login()` should do the same (or
archive the stray workspace) before recording.
