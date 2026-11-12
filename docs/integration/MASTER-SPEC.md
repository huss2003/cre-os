# CRE AI OPERATING SYSTEM
## MASTER INTEGRATION, FUNCTIONALITY, AUTOMATION AND TESTING SPECIFICATION

### MODULES INCLUDED

1. Module 1 – Database
2. Module 2 – Signal Engine
3. Module 3 – Scoring Engine
4. Module 4 – Contact Enrichment
5. Module 5 – Outreach Engine
6. Module 7 – Meeting Intelligence
7. Module 8 – Deal Toolkit
8. Module 9 – Orchestrator
9. Module 10 – Input Engine
10. Module 12 – Supercharged Assistant
11. Module 13 – Intelligence Layer
12. Module 14 – Property Supply and Matching
13. Module 15 – Lease Lifecycle Management
14. Module 16 – Transaction Execution and Negotiation

---

# PART 1: OVERALL PROJECT OBJECTIVE

Develop, integrate, test and optimise the complete CRE AI Operating System.

The system must operate as one connected commercial real estate advisory platform.

It must support the complete business lifecycle:

- Market intelligence.
- Company identification.
- Business signal detection.
- Lead prioritisation.
- Contact discovery.
- Relationship management.
- Outreach preparation.
- Meeting preparation.
- Meeting intelligence.
- Requirement discovery.
- Property supply management.
- Property matching.
- Commercial analysis.
- Negotiation.
- Transaction execution.
- Lease management.
- Renewal opportunities.
- Relationship development.
- Business performance tracking.

The system must understand how these activities relate to one another.

A user should never need to manually operate 14 separate modules to complete one business activity.

A single input or event must be able to trigger all relevant downstream processes through controlled workflows.

The ultimate objective is to create an AI-powered CRE advisory operating system that helps the user identify opportunities, develop relationships, advise clients, execute transactions and manage ongoing business relationships.

## CENTRAL OPERATING PRINCIPLE

EVERY MEANINGFUL PIECE OF INFORMATION SHOULD IMPROVE AT LEAST ONE OF THE FOLLOWING:

- Company records.
- Contact records.
- Property records.
- Occupancy information.
- Requirements.
- Relationships.
- Commercial intelligence.
- Decisions.
- Transactions.
- Next actions.

---

# PART 2: NON-NEGOTIABLE PRODUCT REQUIREMENTS

### 2.1 One Connected Application

All modules must operate within the existing application.

Do not create separate applications or isolated databases for individual modules.

Use shared services, APIs, database records, event processing and common authentication.

### 2.2 Four Main User Entry Points

The user experience must revolve around four primary entry points:

1. TODAY
2. ASK
3. CAPTURE
4. REVIEW

#### TODAY

Show:
- Daily business plan.
- Meetings.
- Priority accounts.
- Important signals.
- Follow-ups.
- Overdue commitments.
- Active transactions.
- Important lease events.
- Actions requiring attention.

#### ASK

Allow natural-language interaction with the entire CRE system.

Examples:
- Which companies should I approach today?
- Which clients have leases expiring next year?
- Show me available 20,000 SF offices in Kharadi.
- What is blocking my active transactions?
- Prepare me for tomorrow's meeting.
- Which contacts can introduce me to this company?

#### CAPTURE

Allow the user to submit:
- Text.
- Voice notes.
- Images.
- Screenshots.
- Business cards.
- Documents.
- Spreadsheets.
- Permitted meeting recordings.

#### REVIEW

Display:
- Proposed database changes.
- Uncertain information.
- Duplicate records.
- Material commercial updates.
- Approval requests.
- Failed workflows.
- Conflicting evidence.
- Actions requiring human judgement.

The complexity of the underlying modules must remain hidden unless the user needs to inspect it.

### 2.3 Minimal User Effort

The system must:
- Reuse existing information.
- Prefill known fields.
- Avoid repetitive questions.
- Capture information once.
- Automatically distribute relevant information.
- Generate useful next actions.
- Explain what has been completed.
- Show what remains pending or blocked.

### 2.4 Human Control

The following actions must remain controlled:

- External emails.
- External messages.
- Invitations.
- Commercial commitments.
- Material contractual changes.
- Important identity merges.
- Sensitive relationship information sharing.
- Publication of external content.

AI must not bypass configured approval requirements.

External communications must be reviewed and manually sent by the user.

---

# PART 3: MODULE-WISE FUNCTIONAL REQUIREMENTS

## MODULE 1 – DATABASE
### The Connected Memory of the Business

PURPOSE:

Maintain a reliable, searchable and historically accurate record of the CRE business.

### A. Company Records

Maintain:

- Legal entity.
- Parent group.
- Subsidiaries.
- Brands.
- Industry.
- Business activity.
- Headquarters.
- India presence.
- Pune locations.
- Existing offices.
- Previous transactions.
- Previous broking companies.
- Individual brokers involved in previous transactions.
- Decision-makers.
- Corporate CRM references.
- Relationship ownership.

### B. Occupancy Records

Maintain:

- Company.
- Building.
- Floor.
- Unit.
- Occupied area.
- Area measurement type.
- Number of seats.
- Occupancy type.
- Lease commencement.
- Lease expiry.
- Available lease information.
- Occupancy history.

### C. Person Records

Maintain:

- Name.
- Contact details.
- Designation.
- Department.
- Decision authority.
- Current employer.
- Previous employers.
- Employment history.
- Communication preferences.
- Relationship status.
- Interaction history.
- Business preferences.
- Relevant voluntarily shared personal context.
- Relevant occasions and commitments.

Relationship status must support configurable categories such as:

- Not interacted.
- Spoke on call.
- Met once.
- Met multiple times.
- Good relationship.
- Not interested.
- Strong professional relationship.

### D. Property Records

Maintain:

- Developer.
- Property name.
- Alternate names.
- Location.
- Year of OC, where verified.
- Number of floors.
- Floor size.
- Average rental.
- Lowest rental.
- Highest rental.
- Total vacancy, where supported.
- Building tenants.
- Technical specifications.
- Certifications.
- Building advantages.
- Building disadvantages.
- Historical quotations.
- Supply information.

### E. Requirement Records

Support multiple independent requirements for the same company.

Examples:
- GCC expansion.
- Existing office renewal.
- Temporary managed office.
- Relocation.
- Additional office requirement.
- Investment requirement.

Maintain:
- Area.
- Location.
- Budget.
- Timeline.
- Property type.
- Occupancy requirements.
- Commercial preferences.
- Decision-makers.
- Requirement status.
- Requirement history.

### F. Transaction Records

Maintain:
- Parties.
- Service type.
- Mandate position.
- Commercial terms.
- Stages.
- Approvals.
- Documents.
- Fees.
- Attribution.
- Transaction history.

### G. Relationship Connections

Maintain:
- Who introduced whom.
- Who knows a landlord.
- Who previously worked with a client.
- Who can provide a credible introduction.
- Relationship warmth.
- Introduction history.
- Relevant professional connections.

### H. Interaction History

Capture:
- Calls.
- Emails.
- Meetings.
- Messages.
- Site visits.
- Promises.
- Objections.
- Documents.
- Decisions.

Every interaction must link to the relevant person, company, property, requirement or transaction.

### I. Market Records

Maintain:
- Historical transactions.
- Rental observations.
- Property supply.
- Absorption.
- Infrastructure developments.
- Market observations.
- Source and observation dates.

### J. Search

Support complex queries.

Example:

"Show companies occupying 15,000–40,000 SF in Kharadi with a lease event next year and a contact I already know."

### Mandatory Database Rules

- Stable IDs for companies, contacts and buildings.
- Duplicate prevention.
- Historical value preservation.
- Source references.
- Observation dates.
- Verification status.
- Distinction between confirmed facts, estimates, assumptions and conflicting claims.
- Corporate account ownership.
- Information-sharing restrictions.
- Employment history preservation.

VISIBLE RESULT:

A complete account view showing people, occupancy, requirements, history, opportunities and next actions.

---

## MODULE 2 – SIGNAL ENGINE
### Finding Reasons a Company May Need Real Estate Advice

