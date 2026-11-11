# Bug hunt A — CRE OS (2026-11-11)

Scope: http://localhost:3100, owner@cre-os.local, workspace "Demo — Pune CRE (synthetic)".
Method: an automated Playwright crawl of 121 routes at 1440px and 375px (every static route, plus one instance of each dynamic route found through links). It opened every `<details>`, logged console errors, HTTP >= 400, page-level horizontal overflow, raw UUID/NaN/undefined/null/[object Object] text, duplicate units and load time, and saved a screenshot per page. Then form tests: empty submit on 16 forms, and silly or realistic values on the create forms.
Evidence: `/tmp/hunt-a/` (`1440_*.png`, `375_*.png`, `form-*.png`, `crawl-1440.json`, `crawl-375.json`). Scripts are in `/tmp/hunt-a/scripts/`.

**Coverage caveat:** the shared app server on :3100 stopped responding at about 15:45 (the process was gone and nothing was listening), and it was still down after more than 15 minutes of waiting. I did not restart it. Because of that, these steps were **not done**: clicking through tabs (Today tabs, the company/person tabs, Review queues), Search in its second mode, the Buildings map, the Capture file drop, a tutorial video page, the Settings forms, and form tests at 375px. All page-level checks did run on all 121 routes at both widths.

---

## Blocker
None found in the routes I covered. All pages returned 200, except the two items under Major #1 and the evidence page noted under "Not bugs".

## Major

### M1. "Generated deliverables" list has download links to `/…/undefined` (404)
- URL: `/toolkit/deliverables`. The link goes to `/toolkit/deliverables/1dc3bd4d-7985-48c0-ad90-1a8ad1454fa0/undefined` and returns 404.
- Cause: the list shows every `deal_analysis` row with `kind='deliverable'`, which includes **property packs** made by `/toolkit/packs`. Pack `outputs.files[]` entries have no `name` (only label/kind/path/bytes/sha256), so `encodeURIComponent(f.name)` becomes "undefined". The `key={f.name}` is also undefined, so React gets duplicate keys.
- File: `src/app/(app)/toolkit/deliverables/page.tsx:85`. Pack writer is in `src/modules/toolkit/` (packs). The download handler only matches by `name` (`src/modules/toolkit/deliverables.ts:245`).
- Expected: either filter packs out of this list (or link them to `/toolkit/packs/[id]`), or store a `name` on pack files.

### M2. A failed "New requirement" submit still creates a company, and wipes the form
- Steps: `/requirements/new` → type a title and an "Or new company" name → put text in Area min → Submit.
- Actual: the page redirects to `/requirements/new?err=Area min/target/max: not a number`. **All entered values are lost** (Title is blank again). But **the new organisation was already inserted**: company `c69b00da…` was created at 10:11:21 with no requirement attached.
- Cause: `createRequirement` inserts the organisation before `buildPatch`/`assertRequirementRanges` validate the input (`src/modules/deals/requirements/service.ts:119-127`). The server action redirects with `?err=` and does not keep the form state (`src/modules/deals/actions.ts:39-47`).
- Expected: validate first; keep the user's input on error.

### M3. Typed company name is matched with `ilike` (wildcards), so it can attach to the wrong company
- `service.ts:123`: `.ilike("display_name", name)`. A name containing `%` or `_` (for example "A_B Corp", or "50% Realty") is used as a pattern. It can silently pick an existing, different organisation, and the requirement is created under that company. Escape `%`/`_`, or use exact case-insensitive equality.

### M4. Raw Postgres error shown to the user on Add company
- `/companies/new` → More details → Headcount (max) = `99999999999999` → Create.
- Actual: the message reads `value "99999999999999" is out of range for type integer`. Screenshot: `/tmp/hunt-a/company-neg-headcount.png`.
- Expected: a friendly validation message ("Headcount must be a whole number up to …").
- File: the companies create action in `src/modules/admin/` (it parses headcount without range checks).

### M5. Negative and inverted values accepted without complaint
- Company headcount min `-5` and max `-10` saved as-is (company `6607d5ab…`, since archived). Number fields in the create forms are `type="text"` with no `inputmode`/`min`, so mobile users get a text keyboard.
- Same pattern in `/buildings/new` (`total_area_sf`, `floors`) and `/requirements/new` (`area_*`, `seats_target`, `budget_*`). Requirements does reject non-numbers, but only after a round trip that loses the input (M2).

### M6. Horizontal page overflow at 375px on many pages, caused by the `Help` tooltip
- The hidden tooltip in `<Help>` (`src/components/ui/index.tsx:25`: `invisible absolute left-1/2 w-72 -translate-x-1/2`) still takes up layout width. When a "?" sits near the right edge, the whole page scrolls sideways.
- Pages with page-level overflow at 375px from this cause: `/today` (426px), `/toolkit` (736), `/toolkit/quotes` (442), `/contacts` (449), `/documents` (399), `/requirements/[id]`, `/research/[orgId]` (471), `/research/assessment/[id]`, `/meetings/[id]`, `/outreach/[id]` (792), `/capture/documents/[id]`.
- Fix: clamp the tooltip (`max-w-[calc(100vw-2rem)]`, right-align near the edge), or use `display:none` when hidden.

