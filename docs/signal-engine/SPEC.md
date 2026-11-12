# MASTER DEVELOPMENT PROMPT: MODULE 2 — SIGNAL ENGINE
## Pune CRE AI Operating System

Act as a senior AI systems architect, CRE technology specialist, backend engineer, frontend engineer and product developer.

Your task is to design, implement, integrate and test **Module 2: Signal Engine** within my existing Pune Commercial Real Estate AI Operating System.

This is an implementation task, not a conceptual exercise. Inspect the existing application, understand its architecture and implement the module using the existing technology stack and design conventions.

---

# 1. UNDERSTAND THE EXISTING APPLICATION FIRST

Before writing code:

1. Inspect the complete existing codebase.
2. Understand the frontend, backend, database, authentication, APIs and existing UI components.
3. Inspect Module 1 — Database — and identify the tables, relationships, APIs and services already implemented.
4. Identify existing company, person, property, lease, requirement, interaction, source, observation, provenance, task and audit records.
5. Identify existing authentication, workspace permissions and source-entitlement controls.
6. Identify reusable components and existing navigation.
7. Check whether any signal-related functionality already exists.

Do not:
- Create a second application.
- Create a separate database.
- Duplicate Module 1 entities.
- Replace the existing technology stack unnecessarily.
- Break existing modules or workflows.
- Create dummy functionality that only looks operational.
- Present simulated signals as genuine discoveries.

Reuse the existing database and architecture. Extend them only when necessary, using proper migrations and backward-compatible changes.

If an essential dependency from Module 1 is missing, document it and implement the safest compatible solution.

---

# 2. MODULE OBJECTIVE

The Signal Engine must continuously identify events and changes that could create a commercial real estate opportunity.

It should answer six questions for every meaningful signal:

1. What happened?
2. Which company, person, property or location does it affect?
3. Why could it matter for commercial real estate?
4. What evidence supports this interpretation?
5. What remains unconfirmed?
6. What should I do next?

The engine should convert scattered information into structured, actionable intelligence.

Example:

A company announces that it is expanding its Pune operations.

The system should:
- Identify the announcement.
- Resolve the correct company record.
- Identify the relevant Pune business presence.
- Search existing occupancy and lease records.
- Check whether a lease event is approaching.
- Identify relevant decision-makers already in the database.
- Evaluate whether the expansion could create a space requirement.
- Identify missing information.
- Create a signal card.
- Recommend an appropriate next action.
- Allow the user to approve, dismiss, snooze or investigate the signal.

Important: An expansion announcement is evidence of expansion, not proof that the company needs additional office space.

---

# 3. SIGNAL CATEGORIES

Build the engine to detect the following signal categories.

## A. Company Expansion Signals

Identify:
- New office announcements.
- New geographical locations.
- Pune office expansion.
- New business units.
- GCC establishment or expansion.
- Increased local hiring.
- Large hiring campaigns.
- New operational facilities.
- Increased business commitments.
- New projects requiring additional workforce.
- Announcements of major investment.
- Business growth in an existing location.

For every signal, identify:
- Company.
- Business unit, if known.
- Relevant geography.
- Event date.
- Source date.
- Potential CRE implication.
- Evidence.
- Unverified assumptions.

## B. Company Restructuring Signals

Identify:
- Office consolidation.
- Office closures.
- Mergers and acquisitions.
- Business-unit restructuring.
- Workforce reductions.
- Cost-reduction initiatives.
- Hybrid-work policy changes.
- Relocation announcements.
- Portfolio optimisation.
- Office footprint reduction.
- Outsourcing or operational restructuring.

Determine whether the event could lead to:
- Space reduction.
- Lease termination.
- Relocation.
- Consolidation.
- Subleasing.
- Renewal negotiations.
- A change in office requirements.

Do not assume that layoffs automatically mean office-space reduction.

## C. Lease and Property Signals

Use the existing database to identify:
- Upcoming lease expiries.
- Lock-in completion.
- Notice-period windows.
- Break options.
- Renewal opportunities.
- Upcoming handovers.
- Known availability changes.
- Occupancy changes.
- Expiring managed-office agreements.
- Potential relocation windows.