PURPOSE:

Identify commercially relevant changes that may create CRE advisory opportunities.

### A. Monitoring

Monitor permitted sources:

- News.
- Company announcements.
- Hiring activity.
- Funding announcements.
- Corporate filings.
- Internal research.
- Lease-event data.
- Infrastructure developments.
- Other permitted web sources.

### B. Expansion Signals

Detect:

- New locations.
- Business-unit growth.
- GCC plans.
- Local hiring.
- New leadership.
- Larger operating commitments.
- New business divisions.
- Increased employee requirements.

### C. Restructuring Signals

Detect:

- Consolidation.
- Acquisitions.
- Office closures.
- Cost reduction.
- Hybrid-work changes.
- Portfolio reviews.
- Business restructuring.

### D. Property Triggers

Detect:

- Lease expiry.
- Lock-in completion.
- Notice windows.
- Break options.
- Space constraints.
- Upcoming handovers.
- Occupancy changes.

### E. Commercial Triggers

Detect:

- Higher current occupancy costs.
- Cheaper alternatives in the same micro-market.
- Better buildings at similar costs.
- Better amenities at similar costs.
- Opportunities for cost optimisation.

### F. Leadership Signals

Identify changes involving:

- Corporate real estate.
- Facilities.
- Administration.
- Finance.
- HR.
- Procurement.
- Business leadership.

### G. Infrastructure and Market Signals

Identify:

- New infrastructure projects.
- Transport developments.
- Changes in location attractiveness.
- New commercial supply.
- Micro-market changes.
- Economic developments affecting CRE demand.

### H. Signal Processing

For every signal:

- Identify the correct legal entity.
- Identify the business unit.
- Identify the relevant city.
- Identify the affected location.
- Combine related evidence.
- Identify duplicate reporting.
- Capture counter-evidence.
- Identify unknowns.
- Assess potential CRE relevance.

### I. Signal Card

Every signal must show:

1. What happened?
2. Which company is affected?
3. Which location is affected?
4. Why could it matter for real estate?
5. What evidence supports the interpretation?
6. What remains unconfirmed?
7. What should the user do next?

### Mandatory Rules

- Funding does not automatically indicate an office requirement.
- Hiring must be checked for location and occupancy implications.
- Repeated articles about one announcement are not independent evidence.
- Signals must distinguish observed facts from hypotheses.
- Active accounts receive more frequent monitoring than distant prospects.

VISIBLE RESULT:

A prioritised list of evidence-backed business signals with suggested next actions.

---

## MODULE 3 – SCORING ENGINE
### Deciding What Deserves Attention

PURPOSE:

Help the user allocate effort to the most commercially relevant accounts, requirements and transactions.

### A. Separate Assessments

Maintain separate scores for:

1. Lead Priority.
2. Requirement Readiness.
3. Deal Health.
4. Evidence Completeness.
5. Relationship Strength.

Do not combine all five into one unexplained score.

### B. Default Lead Priority Model

Use configurable initial weights:

| Parameter | Weight |
|---|---:|
| Timing | 25% |
| Need or trigger strength | 25% |
| Relationship access | 20% |
| Commercial fit | 15% |
| Engagement | 10% |
| Evidence freshness | 5% |

These are initial defaults, not permanent assumptions.

### C. Requirement Readiness

Assess:
- Requirement clarity.
- Area confirmation.
- Location confirmation.
- Budget confirmation.
- Timeline.
- Decision-maker identification.
- Approval process.
- Commercial feasibility.
- Property availability.

### D. Deal Health

Assess:
- Transaction progress.
- Stakeholder engagement.
- Outstanding issues.
- Approval status.
- Commercial gaps.
- Document readiness.
- Timeline risk.
- Transaction blockers.

### E. Evidence Completeness

Assess:
- Source reliability.
- Verification status.
- Data freshness.
- Missing information.
- Conflicting information.
- Supporting documents.

### F. Scoring Rules

- Prioritise the 3–12-month opportunity window.
- Elevate genuinely urgent opportunities.
- Default occupier range: more than 5,000 SF and less than 200,000 SF.
- Allow explicit exceptions.
- Use separate rules for investment and other services.
- Unknown is not bad.
- Explain material score changes.
- Allow manual priority overrides with reasons and review dates.
- Preserve strategically valuable relationships.
- Keep priority separate from statistical probability of closing.

### G. Score Change History

Record:
- Previous score.
- New score.
- Change reason.
- Supporting evidence.
- Timestamp.
- Triggering event.

VISIBLE RESULT:

A ranked list showing why now, why this account, what is missing and the next best action.

---

## MODULE 4 – CONTACT ENRICHMENT
### Identifying the Actual Buying Group

PURPOSE:

Identify people who influence, approve and execute CRE decisions.

### A. Buying Group Identification

Identify:

- Corporate real estate.
- Facilities.
- Administration.
- Procurement.
- Finance.
- HR.
- Business leadership.
- Authorised signatories.
- Regional decision-makers.
- Global approvers.
- Local users.

### B. External Stakeholders

Identify:

- Landlords.
- Developers.
- Asset managers.
- Property managers.
- Managed office operators.
- Coworking operators.
- Fit-out partners.
- Legal advisers.
- Introducing brokers.

### C. Contact Discovery

Support approved enrichment providers such as:

- Apollo.
- Lusha.
- Hunter.
- Other configurable providers.

Providers must operate behind an interchangeable enrichment interface.

### D. Contact Information

Maintain:

- Name.
- Designation.
- Company.
- Department.
- Location.
- Business email.
- Phone.
- Contact type.
- Source.
- Verification status.
- Last verification date.

Distinguish:

- Corporate switchboard.
- Direct office number.
- Mobile number.

### E. Buying Group Mapping

Show:
- Decision-makers.
- Influencers.
- Approvers.
- Users.
- External advisers.
- Introduction paths.
- Relationship warmth.

### F. Provider Controls

- Usage limits.
- Cost tracking.
- Source tracking.
- Duplicate prevention.
- Reuse existing information.
- Refresh strategically important contacts.
- Avoid paying repeatedly for current information.

### Mandatory Rules

Do not assume unrestricted access to third-party platforms or APIs.

Use only permitted integrations and provider capabilities.

Do not present email verification as a guarantee of delivery or response.

VISIBLE RESULT:

A stakeholder map showing who matters, what they influence, how to reach them and the strongest available introduction route.

---

## MODULE 5 – OUTREACH ENGINE
### Creating Relevant Business Conversations

PURPOSE:

Prepare relevant, contextual and personalised communications based on actual CRE opportunities and relationship history.

### A. Outreach Scenarios

Support outreach for:

- Lease renewals.
- Expansion.
- Consolidation.
- Relocation.
- GCC establishment.
- Managed office requirements.
- Cost optimisation.
- Property alternatives.
- New leadership.
- Infrastructure developments.
- Other relevant business triggers.

### B. Contextual Drafting

Retrieve:
- Company background.
- Relevant business signals.
- Contact designation.
- Previous interactions.
- Relationship strength.
- Known preferences.
- Existing objections.
- Current requirements.
- Relevant property information.

### C. Communication Types

Generate drafts for:

- Email.
- LinkedIn messages.
- WhatsApp messages.
- Meeting requests.
- Follow-ups.
- Introductions.
- Post-meeting summaries.
- Property proposals.
- Renewal discussions.

### D. Outreach Personalisation

Adapt:
- Tone.
- Message length.
- Business context.
- Value proposition.
- CTA.
- Contact seniority.
- Relationship stage.

### E. Outreach Pipeline

Track:
- Identified.
- Research completed.
- Draft prepared.
- Awaiting review.
- Approved.
- Manually sent.
- Replied.
- Meeting scheduled.
- Follow-up required.
- Not interested.
- Nurture.

### F. Follow-up Management

- Track sent dates.
- Track responses.
- Identify overdue follow-ups.
- Generate follow-up drafts.
- Avoid repetitive outreach.
- Respect communication preferences.
- Maintain communication history.

### Mandatory Rules

- Never send external communication automatically.
- Never invent personalisation.
- Use evidence-backed business context.
- Prevent duplicate outreach.
- Respect opt-outs and communication restrictions.

