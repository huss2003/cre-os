# Bug hunt B: findings (2026-11-11)

Scope: Deal toolkit, Outreach, Drafts, Meetings, Signals, Research, Scoring, Contacts, Market, Leases, Tasks, Calendar, Ask AI, Tutorials. Workspace: Demo — Pune CRE (synthetic). Checked at 1440px and 375px.
Coverage: an automated crawl of 38 seed routes plus 93 detail pages it found, at both widths (status, load time, console errors, raw-value text, horizontal overflow, unlabelled inputs). Folded sections were opened. Form fuzzing was only partly done: the app on :3100 stopped (connection refused at about 15:45) during the financing fuzz and was still down after more than 20 minutes. Following instructions, I did not restart it. **Not covered:** tab clicks, fuzzing of the other forms, and the meeting, outreach and signal actions. Screenshots: /tmp/hunt-b/ (`<route>_<width>.png`, `fuzz_*.png`).

## Blocker
1. **Every download link on Deliverables is broken (404).** On /toolkit/deliverables, every file link goes to `/toolkit/deliverables/<id>/undefined`. 9 of 9 links are affected (Site visit pack DOCX/PDF, Presentation deck PPTX).
   Cause: `src/modules/toolkit/packs.ts` (~L360-375) stores files as `{kind,label,path,sha256,bytes}` with no `name`. The page (`src/app/(app)/toolkit/deliverables/page.tsx:85`) builds the link from `f.name`, and `downloadDeliverable` (`src/modules/toolkit/deliverables.ts:245`) looks files up by `x.name`. Side effects: duplicate React keys (`key={f.name}` is undefined), and the label "(print) (PDF)" appears on a pack that `packs.ts` describes as "both files".
   Expected: the file downloads. Actual: 404 page with the text "undefined".

## Major
2. **Outreach page overflows at 375px.** The "New conversations to start" cards are about 560px wide. The score pill and "Prepare drafts" button sit off-screen, and the fixed bottom nav covers half of the second card. A long job title or company name ("Head – Real Estate & Workplace · Fjordline Automotive Engineering Centre") does not wrap: it needs `min-w-0`/`break-words` on the `LI`, `div.flex.items-start.gap-3` and `div.min-w-0.flex-1` chain. Screenshot: `_outreach_375.png`.
3. **The shared tooltip causes page-wide horizontal scroll at 375px.** The hidden tooltip span (`pointer-events-none invisible absolute left-1/2 top-7 z-30 w-…`, in `src/components/ui/index.tsx`) is still laid out and pushes `scrollWidth` past the viewport. Affected: /toolkit, /toolkit/quotes, /contacts, /meetings/[id], /research/[orgId], /research/assessment/[id]. Fix: clamp its position or width, or use `hidden` instead of `invisible`.
4. **Other pages that overflow at 375px:** /toolkit/compare/new (building picker labels), /toolkit/compare/[id], /toolkit/occupancy?id=…, /toolkit/fitout (also overflows at 1440), /toolkit/fitout/[id], /assistant/commands (including `?new=1` and `?edit=`). Screenshots are named by route.
5. **Raw internal IDs shown to users:**
   - /tasks: task titles read "Assistant: terms from attached document (extraction 9cf1cacf-…); Area (sq ft…". Source: `src/modules/assistant/tools/documents2.ts:168`.
   - /assistant/memory: "· by 00000000-0000-4000-8000-000000000001", a user UUID instead of a name. Source: `src/app/(app)/assistant/memory/page.tsx:39`.
   - /research/[orgId]: "relationship_edge (dc09713c-…)" in the provenance line.
6. **Financing calculator accepts absurd inputs without warning.** With 1000 in every numeric field it saved `bc30f3af-e49b-49ee-bb86-3c2f9e3bbac0`: rate 1000%/yr, financed 1,000 while project cost minus contribution is 0, interest ₹16,66,660 on ₹1,000 principal. There is no range check or consistency check between cost, contribution and financed amount. Source: `computeLoan` / `saveFinancingAction` in `src/modules/toolkit/actions-fitout.ts:48`.
   With 1e30 in every field, no row was saved and my check showed no error. My alert selector missed the `.text-bad` class, though, so this needs a recheck once the app is back up.

## Minor
7. **Unlabelled inputs (no label, aria-label or for):**
   - /outreach/new `person`
   - /leases search `q`
   - /tasks `q`, `scope`, `source`, `evidence`, `days`
   - /assistant and /assistant/[id] file input
   - /assistant/notes `notes` textarea
   - /meetings/[id] outcome form (`text`, `purpose`, `type`, `opportunity_id`, `requirement_id`, `asset_id`, `person_id`, `name`)
   - /toolkit/fitout: budget-line and quote inputs have no `name` and no label
   - /toolkit/models: criteria rows have no labels
8. **Deliverables timestamps are in UTC, not IST.** The page uses `String(d.updated_at).slice(0,16)` (page.tsx:83). The rule is to use the `time.ts` IST helpers.
9. **/research/[orgId] has an icon-only button with no accessible name** (375px).
10. **Workspace switcher lists test workspaces to the owner** ("Imports scale impscale-…", "Radar keys radar-keys-…"). This is test residue in the shared DB.

## Polish
11. **Tutorial video pages are slow at 375px** (about 3.0-3.9s): deal-pipeline, outreach-variants, calendar-import, lease-economics, negotiation-offers, ai-on-record, automation.
12. **The nav badge "14 meetings today" looks implausible** for the demo data. Worth checking that the count's query uses an IST day window.

## Clean
No 404/500s, no console errors and no NaN/Infinity/"[object Object]" outside the items above in the 262 page loads.

## Cleanup
Created: deal_analysis `bc30f3af-e49b-49ee-bb86-3c2f9e3bbac0` (title "HB-real <b>x</b> 🏢"). I did not delete it because the app is down; archive it with `update mudar.deal_analysis set archived_at=now() where title like 'HB-%';`.