Distinguish carefully between:
- Lease expiry.
- Lock-in end.
- Notice deadline.
- Break option.
- Renewal date.
- Handover date.

Do not treat these events as interchangeable.

A past lease expiry must not automatically create a claim that a company currently needs office space. Instead, generate a verification task.

## D. Commercial Value Signals

Identify opportunities where:
- A company may be paying higher rent than comparable alternatives.
- A more economical property is available in the same micro-market.
- A nearby property offers better amenities at a comparable cost.
- A company could improve its office without increasing its overall occupancy cost.
- A company could reduce total occupancy expenditure.
- A better space configuration could improve capacity.
- A managed office may be commercially preferable to conventional leasing.

Every recommendation must include:
- Existing information.
- Comparison basis.
- Potential benefit.
- Missing information.
- Verification requirements.

Never compare incompatible rent bases or unsupported commercial figures.

## E. Leadership and Decision-Maker Signals

Identify changes involving:
- Corporate real estate leaders.
- Facilities leaders.
- Administration heads.
- Finance leaders.
- HR leaders.
- Procurement leaders.
- Business heads.
- GCC leaders.
- Authorised signatories.

When a person changes employer:
- Match the person against existing records.
- Preserve their existing person identity.
- Create an unverified employment observation.
- Suggest an employment update for review.
- Preserve historical employment and interaction history.
- Create appropriate relationship-review tasks for the previous and new organisations.

Never automatically transfer confidential company information or opportunities to the new employer.

## F. Infrastructure and Micro-Market Signals

Monitor relevant changes such as:
- New metro connectivity.
- Road infrastructure projects.
- Airport connectivity developments.
- New commercial developments.
- New business districts.
- Upcoming office supply.
- Infrastructure delays.
- Changes affecting accessibility.
- New amenities and ecosystem developments.
- Changes that could make one micro-market more attractive than another.

Evaluate the potential effect on:
- Existing properties.
- Nearby commercial buildings.
- Occupier preferences.
- Rental attractiveness.
- Accessibility.
- Future office demand.

Separate confirmed infrastructure facts from forecasts and interpretations.

## G. Macro and Industry Signals

Monitor developments that may indirectly affect CRE decisions:
- Industry expansion or contraction.
- GCC investment trends.
- Interest-rate changes.
- Corporate cost-cutting.
- Major sector hiring trends.
- Economic and regulatory changes.
- Technology-sector developments.
- Office attendance and workplace trends.

Only surface developments with a plausible connection to the CRE business.

---

# 4. DATA SOURCES AND SOURCE MANAGEMENT

Create a source integration framework that supports multiple sources without hardcoding the engine to one provider.

Potential source categories:

1. Official company websites.
2. Company press releases.
3. Company announcements.
4. Regulatory and corporate filings.
5. Permitted news sources.
6. Approved business news sources.
7. Official infrastructure authorities.
8. Licensed CRE data.
9. Internal company research.
10. Existing database records.
11. User-uploaded research documents.
12. Approved professional-network sources.
13. Approved hiring and job-posting sources.
14. User-submitted observations.

## Source integration architecture

Build a reusable source adapter interface.

Every adapter should support, where applicable:
- Source identification.
- Authentication.
- Permission validation.
- Data retrieval.
- Parsing.
- Normalisation.
- Deduplication.
- Entity resolution.
- Evidence creation.
- Error handling.
- Retry handling.
- Rate-limit management.
- Last successful sync.
- Usage tracking.

Do not assume unrestricted access to LinkedIn, WhatsApp, email inboxes or paid databases.

Implement manual capture and upload adapters when direct integration is unavailable.

Use only permitted and authorised sources. Respect source licensing, access restrictions, retention rules and workspace entitlements.

Maintain a source registry containing:
- Source name.
- Source type.
- Access method.
- Permission status.
- Permitted purposes.
- Retention restrictions.
- Refresh frequency.
- Last successful retrieval.
- Connection status.