VISIBLE RESULT:

A contextual outreach workspace with ready-to-review communications and a clear follow-up pipeline.

---

## MODULE 7 – MEETING INTELLIGENCE
### Preparing, Understanding and Following Through on Meetings

PURPOSE:

Turn meetings into structured business intelligence and actionable follow-ups.

### A. Meeting Preparation

Retrieve:
- Company profile.
- Contact profiles.
- Previous interactions.
- Existing requirements.
- Property information.
- Previous objections.
- Pending commitments.
- Current opportunities.
- Relevant signals.
- Commercial context.

Generate:
- Meeting brief.
- Attendee information.
- Suggested questions.
- Discussion objectives.
- Potential concerns.
- Important unknowns.
- Desired outcomes.

### B. Meeting Capture

Support:
- Manual notes.
- Voice notes.
- Permitted recordings.
- Uploaded transcripts.
- Meeting documents.

### C. Transcription and Analysis

Extract:
- Participants.
- Topics.
- Requirements.
- Budget.
- Location preferences.
- Area.
- Timelines.
- Decision-makers.
- Objections.
- Commercial discussions.
- Commitments.
- Follow-up activities.
- Unanswered questions.

### D. Meeting Summary

Generate:
- Executive summary.
- Important discussion points.
- Confirmed information.
- Estimates.
- Assumptions.
- Decisions.
- Objections.
- Commitments.
- Outstanding questions.
- Next actions.

### E. Post-Meeting Processing

- Link the meeting to the correct company.
- Link participants to contact records.
- Update relevant requirements.
- Update interaction history.
- Identify potential signals.
- Reassess relevant scores.
- Create proposed tasks.
- Prepare follow-up drafts.
- Notify the Orchestrator.

### F. Meeting History

Maintain a chronological record of meetings and outcomes.

### Mandatory Rules

- Distinguish what was actually said from AI interpretation.
- Preserve source timestamps where available.
- Do not invent missing attendees.
- Flag uncertain transcription.
- Require review for material updates.

VISIBLE RESULT:

A complete meeting record with relevant context, decisions, commitments and next actions.

---

## MODULE 8 – DEAL TOOLKIT
### Commercial Analysis and Advisory Workbench

PURPOSE:

Provide the analytical tools needed to evaluate properties, commercial terms and CRE decisions.

### A. Requirement Brief

Include:
- Client needs.
- Assumptions.
- Open questions.
- Budget.
- Timeline.
- Location.
- Area.
- Technical requirements.
- Stakeholder approvals.

### B. Property Comparison

Compare:
- Building.
- Unit.
- Location.
- Micro-market.
- Area.
- Suitability.
- Availability.
- Shortcomings.
- Commercial terms.
- Connectivity.
- Parking.
- Developer profile.
- Technical specifications.
- Evidence.
- Other relevant parameters.

Provide configurable weighted ratings.

### C. Lease Economics

Calculate:
- Rent.
- Rent escalation.
- Rent-free periods.
- CAM.
- Parking.
- Deposits.
- Other charges.

### D. Occupancy Economics

Support:
- Nominal occupancy cost.
- Effective rent.
- Cash funding.
- Discounted cost.
- Cost sensitivities.
- Relevant assumptions.

### E. Conventional vs Managed Office

Compare:
- Comparable capacity.
- Service inclusions.
- Fit-out.
- Flexibility.
- Commitment.
- Pricing.
- Additional costs.

### F. Renewal vs Relocation

Compare:
- Revised rent.
- Refurbishment.
- Moving.
- Overlap rent.
- Restoration.
- Deposits.
- Fit-out.
- Operational disruption.

### G. Fit-Out and Financing

Support:
- Capex.
- Partner quotations.
- Financing schedules.
- Funding requirements.

### H. Negotiation Comparison

Compare:
- Offer versions.
- Counteroffers.
- Concession packages.
- Unresolved terms.
- Client priorities.

### I. Client Outputs

Generate editable:
- Proposals.
- Spreadsheets.
- Presentations.
- Visit packs.
- Decision summaries.

### J. Specialist Models

Keep architecture extensible for:
- BTS.
- Investment.
- Other CRE advisory services.

### Mandatory Rules

- No silent area conversion.
- No assumed CAM inclusion.
- Unknown is not zero.
- Clearly identify assumptions.
- Preserve calculation inputs.
- Make calculations reproducible.
- Distinguish asking rent from transacted rent.

VISIBLE RESULT:

A commercial workbench that turns fragmented property and pricing information into defensible client recommendations.

---

## MODULE 9 – ORCHESTRATOR
### Coordinating the Entire Operating System

PURPOSE:

Coordinate scheduled, event-driven and dependent workflows across all selected modules.

### A. Scheduling

Support:
- Daily 08:00 plan.
- Source updates.
- Signal checks.
- Scoring updates.
- Meeting preparation.
- Post-meeting processing.
- Follow-ups.
- Weekly business reviews.
- Background research.

### B. Event-Driven Automation

Trigger relevant workflows when:
- New company information arrives.
- A contact changes employer.
- A new requirement is created.
- A property quotation changes.
- A meeting is cancelled.
- A new meeting is scheduled.
- A transaction changes stage.
- An approval is completed.
- A lease deadline approaches.
- Property availability changes.

### C. Specialist Routing

Route tasks to:
- Database.
- Signal Engine.
- Scoring Engine.
- Contact Enrichment.
- Outreach.
- Meeting Intelligence.
- Deal Toolkit.
- Input Engine.
- Intelligence Layer.
- Property Supply.
- Lease Lifecycle.
- Transaction Execution.
- Assistant.

### D. Dependency Management

- Identify dependent tasks.
- Execute them in the correct order.
- Prevent execution when prerequisites are missing.
- Track pending dependencies.
- Resume when required information becomes available.
- Reassess affected outputs when inputs change.

### E. Daily Plan

At 08:00:
- Review calendar.
- Review urgent commitments.
- Review pending follow-ups.
- Review overdue tasks.
- Review high-priority accounts.
- Review new signals.
- Review active transactions.
- Review lease events.
- Prioritise activities.

### F. Background Job Management

- Track running jobs.
- Track completed jobs.
- Track failed jobs.
- Track delayed jobs.
- Retry eligible failures.
- Prevent duplicate execution.
- Preserve successful steps.

### G. Budget and Usage

Monitor:
- AI usage.
- Research usage.
- Enrichment usage.
- Transcription usage.
- Background processing usage.

### H. Controls

Provide:
- Pause.
- Resume.
- Retry.
- Inspect.
- Execution history.
- System health.

### Mandatory Rules

- Urgent client work takes priority over routine research.
- AI outages must not prevent deterministic daily-plan generation.
- External communication requires human approval.
- Retries must be idempotent.
- No silent failure.

VISIBLE RESULT:

A central automation dashboard showing what is running, what is scheduled, what succeeded and what requires attention.

---

## MODULE 10 – INPUT ENGINE
### Turning Everyday Information into Usable Business Memory

PURPOSE:

Accept unstructured information and convert it into validated, structured CRE information.

### A. Capture Methods

Support:
- Text.
- Voice.
- Images.
- Screenshots.
- Business cards.
- PDF.
- DOC/DOCX.
- PPT/PPTX.
- Excel.
- CSV.
- Permitted meeting recordings.

### B. Text Processing

Understand:
- Informal notes.
- Incomplete sentences.
- CRE terminology.
- Shorthand.
- Business commitments.
- Commercial discussions.

### C. Voice Processing

Support:
- English.
- Hindi.
- Hinglish.
- Audio transcription.
- Speaker identification where possible.
- Transcription correction.

### D. OCR and Document Extraction

Extract:
- Company names.
- Contact details.
- Property details.
- Areas.
- Rents.
- CAM.
- Lease dates.
- Commercial conditions.
- Commitments.
- Requirements.

### E. Spreadsheet Engine

Support:
- Multi-sheet processing.
- Column detection.
- Automatic column mapping.
- Validation.
- Duplicate detection.
- Change detection.
- Import reports.

### F. Entity Matching