### M7. Other 375px overflow: tables and cards that are not inside a scroll container
- `/fees` (620px, `table.min-w-[560px]`), `/legal` (598), `/requirements/[id]` (the same table), `/toolkit/fitout` and `/toolkit/fitout/[id]` (1170), `/toolkit/compare/[id]` (721), `/toolkit/compare/new` (asset checkbox grid, 423), `/imports/[id]` (620, a long `<p>` in the first section), `/outreach` (610, card titles with `truncate` but no `min-w-0` on a parent), `/assistant/commands` (377).
- `/toolkit/fitout` also overflows at **1440px** (1502px, `table.min-w-[1180px]` plus the sidebar).
- Screenshots: `/tmp/hunt-a/375_fees.png`, `375_toolkit_fitout.png`, `375_outreach.png`, etc.

## Minor

### m1. Raw UUIDs and internal IDs shown in user-facing text
- `/approvals`, `/tasks`, `/database`: proposal summaries read "Assistant: terms from attached document (extraction ec89c05c-5b10-4e2c-…)". `/approvals` evidence also shows the storage path "stored at de000000-0000-4000-8000-000000000001/captures/uploads/bd6367f2-…/riverside-quote.pdf" and "capture document 8621196c".
- `/assistant/memory`: "from draft_edit · by 00000000-0000-4000-8000-000000000001". Both the user id and a snake_case source are shown.
- `/research/[orgId]`: the provenance row reads "relationship_edge (dc09713c-84ef-…)".
- Likely sources: the proposal summary strings built in the capture extraction (`src/modules/capture/**`), `src/modules/changes/ui/proposal-card.tsx`, the assistant memory page, and the research provenance list.

### m2. Literal `null` in Legal clause parse output
- `/legal/17ab6bb5-…`: "Parsed from the wording: months 36 · mutual null", and "months 6 · day rule null". The same page shows "6 months written notice.Page 3" (no space between the clause text and the page marker).
- Suspect: the clause-parse renderer in `src/modules/intelligence/` (legal). It joins `key value` pairs without skipping null.

### m3. Raw enum and snake_case labels
- `/approvals` and `/tasks`: "clarify update lease" (action/kind tokens, not a sentence). `/assistant/memory`: "draft_edit".

### m4. Unlabelled form controls
- Workspace switcher `<select name="workspace_id">` has no label or aria-label (`src/app/(app)/workspace-switcher.tsx`).
- `/capture`: the first form has an unnamed and unlabelled `<select>`. The live-dictation language `<select>` is unlabelled (`src/modules/capture/ui/live-dictation.tsx:85`).

### m5. `/tasks` renders about 310 `<form>` elements
- Every task row carries several inline forms, each with a `required` "evidence" field. The page is heavy, and pressing Enter in the filter bar triggers native validation on the hidden row forms. Consider one form per row with a dialog.

### m6. Slow pages (>3s on the warm production build)
- `/admin` 3.8s (1440) and 3.0s (375); `/tutorials` 3.5s; `/settings/partners` 3.0s; `/database` 3.1s at 375. Most other pages took 1–2.4s, with `/requirements/[id]` the slowest at 2.4s.

### m7. Silently dropped input
- When long values (>~600 chars) or emoji/markup were typed into optional fields (domain, CIN, sector) on `/companies/new`, only the display name was saved and there was no message. To check: whether this is deliberate trimming or a validation miss. (I could not re-test this with the details panel open before the server went down.)

## Polish
- Duplicate unit labels: none found ("sf sf" and similar). The flagged `/toolkit/financing` "months / Months" is a field hint next to its label, so it is a false positive.
- Escaping: `<b>x</b>` and emoji render as text everywhere I checked. There is no XSS. Long unbroken names (600 characters) are accepted with no length cap on `display_name`/`full_name`/building `name` (requirements caps at 300). Worth a reasonable cap.
- `/buildings/new`, `/people/new` and `/companies/new` all rely only on native `required` messages. They are fine, but they do not match the inline `?err=` style used in Requirements.

## Not bugs / checked OK
- `/approvals/evidence` returns 404 without `?type&id` by design (`notFound()` when parameters are invalid). All in-app links pass the parameters.
- No console errors or page errors on any of the 121 routes at either width, apart from the M1 404.
- Empty submit on companies, people, buildings, requirements, meetings, outreach, compare/new and imports is blocked by native `required` validation.
- `/api/v1/meetings/[id]/brief` and `/toolkit/deck/[id]?doc=` start downloads, which is expected.

## Cleanup
Records I created were archived (`archived_at` set by SQL, because the UI was down): organisations `dfdaa466…`, `c69b00da…`, `6607d5ab…`; person `d261cb59…`; asset `82df2511…`. The silly-value requirement submits failed, so no requirement rows were created.