If a source cannot be accessed, clearly show that it is unavailable rather than inventing data.

---

# 5. SIGNAL PROCESSING PIPELINE

Implement the following pipeline:

**Source Discovery → Data Retrieval → Parsing → Normalisation → Deduplication → Entity Resolution → Evidence Extraction → Signal Detection → CRE Relevance Assessment → Confidence Assessment → Review → Action**

Each stage must have an identifiable status and error-handling mechanism.

Suggested processing statuses:

- Discovered
- Retrieved
- Parsed
- Normalised
- Duplicate
- Entity unresolved
- Evidence extracted
- Signal candidate
- Assessment pending
- Review required
- Approved
- Rejected
- Converted to action
- Archived
- Failed

Keep the original source material and its provenance.

Every extracted signal must be traceable to its supporting evidence.

Do not silently discard records that cannot be resolved.

---

# 6. ENTITY RESOLUTION

Connect detected signals to the correct records in Module 1.

Resolve:
- Legal entities.
- Parent companies.
- Subsidiaries.
- Brands.
- Business units.
- People.
- Buildings.
- Locations.
- Existing requirements.
- Existing opportunities.

Matching rules:

1. Use approved external-ID mappings first.
2. Use exact approved aliases within compatible scope.
3. Use multiple consistent identifiers.
4. Use fuzzy matching only to suggest possible matches for review.

A person's name alone must never trigger an automatic identity merge.

Do not merge companies simply because their names are similar.

When the correct entity cannot be established:
- Mark the signal as unresolved.
- Show possible matches.
- Explain why the match is uncertain.
- Allow the user to select the correct record.
- Preserve the original source identity.

All material identity changes must follow the existing approval and audit controls.

---

# 7. SIGNAL INTELLIGENCE AND CRE RELEVANCE

The engine must distinguish between:

### Confirmed fact
Directly supported by reliable evidence.

### Inference
A reasonable interpretation of one or more facts.

### Hypothesis
A possible business opportunity that requires validation.

### Unknown
Information that is not available.

For every signal, calculate or derive:

- Event category.
- Company relevance.
- Geographic relevance.
- CRE relevance.
- Timing relevance.
- Evidence strength.
- Source reliability.
- Information freshness.
- Potential commercial impact.
- Missing information.
- Suggested next action.

Use configurable rules rather than embedding arbitrary scoring logic throughout the codebase.

Do not allow an AI model to override deterministic business rules.

A funding announcement alone must not automatically create an office requirement.

Hiring signals must be checked for:
- Hiring location.
- Remote or hybrid arrangements.
- Role type.
- Likely occupancy implications.
- Existing office capacity.

Multiple articles repeating the same announcement must not be counted as independent confirmations.

---

# 8. SIGNAL GROUPING AND DEDUPLICATION

One business event may appear in several publications.

The system must identify when multiple sources refer to the same underlying event.

Example:

A company announces a new Pune GCC.

The same announcement appears in:
- Company press release.
- Business newspaper.
- Industry publication.
- Hiring announcement.
- Social-media post.

These should be grouped into one underlying signal with multiple supporting evidence records.

Display:
- Primary event.
- Supporting sources.
- First detected date.
- Most recent confirmation.
- Independent evidence count.
- Contradictory evidence.
- Confidence assessment.

Do not delete duplicate source records. Preserve them as evidence while avoiding duplicate commercial signals.

---

# 9. SIGNAL CARD — MAIN USER INTERFACE

Build a polished, professional Signal Engine interface consistent with the existing application.

Create a central signal dashboard.

Each signal card should display:

**Company:** Company name  
**Signal:** Pune expansion detected  
**Category:** Expansion  
**Location:** Pune  
**Detected:** Date  
**Event date:** Date, if known  
**Evidence:** Source and supporting information  
**CRE relevance:** Why this could matter  
**Confidence:** Evidence-strength assessment  
**Status:** New / Reviewing / Approved / Dismissed / Snoozed  
**Recommended action:** What should happen next