Match against existing:
- Companies.
- People.
- Buildings.
- Properties.
- Requirements.
- Transactions.

### G. Validation

Identify:
- Missing information.
- Ambiguous information.
- Conflicting values.
- Uncertain units.
- Invalid dates.
- Duplicate records.

### H. Human Review

Allow:
- Confirm.
- Edit.
- Reject.
- Associate.
- Create new record.
- Request clarification.

### I. Source Traceability

Preserve:
- Original file.
- Original note.
- Audio.
- Image.
- Document page.
- Spreadsheet worksheet.
- Spreadsheet cell.
- Transcript timestamp.

### Mandatory Rules

- Preserve raw information.
- Never silently overwrite historical information.
- Do not merge uncertain entities.
- Distinguish facts from assumptions.
- Require appropriate approval for material changes.
- Preserve original source references.

VISIBLE RESULT:

A single capture interface that transforms everyday CRE information into structured, connected and actionable business memory.

---

## MODULE 12 – SUPERCHARGED ASSISTANT
### One Conversational Interface to the Entire CRE System

PURPOSE:

Provide a natural-language interface through which the user can access and operate the entire CRE system.

The assistant must use the capabilities of the existing modules rather than recreating their business logic.

### A. Natural-Language Questions

Support queries such as:

- Which accounts deserve attention today?
- Which companies have lease events next year?
- Who is the decision-maker at this company?
- What did I discuss with this person?
- What properties match this requirement?
- What is the latest landlord quotation?
- What is blocking this transaction?
- Which lease renewals need attention?
- Prepare me for my next meeting.
- Show my overdue commitments.

### B. Contextual Retrieval

Retrieve relevant information from:
- Database.
- Intelligence Layer.
- Signal Engine.
- Scoring Engine.
- Contact Enrichment.
- Meeting Intelligence.
- Deal Toolkit.
- Property Supply.
- Lease Lifecycle.
- Transaction Execution.

### C. Action Assistance

Allow the assistant to prepare:
- Notes.
- Tasks.
- Meeting briefs.
- Property comparisons.
- Commercial analyses.
- Outreach drafts.
- Follow-up drafts.
- Transaction summaries.
- Lease summaries.
- Research briefs.

### D. Controlled Actions

The assistant may propose or perform permitted internal operations.

For consequential changes:
- Show what will change.
- Explain why.
- Identify the affected records.
- Request required approval.

External communications must remain manual.

### E. Conversational Memory

Maintain relevant context across conversations.

Avoid asking the user to repeat information already available and permitted for retrieval.

### F. Source-Based Answers

Answers must:
- Use actual records.
- Identify relevant sources.
- Distinguish verified facts from assumptions.
- Highlight missing information.
- Avoid hallucinating records or activities.

### G. Progressive Disclosure

Show a concise answer first.

Allow the user to inspect:
- Supporting information.
- Commercial calculations.
- Source records.
- Historical context.
- Detailed analysis.

VISIBLE RESULT:

One conversational interface through which the user can understand, query and progress CRE business activities.

---

## MODULE 13 – INTELLIGENCE LAYER
### Persistent Business Memory and Contextual Understanding

PURPOSE:

Understand relationships between companies, contacts, properties, requirements and historical interactions.

### A. Person Memory

Maintain:
- Employment history.
- Designation history.
- Professional responsibilities.
- Decision authority.
- Relationship history.
- Previous discussions.
- Commitments.
- Known business preferences.
- Relevant communication preferences.

### B. Company Memory

Maintain:
- Company background.
- Industry.
- Business units.
- Office locations.
- Occupancy history.
- Requirements.
- Decision-makers.
- Transactions.
- Previous discussions.
- Business developments.

### C. Property Memory

Maintain:
- Building history.
- Developer.
- Landlord.
- Previous quotations.
- Historical rent.
- Technical specifications.
- Previous client interest.
- Rejection reasons.
- Supply changes.

### D. Requirement Memory

Maintain:
- Current requirement.
- Historical requirement.
- Area changes.
- Budget changes.
- Location changes.
- Timeline changes.
- Commercial preferences.
- Rejected properties.
- Rejection reasons.

### E. Relationship Memory

Maintain:
- Introductions.
- Relationship strength.
- Interaction frequency.
- Recency.
- Commitments.
- Previous assistance.
- Meaningful professional context.

### F. Change Detection

Identify:
- Employment changes.
- Decision-maker changes.
- Requirement changes.
- Property changes.
- Commercial changes.
- Relationship changes.
- Opportunity changes.

### G. Contextual Retrieval

Provide relevant context before:
- Meetings.
- Outreach.
- Property recommendations.
- Negotiations.
- Renewals.
- Transaction reviews.

### H. Recommendations

Suggest:
- Follow-ups.
- Relationship development.
- Requirement reassessment.
- Property reassessment.
- Decision-maker updates.
- Opportunity reviews.

### Mandatory Rules

- Database remains the source of structured records.
- Intelligence Layer must not create an independent conflicting database.
- Preserve historical observations.
- Never invent relationships or conversations.
- Distinguish recurring preferences from confirmed requirements.
- Never automatically transfer opportunities when a contact changes employer.
- Respect permissions and privacy.

VISIBLE RESULT:

A system that understands what the business knows, how information connects and what has changed.

---

## MODULE 14 – PROPERTY SUPPLY AND MATCHING
### Managing Supply and Matching It to Client Requirements

PURPOSE:

Maintain actionable commercial real estate supply intelligence.

### A. Property Hierarchy

Support:

- Campus.
- Building.
- Tower.
- Floor.
- Unit.
- Divisible space.
- Contiguous space.

### B. Property Categories

Support:
- Conventional offices.
- Managed offices.
- Coworking.
- Commercial campuses.
- Business parks.
- Other configurable CRE categories.

### C. Supply Information

Maintain:
- Property.
- Developer.
- Landlord.
- Property manager.
- Location.
- Micro-market.
- Available area.
- Area type.
- Floor.
- Unit.
- Availability date.
- Possession conditions.
- Furnishing.
- Technical specifications.
- Source.
- Last verification date.

### D. Commercial Terms

Maintain:
- Rent.
- CAM.
- Deposit.
- Rent escalation.
- Lock-in.
- Lease duration.
- Rent-free period.
- Parking.
- Fit-out costs.
- Brokerage.
- Other charges.

### E. Availability Status

Support:
- Immediately available.
- Future availability.
- Under negotiation.
- Tentatively held.
- Under offer.
- Occupied.
- Unconfirmed.
- Withdrawn.
- Leased.

### F. Operator Intelligence

Maintain managed office and coworking operators across locations.

Track:
- Centre.
- Capacity.
- Seats.
- Private offices.
- Pricing.
- Services.
- Amenities.
- Contract terms.
- Additional charges.
- Brokerage conditions.

### G. Property Matching

Match inventory against:
- Area.
- Budget.
- Location.
- Property type.
- Timeline.
- Technical needs.
- Parking.
- Furnishing.
- Other client preferences.

Apply hard filters before preference scoring.

### H. Matching Explanation

For every suggested property, show:
- Why it matches.
- What it satisfies.
- What it fails.
- Commercial advantages.
- Disadvantages.
- Missing information.
- Availability confidence.
- Verification required.

### I. Shortlists

Support:
- Property shortlists.
- Commercial comparison.
- Client feedback.
- Rejection reasons.
- Shortlist history.

### J. Reconfirmation

Identify:
- Stale availability.
- Outdated pricing.
- Expired quotations.
- Missing technical details.

Reconfirm shortlisted properties before client presentation and site visits.

### Mandatory Rules

- Lease expiry does not establish vacancy.
- Historical pricing is not current pricing.
- Future supply is not immediate availability.
- Do not combine non-contiguous inventory incorrectly.
- Missing CAM is not zero.
- Preserve historical quotations.
- Never hide hard-filter failures behind a high score.

VISIBLE RESULT:

A reliable property supply engine with current availability, commercial terms, matching explanations and verification status.

---

## MODULE 15 – LEASE LIFECYCLE MANAGEMENT
### Managing Leases from Execution to Renewal or Termination

PURPOSE:

