# Browser test A — Module 15 Leases + Signals / Settings AI / Capture regression

Date 2026-11-12 · app http://localhost:3100 (Demo workspace, owner) · Playwright-core + Chrome · viewports 1440 and 375.
Screenshots: `/tmp/bt-a/*.png` (`w-*` = 1440, `m-*` = 375). Console errors / page errors: **none** on any page tested.
Page-level horizontal overflow at 375: **none** (only intentional scroll rows such as tab bars and filter chips).

## Results

| # | Step | Result |
|---|---|---|
| 1 | `/leases` dashboard (KPIs, filters, milestones, list) 1440/375 | PASS |
| 2 | `/leases/new` create lease (rent, area, lock-in 36) → redirect to detail | PASS |
| 3 | Paste lease text, single paragraph (execution + commencement + term in one paragraph) | **FAIL**, see B1 |
| 4 | Paste lease text, separate paragraphs: "commence on 1 January 2027", "9 years", "lock-in 36 months", "not less than six months prior to expiry" | PASS. Commencement 2027-01-01 (stated, p.1); lock-in end 2029-12-31 (`edate(…,36) − 1 day`, p.2); expiry 2035-12-31; renewal and termination notice deadline 2035-06-30 (`edate(2035-12-31,−6)`). Each shows its source clause, document + page, method, convention and verification status |
| 5 | Renewal notice wording "may renew the lease by giving notice not less than six months prior to expiry" | **FAIL**: classified as a termination notice (B2) |
| 6 | Confirm a needs-review date without picking a date | PASS. Input is `required`; the server also rejects it ("choose the correct date explicitly"). The error banner is not shown (B3) |
| 7 | Confirm a needs-review date with a picked date and a note | PASS. Shows "Reviewer chose 2029-12-31 … checked vs deed / Confirmed" |
| 8 | Confirm calculated dates (commencement, lock-in, expiry, renewal notice) | PASS. A stale review note remains on another date (B5) |
| 9 | Reminders created from confirmed dates only (90/30 lock-in; 365/270/180/90 expiry; 90/60/30 renewal notice); Recalculate | PASS |
| 10 | Terms v2 (extracted) confirm as current | PASS (no flash shown) |
| 11 | Amendment (rent only) → history kept (v1/v2 superseded, v3 current) | **FAIL**: unchanged terms are wiped (B4) |
| 12 | Status draft → awaiting_execution → executed (with executed doc and execution date). Only valid transitions are offered | PASS |
| 13 | Obligations: add (tenant, deadline), mark done with evidence; `/leases/obligations` lists it | PASS |
| 14 | Renewal: start review, set stage to negotiation; `/leases/renewals` pipeline shows it under Negotiation (1) | PASS |
| 15 | Handover checklist: create (10 default items), mark an item done with evidence | PASS |
| 16 | Termination: start (notice date, period, proposed date), update to notice_served + deposit recovered | PASS with UI issues (B7) |
| 17 | `/leases/calendar` | PASS |
| 18 | `/leases/portfolio`: totals use known values only; exclusions listed ("area unknown") | PASS. Labelling issue (B8) |
| 19 | `/leases/radar` tab | PASS. Status mismatch (B9) |
| 20 | Raw codes / UUIDs on lease pages | **FAIL** (B6) |
| 21 | Signals: paste at top → 2 signals; company unmatched message | PASS |
| 22 | Signals: counter-evidence paste → AGAINST (2), score 27 → 15 | PASS |
| 23 | Signals filters (category, urgency, q) | PASS |
| 24 | Settings → AI: MFA message "first turn on two-step sign-in in Settings → Security"; Save / Reset disabled | PASS. Radios still clickable (B10) |
| 25 | Capture business card PNG (sharp-generated) → name, title, company, email, phone and address extracted by "Contact card parser" (code, mock AI) → proposals for new org + person | PASS. Minor text issues (B11) |
| 26 | Cleanup: 2 test leases, 2 signals, the capture document and its 2 proposals archived (`archived_at`) | DONE |

## Bugs

- **B1 (high) — extract.ts: one clause kind per paragraph.** Text: "This Lease Deed is executed on 15 December 2026 … The term of the lease shall commence on 1 January 2027 and the lease term shall be 9 years." The whole paragraph is classified as `execution` (first matching rule). Commencement and expiry are lost ("missing: commencement date, expiry date / term"). Because of that, lock-in and notice become "not calculable". Fix: split into sentences or allow several kinds per chunk.
- **B2 (high) — renewal clause misclassified.** The `renewal` rule matches only "renewal", "option to renew/extend" or "extension of term". "The Lessee may renew the lease by giving written notice not less than six months prior to expiry" falls to the `notice` rule and becomes a **Termination / vacation notice deadline**. Add `\brenew\b` (verb).
- **B3 (medium) — flash lost on date confirm/reject.** `confirmDateAction` redirects to `/leases/{id}#dates`. `back()` then appends `?err=` after the hash (`…#dates?err=…`), so `searchParams` is empty and neither the error nor "Saved." is shown. Other actions also showed no banner: confirm terms, obligation done, handover done, termination update. Fix in `actions.ts` `back()`: insert the query before `#`.
- **B4 (high, data) — amendment wipes unchanged terms.** Proposing an amendment with only rent 880000 produced "Term (months): 108 → unknown; Lock-in (months): 36 → unknown". After confirming it, term and lock-in disappear from Current. Blank fields should carry forward from the current version, not overwrite it with unknown (`addAmendment` in service.ts).
- **B5 (low) — stale review_reason.** After the expiry was calculated, the termination notice date (2035-06-30) still says "The expiry date is not known/confirmed, so the deadline cannot be calculated."
- **B6 (medium) — raw codes on lease detail.**
  - Activity timeline shows table names ("insert lease_status_history", "update lease_date → needs_review") and raw statuses ("draft → awaiting_execution").
  - Conventions show raw codes: "convention: exclusive_of_anchor, eom_clamp" and "period_inclusive_end".
  - Supply alternatives show "currently_confirmed" and "historical_observed".
  - Termination status shows "notice_served", with raw values in its select.
  - Terms table shows unformatted numbers ("Monthly rent 800000", unlike ₹8,00,000 elsewhere).
  - `Transaction` would show a raw UUID (`L.transaction_id`) when set.
  - Timeline is not in chronological order (02:32 entries before 02:31).
- **B7 (low) — termination card text.** "confirmed not confirmed · notice_served" and "Security deposit: unknown · recovered ₹1,00,000 · unknown" are hard to read. The lease status stays "Executed" after the termination notice is recorded as served (it may be expected to move to "Termination notice served").
- **B8 (low) — portfolio label.** "Active leases 4" but "By status: Active 3, Executed 1"; the label should say "Active / executed".
- **B9 (low) — radar status.** The radar row shows the test lease as "Active" while the lease is "Executed" with no confirmed possession step.
- **B10 (low) — Settings → AI.** When MFA blocks saving, the Off/Backup/On radios stay enabled (the fieldset uses `!canEdit` only), so a user can change values that cannot be saved.
- **B11 (cosmetic) — Capture card.**
  - "no existing contact no existing contact — new contact suggested" repeats itself.
  - Proposal labels are raw ("proposed create organisation").
  - Signal badge text runs together: "UnverifiedHYPOTHESIS".
  - Reminder rows run together: "scheduledMark done" needs a space or separator.
- Not reproduced: right after the first "Attach & extract", the detail page once rendered without the new dates or document. A reload showed them. The second run rendered correctly on the first load.