Provide expandable details:

1. What happened?
2. Why it matters.
3. Supporting evidence.
4. Related company records.
5. Known office locations.
6. Existing occupancy information.
7. Relevant lease events.
8. Related contacts.
9. Existing requirements.
10. Counter-evidence.
11. Missing information.
12. Suggested next steps.

Provide actions:

- Approve.
- Reject.
- Dismiss.
- Snooze.
- Investigate.
- Assign to me.
- Create task.
- Link to existing opportunity.
- Create opportunity proposal.
- Mark as already known.
- Add supporting evidence.
- Correct company association.

All actions must be connected to actual backend functionality and persisted in the database.

---

# 10. SIGNAL DASHBOARD AND FILTERS

Build the following views:

### A. All Signals
All detected signals with sorting and filtering.

### B. High-Priority Signals
Signals that deserve immediate attention based on urgency, relevance and evidence.

### C. Expansion
Companies showing credible growth or expansion indicators.

### D. Restructuring
Companies showing consolidation, cost reduction or relocation indicators.

### E. Lease Events
Upcoming lease-related events requiring verification or action.

### F. Commercial Opportunities
Potential cost-saving and value-upgrade opportunities.

### G. Leadership Changes
Relevant changes in company decision-makers.

### H. Infrastructure
Developments affecting properties and micro-markets.

### I. Unverified
Signals requiring additional research or confirmation.

### J. Dismissed and Snoozed
Historical signals and reasons for dismissal or postponement.

Provide filters for:
- Company.
- Industry.
- Micro-market.
- Signal category.
- Event date.
- Detection date.
- Evidence freshness.
- Confidence.
- Urgency.
- Signal status.
- Source.
- Assigned user.

Support search across signal descriptions, company names, locations and evidence.

---

# 11. RELATIONSHIP AND EXISTING DATABASE INTEGRATION

The Signal Engine must use Module 1 as its shared memory.

For each relevant signal, retrieve permitted information about:

- Company profile.
- Parent and subsidiary relationships.
- Existing office locations.
- Occupancy.
- Lease information.
- Requirements.
- Decision-makers.
- Existing contacts.
- Relationship strength.
- Past interactions.
- Previous transactions.
- Existing opportunities.
- Relevant tasks.
- Property records.

Example:

A company has announced expansion in Pune.

The engine discovers:
- The company already occupies an office in Kharadi.
- Its known lease expiry is in 14 months.
- A relevant facilities contact is already in the database.
- The last interaction occurred three months ago.
- The current office capacity is not verified.

The system should generate a contextual signal:

"Potential Pune expansion. Existing Kharadi occupancy and a known facilities contact are recorded. Current spare capacity is unverified. Recommended action: reconnect with the facilities contact and confirm whether the expansion can be accommodated in the existing premises."

Do not invent a requirement, budget, area or move-in date.

---

# 12. NEXT-ACTION GENERATION

Every actionable signal should have a recommended next step.

Examples:

| Signal | Suggested next action |
|---|---|
| New Pune GCC announcement | Verify office strategy and expected team size |
| Lease expiry approaching | Confirm renewal or relocation plans |
| New facilities head appointed | Research the person's responsibilities and relationship path |
| Office consolidation | Verify whether space reduction is planned |
| Major local hiring | Confirm hiring location and office attendance |
| Better-value building identified | Validate availability and compare total occupancy costs |
| New metro connectivity | Assess potential effect on relevant micro-markets |

The engine may suggest:
- Research task.
- Contact verification.
- Meeting preparation.
- Requirement discovery.
- Property research.
- Lease-event verification.
- Relationship follow-up.

Task creation must use the existing task system.

Do not automatically send emails, messages or external communications.

---

# 13. PRIORITY AND URGENCY

Create a configurable signal-priority model.

Assess:
- Event timing.
- CRE relevance.
- Evidence strength.
- Geographic relevance.
- Existing relationship access.
- Commercial potential.
- Information freshness.
- Required verification.

Keep signal urgency separate from lead-priority scoring and closing probability.