Track all important commercial lease agreements and their lifecycle events.

### A. Lease Records

Maintain:
- Tenant.
- Landlord.
- Property.
- Lease ID.
- Lease type.
- Commencement.
- Execution.
- Possession.
- Expiry.
- Duration.
- Status.
- Documents.

### B. Commercial Terms

Maintain:
- Rent.
- CAM.
- Area.
- Deposit.
- Escalation.
- Rent-free period.
- Lock-in.
- Notice period.
- Break clauses.
- Renewal conditions.
- Termination conditions.

### C. Critical Dates

Track:
- Rent commencement.
- Escalation.
- Lock-in completion.
- Renewal notice deadline.
- Break option.
- Termination notice.
- Lease expiry.
- Handover.

### D. Renewal Management

- Identify upcoming renewals.
- Calculate relevant notice deadlines.
- Retrieve existing lease terms.
- Compare renewal proposals.
- Compare relocation alternatives.
- Track negotiations.
- Track approvals.
- Track executed renewals.

### E. Financial Obligations

Track:
- Rent.
- CAM.
- Deposit.
- Escalation.
- Payment deadlines where supported.
- Deposit refund.
- Final settlement.

### F. Document Management

Support:
- LOI.
- Term Sheet.
- Lease Agreement.
- Amendments.
- Renewal agreements.
- Termination notices.
- Handover documents.

### G. Obligation Tracking

Track:
- Tenant obligations.
- Landlord obligations.
- Shared obligations.
- Responsible parties.
- Deadlines.
- Supporting evidence.
- Completion status.

### H. Expiry and Handover

Track:
- Inspection.
- Restoration.
- Repairs.
- Utility settlement.
- Key return.
- Deposit reconciliation.
- Final handover.

### I. Business Opportunity Identification

Identify:
- Upcoming renewals.
- Potential relocations.
- Rent escalation discussions.
- Upcoming vacancy possibilities.
- Space expansion possibilities.

### Mandatory Rules

- A lease expiry is not proof of relocation.
- A draft is not an executed agreement.
- Lock-in completion does not automatically permit termination.
- Preserve contractual wording.
- Verify calculated deadlines.
- Never silently overwrite lease terms.
- AI interpretation is not legal clearance.

VISIBLE RESULT:

An active lease portfolio with critical dates, obligations, renewals, commercial changes and potential business opportunities.

---

## MODULE 16 – TRANSACTION EXECUTION AND NEGOTIATION
### Managing Active CRE Transactions from Negotiation to Handover

PURPOSE:

Coordinate all activities required to execute a CRE transaction.

### A. Transaction Workspace

Create a dedicated transaction record containing:
- Client.
- Property.
- Requirement.
- Transaction type.
- Assigned owner.
- Stakeholders.
- Stage.
- Status.
- Expected completion date.
- Documents.
- Commercial terms.

### B. Transaction Types

Support:
- Conventional leasing.
- Managed office.
- Coworking.
- Lease renewal.
- Relocation.
- Build-to-Suit.
- Investment.

### C. Workflow Stages

Support configurable workflows covering:

- Requirement confirmation.
- Property shortlist.
- Site visit.
- Client feedback.
- Offer.
- Counteroffer.
- Negotiation.
- Technical inspection.
- LOI.
- Term sheet.
- Legal review.
- Approval.
- Agreement execution.
- Deposit.
- Possession.
- Fit-out.
- Handover.
- Closure.

### D. Offer and Counteroffer Management

Maintain:
- Offer ID.
- Offer version.
- Offering party.
- Receiving party.
- Rent.
- CAM.
- Deposit.
- Lock-in.
- Lease duration.
- Escalation.
- Rent-free period.
- Possession.
- Other concessions.
- Offer validity.

Preserve all versions.

### E. Negotiation Intelligence

Compare:
- Headline rent.
- Effective rent.
- CAM.
- Deposit.
- Escalation.
- Lock-in.
- Fit-out support.
- Flexibility.
- Other concessions.

Identify:
- Commercial gaps.
- Unresolved terms.
- Negotiation opportunities.
- Risks.
- Possible trade-offs.

### F. Live Issues

Track:
- Issue.
- Description.
- Category.
- Owner.
- Responsible party.
- Priority.
- Deadline.
- Status.
- Dependencies.
- Resolution.

### G. Stakeholder Coordination

Track:
- Client.
- Landlord.
- Developer.
- Operator.
- Legal.
- Finance.
- Procurement.
- Technical consultants.
- Fit-out contractors.

### H. LOI and Agreement Management

- Prepare documents.
- Track versions.
- Track approvals.
- Compare agreement drafts.
- Identify changes from agreed commercial terms.
- Flag discrepancies.
- Track signatures.
- Track execution.

### I. Approval Management

Track:
- Client approval.
- Internal approval.
- Commercial approval.
- Financial approval.
- Legal approval.
- Technical approval.

Approval must be bound to the exact document version.

### J. Execution and Handover

Track:
- Deposit due.
- Deposit paid.
- Agreement executed.
- Possession.
- Fit-out.
- Inspection.
- Handover.
- Closure pack.

### Mandatory Rules

- Proposal is not agreement.
- Agreement is not signed contract.
- Signed contract is not possession.
- Possession is not occupancy.
- Deposit due is not deposit paid.
- No unapproved commercial commitments.
- Preserve offer history.
- Maintain issue ownership.
- Legal clearance remains with authorised reviewers.

VISIBLE RESULT:

A transaction command centre showing status, agreed terms, pending issues, approvals, dependencies, stakeholders and route to completion.

---

# PART 4: HOW ALL MODULES MUST SYNC

This section is mandatory.

Do not implement module integrations as informal direct calls between unrelated components.

Create a shared event-driven architecture with clearly defined data contracts.

## 4.1 SHARED DATA ARCHITECTURE

All modules must operate on shared business entities.

Core entities:

1. Company.
2. Contact.
3. Employment.
4. Property.
5. Building.
6. Floor.
7. Unit.
8. Occupancy.
9. Requirement.
10. Interaction.
11. Signal.
12. Score Assessment.
13. Relationship.
14. Property Availability.
15. Commercial Offer.
16. Transaction.
17. Lease.
18. Document.
19. Task.
20. Meeting.
21. Approval.
22. Obligation.
23. Workflow.
24. Notification.
25. Source Observation.
26. Audit Event.

Every entity must have:
- Stable unique ID.
- Creation timestamp.
- Last updated timestamp.
- Ownership and permissions.
- Source references where relevant.
- Verification status where applicable.
- Historical versioning where appropriate.

## 4.2 EVENT-DRIVEN COMMUNICATION

Create a common event processing mechanism.

Example event types:

- company.created
- company.updated
- contact.created
- contact.employer_changed
- property.created
- property.availability_changed
- property.quotation_received
- requirement.created
- requirement.updated
- interaction.created
- meeting.scheduled
- meeting.cancelled
- meeting.processed
- signal.detected
- score.recalculated
- offer.created
- offer.revised
- transaction.stage_changed
- approval.requested
- approval.completed
- lease.created
- lease.expiry_approaching
- lease.escalation_approaching
- document.uploaded
- document.processed
- workflow.failed

Every event must contain:

- Event ID.
- Event type.
- Entity type.
- Entity ID.
- Timestamp.
- Source module.
- Actor.
- Relevant payload.
- Correlation ID.
- Idempotency key.
- Permission context.

Do not expose sensitive information unnecessarily in event payloads.

## 4.3 EVENT PROCESSING RULES

- Events must be processed asynchronously where appropriate.
- Consumers must be idempotent.
- Failed events must be retried safely.
- Duplicate events must not create duplicate records.
- Processing failures must be visible.
- Event history must be inspectable.
- Dependent workflows must execute in the correct order.
- Events must respect permissions.
- Material updates must trigger reassessment where relevant.

Use a durable event/outbox pattern or an equivalent reliable architecture supported by the existing stack.

Do not rely on fragile browser-side triggers for critical business workflows.

---

# PART 5: COMPLETE END-TO-END BUSINESS WORKFLOWS

The following workflows must be implemented and tested.

