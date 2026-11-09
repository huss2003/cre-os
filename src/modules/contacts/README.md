# Module 4 — Contact Enrichment

Finds and verifies the people who matter for office decisions. Every field carries its own status and source; nothing
reaches canonical records without a person approving it.

## Reused (not duplicated)
person, employment (history), contact_method, interaction(+link), stakeholder · `proposeChange` / `approveAndApply`
(Module 1 updates), `proposeMerge` (reversible identity merge, admin approval), `proposePersonMove` (job change: old role kept)
· Module 3 `scoreEntity("contact")` and the `scoring_enqueue` trigger · AI gateway (Claude Haiku web search).

## Added (`20261108000700_contact_enrichment.sql`)
- contact_method: verify_status, verify_evidence, source_name/url, observed_on, last_checked_at
- person: last_enriched_at, next_review_on, do_not_contact
- enrichment_job, enrichment_item (stage, identity match, field-level evidence, role, completeness, decision)
- contact_role_assessment (rules / ai / user correction, with reason + evidence) → feeds Module 3
- reporting_line (manual only)

## Rules (`rules.ts`, deterministic)
Email: syntax → MX → company domain → role inbox / free webmail → `verified` only when a person or licensed provider confirms;
`likely_valid` = published on the cited source + MX ok; guesses are never verified. Phone: E.164, extension, country,
classified by where it was published; ownership never inferred. Roles: department + seniority, with a reason; a senior title
is not authority. Identity: email → profile → name+company; name alone never merges (duplicate / job-change review).

## Screens
`/contacts` (overview tiles; tabs: To review, Find people, Decision-makers, Enrich (bulk), Missing info, Job changes, Duplicates,
Sources, History), `/contacts/[id]` (profile, field table, channels with evidence, history, actions), `/contacts/company/[orgId]`
(teams + manual reporting lines), `/contacts/job/[id]` (run detail, retry, CSV report `/api/v1/contacts/jobs/[id]/report`).

## Sources
Available: your records, company websites/leadership/press via Claude web search (needs ANTHROPIC_API_KEY), MX checks,
spreadsheet upload (Imports), captures. Not connected: licensed B2B databases, LinkedIn (no approved integration — never scraped),
MCA filings. These show as "Not connected".

## Jobs
`contacts.reverify` weekly (Sunday 03:00): contacts past `next_review_on` get channels re-checked (no web, no cost).

## Known gaps
CSV column-mapping lives in Imports (not a separate uploader here). No paid provider integrated, so "verified" emails come
only from user confirmation. Profile images are not collected.