A signal should not be considered high priority simply because an AI model assigns it a high confidence score.

Show the reason for every priority classification.

Allow the user to override priority with:
- Reason.
- User.
- Date.
- Review date.

Use the existing approval and audit mechanisms.

---

# 14. COUNTER-EVIDENCE AND FALSE-POSITIVE CONTROL

The engine must actively look for reasons why a signal may not represent a CRE opportunity.

Examples:

- Hiring is outside Pune.
- Hiring is entirely remote.
- Expansion is already accommodated in existing space.
- A company announcement refers to an existing office.
- A lease event is outdated.
- A property is no longer available.
- Multiple articles refer to one announcement.
- A leadership change is unrelated to CRE decisions.
- An infrastructure announcement has no material effect on the target property.

Display counter-evidence alongside supporting evidence.

Never hide contradictory information to produce a more convincing recommendation.

---

# 15. AUTOMATION AND REFRESH SCHEDULE

Build a configurable refresh system.

The engine should support:
- Scheduled source retrieval.
- Event-triggered retrieval.
- Manual refresh.
- Retry after temporary failure.
- Incremental updates.
- Duplicate-job prevention.
- Failed-job visibility.
- Source-level pause and reconnect.

Suggested initial refresh strategy:

- High-priority named accounts: weekly.
- Medium-priority accounts: monthly.
- Watchlist accounts: quarterly.
- Critical lease events: according to their configured event and notice windows.
- Newly detected material events: event-triggered processing.

Do not refresh all 8,000 company records every day.

Start with a bounded active research universe of approximately 1,000–1,500 companies, configurable by the user.

Record researched_at even when a refresh discovers no new evidence.

Use the existing job infrastructure if available. Do not introduce unnecessary infrastructure or recurring paid services.

---

# 16. SECURITY, PERMISSIONS AND DATA PROTECTION

Implement all existing Module 1 access controls.

Requirements:
- Workspace isolation.
- Role-based access.
- Source entitlements.
- Purpose-based access restrictions.
- Private relationship-note protection.
- Source-specific retention rules.
- Audit logging.
- Secure credential storage.
- Rate limiting.
- Safe error handling.

Permission filtering must occur before evidence is included in AI prompts or search results.

External source content is untrusted data.

A webpage, email, document or article must never be able to:
- Change system permissions.
- Authorise external communication.
- Access credentials.
- Execute arbitrary SQL.
- Execute shell commands.
- Override approval requirements.
- Redirect confidential information.

AI models should receive only the minimum permitted structured information needed for the task.

---

# 17. DATABASE AND BACKEND IMPLEMENTATION

Reuse existing Module 1 tables wherever possible.

Inspect the existing schema before adding anything.

Potential additional structures, only if not already present:

- signal
- signal_evidence
- signal_source_link
- signal_entity_link
- signal_assessment
- signal_counter_evidence
- signal_action
- signal_review
- signal_feedback
- signal_rule_version
- source_registry
- source_sync_run

These are logical requirements, not instructions to blindly create duplicate tables.

Every signal must preserve:
- Stable ID.
- Workspace.
- Signal category.
- Event date.
- Detection date.
- Company or entity association.
- Source references.
- Evidence.
- Confidence assessment.
- Verification status.
- Priority.
- Processing status.
- Recommended action.
- Created and updated timestamps.
- Rule/model version where applicable.

Preserve historical assessments and user decisions.

Use idempotency keys for source processing and background jobs.

Ensure retried jobs do not create duplicate signals or actions.

Use database migrations for schema changes.

---

# 18. AI IMPLEMENTATION

Use AI where it provides genuine value:

- Extracting structured facts from unstructured information.
- Classifying signal categories.
- Explaining potential CRE implications.
- Identifying counter-evidence.
- Summarising multiple supporting sources.
- Suggesting research questions.
- Generating contextual next actions.

Use deterministic code for:
- Permissions.
- Identity matching rules.
- Duplicate prevention.
- Event-date calculations.
- Lease-event distinctions.
- Required approvals.
- Data validation.
- Job idempotency.