## WORKFLOW 1: NEW COMPANY DISCOVERY

1. Signal Engine detects a company expansion announcement.
2. Evidence is collected.
3. Company is matched against Database.
4. Intelligence Layer retrieves existing company history.
5. Signal Engine evaluates CRE relevance.
6. Scoring Engine calculates lead priority.
7. Contact Enrichment identifies relevant stakeholders.
8. Database updates company and contact records.
9. Outreach Engine prepares a contextual communication.
10. User reviews and manually sends it.
11. Orchestrator schedules follow-up.
12. Assistant makes the information available through Ask.

Expected outcome: A new, evidence-backed and prioritised business opportunity.

## WORKFLOW 2: NEW CONTACT DISCOVERY

1. Contact Enrichment identifies a relevant professional.
2. Existing contact records are searched.
3. Duplicate detection runs.
4. Contact is matched to the correct company.
5. Buying-group role is identified.
6. Intelligence Layer retrieves relationship context.
7. Relationship information is updated.
8. Scoring Engine reassesses access.
9. Outreach Engine prepares a relevant draft.
10. User reviews and sends manually.

Expected outcome: A verified or clearly labelled contact connected to the correct account.

## WORKFLOW 3: NEW INFORMATION CAPTURE

1. User uploads a document, note, image or voice recording.
2. Input Engine preserves the original source.
3. OCR, transcription or extraction runs.
4. Entities are identified.
5. Database matching runs.
6. Intelligence Layer checks historical context.
7. Conflicts and uncertainty are identified.
8. Material changes enter Review.
9. Approved information updates Database.
10. Relevant events are published.
11. Scoring and dependent modules reassess.
12. Orchestrator triggers appropriate actions.
13. User receives a processing receipt.

Expected outcome: One capture updates all relevant records without duplicate data entry.

## WORKFLOW 4: MEETING PREPARATION AND FOLLOW-THROUGH

1. Calendar identifies an upcoming meeting.
2. Orchestrator triggers preparation approximately one hour beforehand.
3. Meeting Intelligence retrieves company and contact context.
4. Intelligence Layer provides historical relationship information.
5. Signal Engine provides relevant developments.
6. Database provides current requirements.
7. Deal Toolkit provides relevant commercial context.
8. Meeting brief is generated.
9. User conducts the meeting.
10. Recording or notes are captured with appropriate permission.
11. Input Engine processes the information.
12. Meeting Intelligence generates the summary.
13. Database receives proposed updates.
14. Scoring Engine reassesses relevant records.
15. Outreach Engine prepares follow-up.
16. Orchestrator schedules next actions.

Expected outcome: A complete meeting workflow from preparation to follow-through.

## WORKFLOW 5: NEW PROPERTY REQUIREMENT

1. A requirement is captured.
2. Input Engine extracts its details.
3. Database checks for existing requirements.
4. Intelligence Layer retrieves historical requirements.
5. Scoring Engine assesses requirement readiness.
6. Property Supply searches inventory.
7. Matching Engine applies hard filters.
8. Preference scoring ranks eligible properties.
9. Deal Toolkit compares suitable options.
10. Missing information is highlighted.
11. User reviews the shortlist.
12. Availability reconfirmation tasks are created.
13. User approves the client-facing shortlist.

Expected outcome: A validated requirement connected to a relevant property shortlist.

## WORKFLOW 6: NEW PROPERTY QUOTATION

1. User uploads a property quotation.
2. Input Engine extracts commercial terms.
3. Property Supply identifies the relevant property.
4. Existing quotations are retrieved.
5. New and historical terms are compared.
6. Commercial conflicts are identified.
7. Database preserves both versions.
8. Deal Toolkit recalculates relevant comparisons.
9. Intelligence Layer updates property context.
10. Orchestrator notifies affected transaction owners.
11. Transaction Execution identifies affected drafts or negotiations.
12. User reviews material changes.

Expected outcome: An updated commercial position without losing historical quotations.

## WORKFLOW 7: CLIENT PROPERTY SHORTLIST

1. Client requirement is retrieved.
2. Property Supply identifies available inventory.
3. Hard filters are applied.
4. Preference scoring is calculated.
5. Availability confidence is checked.
6. Deal Toolkit compares eligible properties.
7. Historical rejection reasons are retrieved.
8. Suitable alternatives are shortlisted.
9. Missing information is highlighted.
10. User approves the shortlist.
11. Outreach or proposal drafts are prepared.
12. Client feedback is captured.

Expected outcome: A defensible, evidence-backed property shortlist.

## WORKFLOW 8: PROPERTY REJECTION

1. Client rejects a shortlisted property.
2. Meeting Intelligence or Input Engine captures the reason.
3. Database updates the property-rejection record.
4. Intelligence Layer identifies recurring preferences.
5. Property Supply updates matching context.
6. Scoring Engine reassesses relevant properties.
7. Deal Toolkit compares alternatives.
8. Orchestrator triggers the next action.

Expected outcome: Future property recommendations improve using actual client feedback.

## WORKFLOW 9: NEGOTIATION

1. Property is selected for negotiation.
2. Transaction Execution creates a transaction workspace.
3. Deal Toolkit retrieves commercial analysis.
4. Initial offer is recorded.
5. Counteroffer is recorded.
6. Version comparison identifies changes.
7. Issues and dependencies are tracked.
8. Meeting Intelligence captures negotiation discussions.
9. Input Engine extracts new commercial terms.
10. Database preserves negotiation history.
11. Approvals are requested where required.
12. Revised offers are reviewed.
13. Final commercial position is recorded.

Expected outcome: Complete and auditable negotiation history.

## WORKFLOW 10: AGREEMENT EXECUTION

1. Commercial terms are agreed.
2. Transaction Execution records agreed terms.
3. LOI and term sheet are tracked.
4. Agreement draft is uploaded.
5. Input Engine extracts relevant clauses.
6. Document comparison checks changes.
7. Commercial discrepancies are identified.
8. Legal review is requested.
9. Required approvals are collected.
10. Final agreement is signed.
11. Execution evidence is recorded.
12. Lease Lifecycle receives the executed lease information.
13. Orchestrator starts lease monitoring.

Expected outcome: A controlled transition from negotiation to executed lease.

## WORKFLOW 11: LEASE EXPIRY AND RENEWAL

1. Lease Lifecycle identifies an upcoming expiry.
2. Contractual notice deadlines are calculated.
3. Orchestrator schedules reminders.
4. Intelligence Layer retrieves company history.
5. Database retrieves current occupancy.
6. Deal Toolkit compares renewal versus relocation.
7. Property Supply identifies alternatives.
8. Scoring Engine prioritises the opportunity.
9. Outreach Engine prepares a renewal discussion.
10. User reviews and contacts the client.
11. Meeting Intelligence captures the discussion.
12. Transaction Execution manages renewal negotiations.
13. Lease Lifecycle updates the renewed lease after execution.

Expected outcome: Timely, evidence-backed renewal and relocation advisory.

## WORKFLOW 12: CONTACT EMPLOYMENT CHANGE

1. Contact Enrichment detects an employment change.
2. Database preserves the previous employer.
3. Intelligence Layer updates employment history.
4. Existing company opportunities remain associated with the original company.
5. Buying-group relationships are reassessed.
6. Scoring Engine reassesses relationship access.
7. Orchestrator creates a review task.
8. Outreach Engine prepares an appropriate draft if useful.

Expected outcome: Accurate professional relationship continuity without incorrect opportunity transfers.

## WORKFLOW 13: DAILY BUSINESS PLAN

At 08:00:

1. Orchestrator retrieves calendar commitments.
2. Database retrieves open tasks.
3. Scoring Engine retrieves priority accounts.
4. Signal Engine retrieves important new developments.
5. Outreach Engine retrieves pending follow-ups.
6. Meeting Intelligence retrieves preparation requirements.
7. Transaction Execution retrieves active blockers.
8. Lease Lifecycle retrieves important upcoming deadlines.
9. Intelligence Layer provides context.
10. Orchestrator creates a prioritised daily plan.

Expected outcome: One consolidated plan instead of separate module dashboards.

## WORKFLOW 14: FAILED BACKGROUND PROCESS

1. A scheduled process fails.
2. Orchestrator identifies the failure.
3. Error is classified.
4. Temporary failures are retried safely.
5. Completed steps are preserved.
6. Duplicate actions are prevented.
7. Permanent failures enter the review queue.
8. User receives a practical recovery explanation.

Expected outcome: Dependable background automation.

---

# PART 6: CROSS-MODULE DATA SYNCHRONISATION RULES

The following rules must be implemented globally.

### 6.1 Company Synchronisation

When a company is updated:
- Database stores the change.
- Intelligence Layer updates context.
- Signal Engine reassesses relevant signals.
- Scoring Engine reassesses affected scores.
- Contact Enrichment reviews buying-group relationships.
- Assistant retrieves the updated company information.

### 6.2 Contact Synchronisation

When a contact changes:
- Database updates the contact record.
- Employment history is preserved.
- Intelligence Layer updates relationship context.
- Contact Enrichment reassesses the buying group.
- Scoring Engine reassesses relationship access.
- Outreach Engine uses the updated context.
- Relevant tasks are created.

### 6.3 Requirement Synchronisation

When a requirement changes:
- Database preserves previous values.
- Intelligence Layer updates requirement memory.
- Scoring Engine reassesses readiness.
- Property Supply reruns matching.
- Deal Toolkit recalculates comparisons.
- Transaction Execution identifies affected transactions.
- Orchestrator schedules required actions.

### 6.4 Property Synchronisation

When property information changes:
- Database stores the new observation.
- Property Supply updates inventory.
- Intelligence Layer updates property context.
- Deal Toolkit recalculates affected comparisons.
- Transaction Execution identifies affected offers.
- Orchestrator notifies relevant owners.

### 6.5 Lease Synchronisation

When lease information changes:
- Database preserves the updated record and history.
- Lease Lifecycle recalculates relevant milestones.
- Orchestrator updates reminders.
- Signal Engine reassesses lease-related signals.
- Scoring Engine reassesses affected opportunities.
- Assistant retrieves the current lease position.

### 6.6 Transaction Synchronisation

When transaction status changes:
- Database updates the transaction.
- Transaction Execution records the event.
- Orchestrator triggers dependent activities.
- Deal Toolkit retrieves the latest commercial position.
- Lease Lifecycle receives relevant executed information.
- Intelligence Layer updates transaction history.
- Assistant retrieves the latest transaction status.

---

# PART 7: GLOBAL APPROVAL, EVIDENCE AND QUALITY CONTROLS

These controls must apply across every module.

### 7.1 Unified Review Queue

Create one review queue for:

- Uncertain entity matches.
- Duplicate records.
- Conflicting evidence.
- Material commercial changes.
- Contractual changes.
- Permission changes.
- Unverified important information.
- Proposed consequential actions.

Each review item must show:

- What changed.
- Why it changed.
- Source.
- Affected records.
- Confidence.
- Potential impact.
- Recommended action.

Provide:
- Approve.
- Edit.
- Reject.
- Defer.
- Inspect source.

### 7.2 Evidence Management

Every important information item must support:

- Source.
- Observation date.
- Extraction date.
- Verification status.
- Confidence.
- Historical value.
- Supporting document.
- Source reference.

### 7.3 Audit History

Record:
- Who created information.
- Who changed information.
- What changed.
- Previous value.
- New value.
- Source.
- Timestamp.
- Approval status.

### 7.4 Safe Undo

Support safe reversal of eligible internal changes.

Undo must not overwrite a later valid update.

### 7.5 Permissions

Enforce:
- Account ownership.
- User roles.
- Record visibility.
- Private relationship notes.
- Shared company information.
- Document access.
- Connector permissions.

The same permissions must apply to search results, AI answers, generated documents and exports.

### 7.6 Error Handling

Every failure must explain:

- What failed.
- Which records or workflows are affected.
- Whether any data was saved.
- Whether retry is safe.
- What recovery action is available.

### 7.7 Prompt Injection and Untrusted Content

Uploaded documents, web pages, emails and external source content must be treated as data, not instructions.

No source document may instruct the system to bypass permissions, approvals or safety controls.

---

# PART 8: GLOBAL TESTING REQUIREMENTS

Do not consider the project complete merely because individual modules open successfully.

The entire application must be tested for data integrity, workflow accuracy, integration, permissions, reliability and actual CRE business usefulness.

## 8.1 MODULE-LEVEL TESTING

Test every function of all 14 selected modules.

For every module, verify:

- UI functionality.
- Backend logic.
- Database operations.
- Validation.
- Error handling.
- Permissions.
- Source tracking.
- Historical preservation.
- Integration.
- Performance.

## 8.2 INTEGRATION TESTING

Test every relevant module-to-module connection.

Examples:

- Input Engine → Database.
- Database → Intelligence Layer.
- Signal Engine → Scoring Engine.
- Contact Enrichment → Database.
- Meeting Intelligence → Input Engine.
- Meeting Intelligence → Intelligence Layer.
- Property Supply → Deal Toolkit.
- Deal Toolkit → Transaction Execution.
- Transaction Execution → Lease Lifecycle.
- Lease Lifecycle → Signal Engine.
- Orchestrator → All relevant modules.
- Assistant → All permitted modules.

Verify that:
- Events are delivered.
- Data is correct.
- Dependencies execute in order.
- Duplicate processing is prevented.
- Permissions are respected.
- Failures are recoverable.

## 8.3 END-TO-END TESTING

Execute all 14 business workflows specified in Part 5.

Do not mark a workflow as passed merely because the first module succeeded.

Test the complete journey until the final expected outcome.

## 8.4 DATA QUALITY TESTING

Test:

- Duplicate companies.
- Duplicate contacts.
- Duplicate buildings.
- Alternate company names.
- Contact employment changes.
- Conflicting rents.
- Missing area units.
- Missing CAM.
- Historical quotations.
- Stale availability.
- Uncertain lease dates.
- Conflicting agreement versions.
- Incorrect relationship associations.

## 8.5 AUTOMATION TESTING

Test:

- Scheduled jobs.
- Event triggers.
- Workflow dependencies.
- Retries.
- Idempotency.
- Pause and resume.
- Failed jobs.
- Duplicate event delivery.
- Service outages.
- Partial completion.
- Recovery.

## 8.6 AI ACCURACY TESTING

Evaluate:

- Entity extraction accuracy.
- OCR accuracy.
- Transcription accuracy.
- CRE terminology recognition.
- Signal relevance.
- Entity matching.
- Contact matching.
- Requirement extraction.
- Commercial term extraction.
- Context retrieval.
- Summary accuracy.
- Recommendation relevance.

Maintain a representative test dataset containing real-world CRE scenarios with appropriately protected or synthetic information.

Record actual accuracy instead of claiming that a feature is accurate without testing.

## 8.7 SECURITY AND PERMISSION TESTING

Test:

- Unauthorised record access.
- Cross-account data leakage.
- Private relationship information.
- Document permissions.
- Search permissions.
- AI retrieval permissions.
- External connector permissions.
- Approval bypass attempts.
- Malicious uploaded documents.
- Audit history integrity.

## 8.8 PERFORMANCE TESTING

Test:

- Large company datasets.
- Large contact datasets.
- Thousands of properties.
- Large document uploads.
- Bulk spreadsheet imports.
- Concurrent background jobs.
- Multiple simultaneous users.
- Complex search queries.
- Long interaction histories.
- Large transaction workspaces.

Measure:
- Response time.
- Processing time.
- Job throughput.
- Failure rate.
- Database performance.
- Resource consumption.

Set measurable service targets based on the actual deployment environment.

## 8.9 USER ACCEPTANCE TESTING

Verify that a user can complete the following activities without understanding the internal module architecture:

1. Capture a voice note.
2. Understand a company.
3. Prepare for a meeting.
4. Record a meeting outcome.
5. Update a requirement.
6. Find matching properties.
7. Compare commercial options.
8. Prepare outreach.
9. Track a negotiation.
10. Execute a transaction.
11. Monitor a lease.
12. Review the day's priorities.