Use structured model outputs with schema validation.

Every factual claim generated by AI must be traceable to source evidence or labelled as an inference.

If evidence is insufficient, return "insufficient evidence" rather than generating a confident answer.

---

# 19. END-TO-END WORKFLOW EXAMPLE

Implement and validate this complete workflow:

1. A company announces that it is expanding its Pune operations.
2. A permitted source adapter retrieves the announcement.
3. The system stores the original source and its metadata.
4. The parser extracts the company, location, event date and announcement details.
5. Entity resolution identifies the existing company record.
6. The engine checks for duplicate announcements.
7. The system retrieves the company's existing occupancy and lease records.
8. The engine identifies a relevant contact.
9. It assesses whether the announcement has a credible CRE implication.
10. It checks for counter-evidence.
11. It generates a structured signal.
12. The signal appears on the dashboard.
13. The user opens the signal and reviews its evidence.
14. The user approves it.
15. The system creates a research or follow-up task.
16. The task appears in the existing task management system.
17. The user completes the task and records the outcome.
18. The signal and resulting actions remain linked in the company's history.

The system must also support rejection, correction, snoozing and later re-evaluation.

---

# 20. TESTING AND ACCEPTANCE CRITERIA

Test the complete module through its actual UI and backend.

Cover:

### Functional testing
- Every signal category.
- Source ingestion.
- Source failures.
- Entity resolution.
- Duplicate detection.
- Signal grouping.
- Evidence extraction.
- Counter-evidence.
- Confidence assessment.
- Priority classification.
- Signal review.
- Task creation.
- Database persistence.
- Search and filters.
- Historical signal records.

### Data integrity
- No duplicate signals from retried jobs.
- No duplicate evidence loss.
- No incorrect company merges.
- No invented lease events.
- No fabricated requirements.
- No missing source provenance.
- No loss of historical observations.

### Security
- Workspace isolation.
- Role permissions.
- Source entitlements.
- Private-note restrictions.
- Prompt-injection resistance.
- No unauthorised outbound communication.

### Reliability
- Retry handling.
- Idempotency.
- Partial source failures.
- Job monitoring.
- Manual refresh.
- Recovery after interrupted processing.

### User experience
- Clear signal cards.
- Useful filters.
- Evidence visibility.
- Clear confidence and verification labels.
- Responsive interface.
- Loading, empty and error states.
- Clear approve, reject and snooze actions.

Use synthetic test data and authorised test sources. Never fabricate a successful source integration.

Do not mark a test as passed unless it has actually been executed and verified.

---

# 21. FINAL DELIVERABLES

When implementation is complete, provide:

1. Architecture of the implemented Signal Engine.
2. Existing Module 1 components reused.
3. New database changes and migrations.
4. Backend APIs and services created.
5. Source adapters implemented.
6. AI workflows and prompts implemented.
7. UI screens and components created.
8. Automation and refresh configuration.
9. Security and permission implementation.
10. Test cases and actual test results.
11. Known limitations and unavailable integrations.
12. Outstanding dependencies.
13. Deployment instructions.
14. Rollback instructions.
15. Recommended next development steps.

Clearly distinguish:
- Fully implemented.
- Partially implemented.
- Requires credentials or external access.
- Not implemented.
- Blocked by missing dependencies.

---

# FINAL DEVELOPMENT PRINCIPLE

The Signal Engine must not become another generic news aggregator.

It must be a **commercial real estate intelligence engine** that understands the relationship between companies, people, office occupancy, lease events, properties, infrastructure and potential transactions.

Its purpose is not to show the user more information.

Its purpose is to help the user discover:

- Which company might need CRE advice?
- Why might it need advice now?
- What evidence supports that possibility?
- Who should I speak to?
- What should I verify?
- What should I do next?

Build this as an integrated module inside the existing application, using Module 1 as its shared memory and respecting all existing security, approval and data-integrity rules.

Do not stop after producing a plan. Inspect, implement, test, fix and document the working module.