The user should not have to manually enter the same information into multiple modules.

---

# PART 9: TEST DATA AND REALISTIC CRE SCENARIOS

Create a dedicated test environment with representative CRE data.

Include:

- Multiple companies.
- Parent and subsidiary relationships.
- Multiple contacts per company.
- Contacts with employment changes.
- Multiple office locations.
- Buildings with multiple floors.
- Floors with multiple units.
- Divisible and contiguous spaces.
- Conventional offices.
- Managed office operators.
- Coworking centres.
- Multiple quotations.
- Different area measurement types.
- Different commercial structures.
- Multiple requirements for one company.
- Multiple concurrent transactions.
- Active leases.
- Upcoming renewals.
- Lease amendments.
- Conflicting source information.

Create scenarios involving:

1. A company expanding its Pune operations.
2. A company consolidating its office footprint.
3. A company approaching lease expiry.
4. A company evaluating renewal versus relocation.
5. A company requiring a managed office.
6. A client with multiple simultaneous requirements.
7. A landlord revising a commercial quotation.
8. A contact changing employers.
9. A property becoming unavailable during negotiation.
10. A revised agreement changing previously agreed commercial terms.

All scenarios must be executed end to end.

---

# PART 10: TECHNICAL IMPLEMENTATION REQUIREMENTS

Before changing the application:

1. Inspect the existing codebase.
2. Inspect the current database schema.
3. Inspect existing APIs.
4. Inspect authentication.
5. Inspect file storage.
6. Inspect existing AI integrations.
7. Inspect background processing.
8. Inspect existing module implementations.
9. Identify duplicate functionality.
10. Identify broken or incomplete integrations.

### Mandatory Development Rules

- Reuse the existing technology stack.
- Reuse existing working components.
- Do not rebuild functioning modules unnecessarily.
- Do not introduce duplicate databases.
- Do not introduce duplicate business logic.
- Do not create fake functionality.
- Do not use placeholder data in production workflows.
- Do not silently remove existing functionality.
- Maintain backward compatibility where possible.
- Use migrations for database changes.
- Implement structured APIs.
- Validate all important operations on the backend.
- Keep AI processing separate from deterministic business logic.
- Make long-running processes asynchronous.
- Use reliable job processing.
- Maintain logs and audit history.
- Provide meaningful error messages.

### AI Architecture

Use AI for:
- Understanding.
- Extraction.
- Classification.
- Summarisation.
- Research.
- Pattern recognition.
- Recommendations.
- Natural-language interaction.

Use deterministic backend logic for:
- Identity.
- Permissions.
- Calculations.
- Dates.
- Status transitions.
- Approvals.
- Historical records.
- Financial validation.
- Workflow execution.

AI output must be validated before important database changes.

### Model Routing

Support configurable model routing.

Use:
- Lower-cost models for simple classification and extraction.
- Stronger models for complex reasoning.
- Specialised OCR and transcription services where appropriate.

Track usage by module and workflow.

Support multiple model providers without making the application dependent on one provider.

---

# PART 11: IMPLEMENTATION AND INTEGRATION SEQUENCE

Do not attempt to implement all modules simultaneously without validating dependencies.

Follow this order.

### PHASE 1 – SHARED FOUNDATION

- Inspect existing architecture.
- Establish shared entity definitions.
- Establish identity rules.
- Establish permissions.
- Establish source tracking.
- Establish historical versioning.
- Establish event contracts.
- Establish audit logging.

### PHASE 2 – CORE BUSINESS DATA

Implement and validate:

- Module 1 – Database.
- Module 10 – Input Engine.
- Module 13 – Intelligence Layer.

These form the information and memory foundation.

### PHASE 3 – MARKET AND OPPORTUNITY INTELLIGENCE

Implement and validate:

- Module 2 – Signal Engine.
- Module 3 – Scoring Engine.
- Module 4 – Contact Enrichment.

### PHASE 4 – COMMUNICATION AND MEETING WORKFLOWS

Implement and validate:

- Module 5 – Outreach Engine.
- Module 7 – Meeting Intelligence.

### PHASE 5 – COMMERCIAL AND SUPPLY INTELLIGENCE

Implement and validate:

- Module 14 – Property Supply.
- Module 8 – Deal Toolkit.

### PHASE 6 – TRANSACTION AND LEASE EXECUTION

Implement and validate:

- Module 16 – Transaction Execution.
- Module 15 – Lease Lifecycle.

### PHASE 7 – AUTOMATION

Implement and validate:

- Module 9 – Orchestrator.

Connect all event-driven workflows.

### PHASE 8 – CONVERSATIONAL INTERFACE

Implement and validate:

- Module 12 – Supercharged Assistant.

Make all permitted module capabilities accessible through Ask.

### PHASE 9 – COMPLETE SYSTEM VALIDATION

- Execute all end-to-end workflows.
- Execute integration tests.
- Execute security tests.
- Execute performance tests.
- Execute AI accuracy tests.
- Execute user acceptance tests.
- Fix identified failures.
- Retest affected workflows.
- Prepare a final system quality report.

---

# PART 12: FINAL ACCEPTANCE CRITERIA

The project must not be declared complete until the following conditions are satisfied.

### DATA

- One shared source of truth.
- Stable entity identities.
- No uncontrolled duplicates.
- Historical information preserved.
- Important information source-linked.
- Unknown information correctly represented.

### INTELLIGENCE

- Relevant context retrieved.
- Historical changes understood.
- Signals supported by evidence.
- Scoring explanations available.
- Recommendations distinguish facts from assumptions.

### PROPERTY AND COMMERCIAL

- Property inventory structured.
- Availability status traceable.
- Property matching explainable.
- Commercial comparisons reproducible.
- Historical quotations preserved.
- Lease calculations validated.

### TRANSACTIONS

- Offers version-controlled.
- Negotiations traceable.
- Issues assigned.
- Dependencies visible.
- Approvals enforced.
- Executed terms reconciled.
- Lease information transferred correctly.

### AUTOMATION

- Scheduled jobs work.
- Event triggers work.
- Dependencies work.
- Retries are safe.
- Duplicate actions are prevented.
- Failed jobs are visible.
- Pause and resume work.

### USER EXPERIENCE

- Today works.
- Ask works.
- Capture works.
- Review works.
- Information is reused.
- Repetitive data entry is minimised.
- Actions are understandable.
- Completion status is visible.

### GOVERNANCE

- Permissions enforced.
- Human approvals respected.
- External communications remain manual.
- Audit history maintained.
- Safe recovery available.

### TESTING

- All module tests passed.
- All critical integration tests passed.
- All 14 end-to-end workflows passed.
- No unresolved critical security issues.
- No unresolved critical data-integrity issues.
- Known limitations documented.
- Failed tests have documented remediation.

---

# PART 13: FINAL DEFINITION OF THE PRODUCT

The CRE AI Operating System must function as one connected business environment.

The user should be able to:

- Identify a company worth approaching.
- Understand why it may need real estate advice.
- Identify the actual decision-makers.
- Understand existing relationships.
- Prepare relevant outreach.
- Prepare for meetings.
- Capture conversations.
- Extract requirements.
- Identify suitable property supply.
- Compare commercial alternatives.
- Negotiate terms.
- Execute transactions.
- Monitor leases.
- Identify renewals.
- Maintain client relationships.
- Understand what needs attention each day.

All of this must happen through shared information, contextual intelligence and coordinated workflows.

The user should not need to know which module performs each task.

The system should intelligently coordinate the relevant modules behind the scenes.

## FINAL OPERATING PRINCIPLE

CAPTURE ONCE.

UNDERSTAND THE BUSINESS CONTEXT.

UPDATE THE RIGHT RECORDS.

CONNECT THE RELEVANT MODULES.

IDENTIFY THE NEXT BEST ACTION.

KEEP THE USER IN CONTROL.

MAKE EVERY BUSINESS INTERACTION MORE VALUABLE THAN THE LAST.

THE FINAL PRODUCT MUST NOT FEEL LIKE 14 CONNECTED SOFTWARE MODULES.

IT MUST FEEL LIKE ONE CRE BUSINESS OPERATING SYSTEM.