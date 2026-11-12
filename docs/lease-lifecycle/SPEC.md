# MODULE 15: LEASE LIFECYCLE MANAGEMENT
## Master AI Development and Implementation Prompt

### 1. PROJECT OBJECTIVE

Develop Module 15 – Lease Lifecycle Management for the CRE AI Operating System.

The Lease Lifecycle module must manage and monitor commercial lease agreements throughout their entire lifecycle.

It must provide a centralised system for tracking lease agreements, contractual dates, commercial terms, obligations, financial changes, renewal opportunities, termination conditions and handover activities.

The module must ensure that the user always understands:

- Which leases are currently active.
- Which leases are approaching important dates.
- Which clients have upcoming lease expiries.
- Which leases have upcoming rent escalations.
- Which agreements have lock-in periods.
- Which leases have break options.
- Which notices must be served.
- Which renewals require attention.
- Which contractual obligations remain outstanding.
- Which leases are approaching termination.
- Which transactions require follow-up.

The module must work as part of the existing CRE AI Operating System.

It must not become a basic document storage application or a standalone reminder tool.

Its primary objective is:

TRACK EVERY IMPORTANT LEASE EVENT, PROTECT CLIENT INTERESTS THROUGH TIMELY FOLLOW-UP AND IDENTIFY FUTURE BUSINESS OPPORTUNITIES THROUGH LEASE LIFECYCLE INTELLIGENCE.

---

# 2. LEASE RECORD MANAGEMENT

Create a centralised lease management system.

Every lease must have a unique lease record connected to the relevant company, property, contacts and transaction.

### 2.1 Basic Lease Information

Maintain:

- Lease ID.
- Lease reference number.
- Tenant company.
- Landlord company.
- Property.
- Building.
- Floor.
- Unit.
- Micro-market.
- Lease category.
- Lease status.
- Lease commencement date.
- Lease execution date.
- Lease expiry date.
- Possession date.
- Rent commencement date.
- Lease duration.
- Renewal status.
- Termination status.
- Associated transaction.
- Associated contacts.
- Source documents.

### 2.2 Lease Categories

Support:

- Conventional office leases.
- Managed office agreements.
- Coworking agreements.
- Commercial office agreements.
- Retail commercial leases.
- Industrial and warehouse leases.
- Other configurable commercial property agreements.

Allow different agreement categories to have different fields and tracking requirements.

### 2.3 Lease Status

Maintain the following statuses:

1. Draft.
2. Under Negotiation.
3. Awaiting Approval.
4. Awaiting Execution.
5. Executed.
6. Active.
7. Renewal Under Discussion.
8. Renewal Agreed.
9. Termination Notice Served.
10. Expiring.
11. Expired.
12. Terminated.
13. Surrendered.
14. Closed.

Status changes must be recorded with timestamps and supporting information.

Do not automatically mark a lease as executed or active without the required evidence.

---

# 3. LEASE COMMERCIAL TERMS MANAGEMENT

Maintain all important commercial terms associated with each lease.

### 3.1 Rental Information

Record:

- Initial monthly rent.
- Annual rent.
- Rent per square foot.
- Rentable area.
- Chargeable area.
- Carpet area.
- Super built-up area.
- Area measurement basis.
- CAM charges.
- Parking charges.
- Other recurring charges.
- Security deposit.
- Rent-free period.
- Rent commencement date.
- Payment frequency.
- Payment due date.
- Escalation percentage.
- Escalation frequency.
- Applicable escalation dates.
- Taxes and applicable charges.
- Other commercial conditions.

### 3.2 Lease Duration and Restrictions

Record:

- Lease commencement.
- Lease expiry.
- Initial lease duration.
- Lock-in period.
- Lock-in commencement.
- Lock-in completion.
- Notice period.
- Break clause.
- Early termination conditions.
- Renewal options.
- Renewal notice period.
- Extension conditions.
- Holdover conditions.
- Surrender conditions.

### 3.3 Commercial Term History

Features:

- Preserve original commercial terms.
- Record amendments.
- Track revised rent.
- Track revised CAM.
- Track changes in security deposits.
- Track revised areas.
- Track changes in payment conditions.
- Maintain amendment history.
- Link changes to supporting documents.
- Display previous and current terms.

Never silently overwrite original lease terms.

---

# 4. CRITICAL DATE AND MILESTONE TRACKING

This is one of the most important functionalities of the module.

The system must identify and monitor all important dates in a lease.

### 4.1 Critical Dates

Track:

- Agreement execution date.
- Possession date.
- Lease commencement date.
- Rent commencement date.
- Rent-free period completion.
- Lock-in completion.
- Rent escalation dates.
- Renewal option dates.
- Renewal notice deadlines.
- Break option dates.
- Termination notice deadlines.
- Lease expiry date.
- Security deposit refund deadline, where specified.
- Handover date.
- Other contractual milestones.

### 4.2 Automated Deadline Calculation

The system should calculate relevant dates from the lease terms.

Example:

Lease commencement: 1 January 2027.

Lock-in period: 36 months.

The system should calculate the expected lock-in completion date using the contractual counting convention.

However, it must not assume the correct date calculation convention if the executed agreement specifies a different method.

Store:

- Original contractual wording.
- Extracted date.
- Calculation method.
- Calculated date.
- Verification status.

### 4.3 Critical Date Dashboard

Display:

- Upcoming lease expiries.
- Upcoming lock-in completions.
- Upcoming rent escalations.
- Upcoming renewal deadlines.
- Upcoming break options.
- Upcoming termination notice deadlines.
- Upcoming possession dates.
- Overdue contractual milestones.

Allow filtering by:

- Date.
- Company.
- Property.
- Micro-market.
- Lease status.
- Event category.
- Assigned owner.

---

# 5. LEASE RENEWAL MANAGEMENT

The system must proactively identify leases approaching expiry and manage the renewal process.

### 5.1 Renewal Monitoring

Features:

- Identify leases approaching expiry.
- Identify applicable renewal options.
- Identify renewal notice deadlines.
- Identify required notice periods.
- Identify contractual renewal conditions.
- Track renewal discussions.
- Track landlord and tenant responses.
- Track proposed revised commercial terms.
- Track renewal approvals.
- Track renewal execution.
- Preserve previous lease terms.

### 5.2 Renewal Workflow

When a lease approaches its renewal window:

1. Identify the upcoming expiry.
2. Calculate the relevant notice deadlines.
3. Retrieve the existing lease terms.
4. Retrieve the tenant's current occupancy information.
5. Identify previous rent and CAM.
6. Identify applicable escalation clauses.
7. Retrieve relevant property supply information.
8. Identify potential alternative properties.
9. Create a renewal review task.
10. Notify the assigned user.
11. Track discussions with the tenant and landlord.
12. Record the renewal decision.
13. Update the lease record after appropriate confirmation.

### 5.3 Renewal Decision Support

Provide contextual information to help the user evaluate renewal versus relocation.

Compare:

- Existing monthly rent.
- Existing CAM.
- Proposed revised rent.
- Proposed revised CAM.
- Expected escalation.
- Alternative property costs.
- Relocation costs.
- Fit-out costs.
- Security deposit requirements.
- Downtime.
- Lease flexibility.
- Business continuity.
- Property suitability.

Display assumptions and missing information clearly.

Do not automatically recommend renewal merely because it avoids relocation.

Do not recommend relocation without considering the full cost and operational impact.

### 5.4 Renewal Pipeline

Display:

- Upcoming renewals.
- Renewal discussions started.
- Renewal proposals pending.
- Renewal approvals pending.
- Renewals agreed.
- Renewals completed.
- Renewals at risk.
- Renewals requiring immediate attention.

---

# 6. RENT ESCALATION MANAGEMENT

The system must monitor contractual rent escalations.

Features:

- Store escalation percentage.
- Store escalation frequency.
- Store escalation basis.
- Calculate expected revised rent.
- Calculate expected effective date.
- Track upcoming escalation events.
- Track revised rent after escalation.
- Compare expected and actual rent.
- Record supporting amendments.
- Flag discrepancies.
- Notify the assigned user before escalation dates.

Example:

Current monthly rent: ₹10,00,000.

Escalation: 15% after 36 months.

Expected revised rent: ₹11,50,000.

The system should show:

- Current rent.
- Escalation percentage.
- Expected revised rent.
- Applicable date.
- Source clause.
- Verification status.

The system must support different escalation structures, including fixed percentage, fixed amount and other contractual arrangements.

Do not assume escalation is always compounded or always calculated on the original rent. Follow the executed agreement.

---

# 7. LOCK-IN, BREAK CLAUSE AND TERMINATION MANAGEMENT

### 7.1 Lock-in Tracking

Features:

- Record lock-in period.
- Calculate expected lock-in completion.
- Identify early termination restrictions.
- Identify penalties and obligations.
- Track upcoming lock-in completion.
- Notify the user about relevant milestones.

### 7.2 Break Clause Tracking

Features:

- Record break option conditions.
- Record break option dates.
- Record notice deadlines.
- Identify eligibility conditions.
- Track whether the break option has been exercised.
- Preserve supporting documents.
- Notify the assigned user before relevant deadlines.

### 7.3 Termination Management

Track:

- Termination reason.
- Termination initiation date.
- Notice date.
- Notice period.
- Proposed termination date.
- Confirmed termination date.
- Outstanding obligations.
- Financial settlements.
- Handover requirements.
- Security deposit recovery.
- Final documentation.

Do not assume a lease can be terminated merely because the lock-in period has ended.

The executed agreement and applicable conditions must be reviewed.

---

# 8. FINANCIAL OBLIGATION TRACKING

Maintain visibility into the financial obligations associated with leases.

### 8.1 Financial Information

Track:

- Monthly rent.
- Annual rent.
- CAM.
- Parking charges.
- Security deposit.
- Escalation amounts.
- Rent-free periods.
- Other recurring charges.
- Outstanding payments, where data is available.
- Deposit adjustments.
- Refund obligations.
- Final settlement amounts.

### 8.2 Financial Milestones

Features:

- Identify upcoming rent changes.
- Track payment due dates where provided.
- Track outstanding obligations.
- Track deposit refund deadlines.
- Track commercial amendments.
- Highlight discrepancies between expected and recorded financial values.
- Maintain historical financial records.

The module must not claim that a payment has been made or is outstanding unless supported by connected financial records or verified user input.

### 8.3 Lease Cost Overview

Display:

- Current monthly occupancy cost.
- Annual occupancy cost.
- Known recurring charges.
- Escalation schedule.
- Security deposit.
- Remaining lease duration.
- Future expected cost changes.

Clearly identify excluded or unknown cost components.

---

# 9. LEASE DOCUMENT MANAGEMENT

The system must maintain all documents associated with a lease.

Supported documents:

- Letter of Intent.
- Term Sheet.
- Lease Agreement.
- Leave and Licence Agreement.
- Memorandum of Understanding.
- Commercial Proposal.
- Rent Quotation.
- Lease Amendment.
- Renewal Agreement.
- Termination Notice.
- Handover Documents.
- Possession Documents.
- Security Deposit Records.
- Other supporting documents.

### 9.1 Document Management Features

- Upload documents.
- Associate documents with a lease.
- Maintain document versions.
- Identify document type.
- Extract relevant information.
- Identify key clauses.
- Extract important dates.
- Extract commercial terms.
- Identify missing information.
- Compare amendments with previous versions.
- Link extracted clauses to the relevant lease fields.
- Maintain document history.

### 9.2 Document Verification

The system must distinguish:

- Draft documents.
- Signed documents.
- Executed agreements.
- Unsigned proposals.
- Superseded documents.
- Amendments.
- Supporting documents.

Never treat an unsigned proposal as an executed lease agreement.

Do not assume that an extracted clause is legally interpreted correctly.

Provide source page references for extracted contractual information.

---

# 10. LEASE OBLIGATION AND COMPLIANCE TRACKING

The system must track contractual obligations that require attention.

Examples:

- Notice requirements.
- Renewal notices.
- Rent escalation.
- Insurance obligations.
- Maintenance obligations.
- Repair obligations.
- Fit-out conditions.
- Restoration requirements.
- Permitted-use restrictions.
- Subletting restrictions.
- Assignment restrictions.
- Security deposit obligations.
- Documentation requirements.
- Handover obligations.

Features:

- Extract obligations from lease documents.
- Assign responsible parties.
- Record deadlines.
- Track completion status.
- Track supporting evidence.
- Identify overdue obligations.
- Notify responsible users.
- Maintain obligation history.

Classify obligations by:

- Tenant responsibility.
- Landlord responsibility.
- Shared responsibility.
- Responsibility unclear.

The system should provide administrative tracking and source-linked summaries, not replace legal review or determine legal compliance independently.

---

# 11. LEASE EXPIRY AND HANDOVER MANAGEMENT

The system must manage the transition from an active lease to expiry or termination.

Features:

- Identify upcoming lease expiry.
- Track renewal decisions.
- Track termination decisions.
- Record possession handover requirements.
- Track restoration obligations.
- Track pending maintenance.
- Track outstanding rent and charges.
- Track security deposit recovery.
- Track access card and key handover.
- Track utility settlement.
- Track final inspection.
- Record handover completion.
- Preserve final documentation.

### Handover Checklist

Provide a configurable checklist containing:

- Final property inspection.
- Condition documentation.
- Repair and restoration.
- Removal of tenant assets.
- Utility settlement.
- Access card return.
- Key return.
- Outstanding payment review.
- Security deposit reconciliation.
- Final handover acknowledgement.

Allow users to customise checklist items for each lease.

---

# 12. LEASE PORTFOLIO MANAGEMENT

The system must provide a consolidated view of all leases associated with the user's clients and tracked companies.

Features:

- View all active leases.
- View expired leases.
- View upcoming expiries.
- View leases approaching renewal.
- View leases with upcoming escalations.
- View leases with upcoming lock-in completion.
- View leases with active termination processes.
- View leases requiring attention.
- Filter by tenant.
- Filter by landlord.
- Filter by building.
- Filter by micro-market.
- Filter by lease category.
- Filter by assigned user.

### Portfolio Dashboard

Display:

- Total active leases.
- Total leased area.
- Total monthly rent.
- Total annual rent.
- Upcoming lease expiries.
- Upcoming renewal deadlines.
- Upcoming escalations.
- Upcoming lock-in completions.
- Termination pipeline.
- Pending obligations.
- Leases with incomplete information.

Financial aggregates must include only records with compatible, known values.

Clearly identify missing data and avoid misleading totals.

---

# 13. LEASE-BASED BUSINESS OPPORTUNITY IDENTIFICATION

The Lease Lifecycle module must identify potential CRE advisory opportunities from lease events.

Examples:

- A client approaching lease expiry.
- A client approaching a lock-in completion.
- A client facing a major rent escalation.
- A company considering relocation.
- A company requiring additional space.
- A tenant evaluating renewal versus relocation.
- A landlord preparing for upcoming vacancy.
- A company with multiple leases expiring within a similar period.

Features:

- Identify potential opportunities.
- Connect events to relevant company records.
- Retrieve existing relationship history.
- Identify decision-makers.
- Retrieve relevant property requirements.
- Identify suitable alternative supply.
- Generate a proposed next action.
- Notify the Orchestrator.
- Provide the information to the relevant sales and advisory modules.

Important rule:

A lease expiry is a potential business opportunity, not proof that the tenant intends to relocate.

The system must not automatically classify every expiry as a confirmed requirement.

---

# 14. AUTOMATED ALERTS AND REMINDERS

Provide configurable reminders for critical lease events.

Examples:

- 12 months before expiry.
- 9 months before expiry.
- 6 months before expiry.
- 3 months before expiry.
- 90 days before a notice deadline.
- 60 days before a notice deadline.
- 30 days before a notice deadline.
- Before rent escalation.
- Before lock-in completion.
- Before break option deadlines.
- Before quotation or amendment expiry.

Reminder periods must be configurable according to the contractual requirements and business workflow.

The system must calculate reminders from the actual contractual dates and conditions.

Features:

- Create reminders.
- Assign responsible users.
- Track reminder completion.
- Escalate overdue tasks.
- Avoid duplicate reminders.
- Cancel obsolete reminders when dates or statuses change.
- Preserve reminder history.

---

# 15. MAIN USER INTERFACE

### A. Lease Dashboard

Display:

- Active leases.
- Upcoming expiries.
- Upcoming renewals.
- Upcoming rent escalations.
- Upcoming lock-in completions.
- Upcoming break options.
- Pending obligations.
- Leases requiring attention.

### B. Lease Detail Screen

Display:

- Lease overview.
- Tenant.
- Landlord.
- Property.
- Commercial terms.
- Important dates.
- Lease clauses.
- Financial information.
- Associated documents.
- Related contacts.
- Obligations.
- Renewal history.
- Amendment history.
- Activity timeline.

### C. Lease Calendar

Display important milestones on a calendar.

Allow filtering by:

- Lease.
- Company.
- Property.
- Event type.
- Assigned user.
- Date range.

### D. Renewal Pipeline

Display:

- Upcoming renewals.
- Renewal discussions.
- Pending proposals.
- Negotiations.
- Agreed renewals.
- Completed renewals.
- At-risk renewals.

### E. Obligation Tracker

Display:

- Obligation.
- Responsible party.
- Deadline.
- Status.
- Source clause.
- Assigned user.
- Supporting documents.
- Completion evidence.

### F. Lease Portfolio

Display consolidated lease information and important financial and operational metrics.

---

# 16. AUTOMATION AND MODULE INTEGRATION

The Lease Lifecycle module must integrate with the other CRE modules.

### Module 1 – Database

- Store lease records.
- Maintain company and property relationships.
- Store commercial terms.
- Preserve historical information.
- Maintain document references.

### Module 2 – Signal Engine

- Provide lease expiry signals.
- Identify upcoming vacancy possibilities.
- Identify significant lease-related developments.
- Supply evidence for relevant business signals.

### Module 3 – Scoring Engine

- Provide lease timing information.
- Identify requirement readiness.
- Support prioritisation of lease-related opportunities.

### Module 4 – Contact Enrichment

- Identify tenant decision-makers.
- Identify landlord contacts.
- Maintain relevant professional relationships.

### Module 5 – Outreach Engine

- Provide context for lease-related outreach.
- Identify relevant follow-up opportunities.
- Supply source-linked information for proposed communications.

### Module 7 – Meeting Intelligence

- Provide lease history before meetings.
- Retrieve important contractual milestones.
- Capture renewal and termination discussions.

### Module 8 – Deal Toolkit

- Provide existing lease commercial terms.
- Support renewal versus relocation comparisons.
- Compare revised offers.
- Support negotiations.

### Module 9 – Orchestrator

Trigger workflows when:

- A lease approaches expiry.
- A notice deadline approaches.
- A rent escalation is due.
- A lock-in period ends.
- A break option becomes available.
- A renewal is agreed.
- A termination notice is recorded.
- A handover milestone becomes overdue.

### Module 10 – Input Engine

Accept and process:

- Lease agreements.
- Lease amendments.
- Renewal letters.
- Termination notices.
- Commercial proposals.
- Rent schedules.
- Handover documents.

Extract relevant dates, commercial terms and obligations.

### Module 13 – Intelligence Layer

- Maintain historical lease context.
- Understand changes in client requirements.
- Identify recurring lease-related patterns.
- Retrieve previous negotiations.
- Preserve relationship and transaction history.

### Module 14 – Property Supply

- Retrieve alternative properties.
- Identify available supply.
- Support renewal versus relocation analysis.
- Match alternatives against existing lease requirements.

### Module 12 – Supercharged Assistant

Support questions such as:

- Which client leases expire in the next 12 months?
- Which leases have renewal deadlines approaching?
- Which leases have upcoming rent escalations?
- Which clients are approaching lock-in completion?
- Which leases have break options?
- What is the current rent for this client?
- What are the contractual notice requirements?
- Which clients should we contact about upcoming renewals?
- Which alternative properties match this client's current lease requirement?

Answers must be grounded in recorded lease information and supporting documents.

---

# 17. IMPORTANT BUSINESS AND DATA RULES

The following rules are mandatory.

1. Never treat a draft agreement as an executed lease.

2. Never assume a lease is active without the required evidence.

3. Never assume lease expiry means the tenant will vacate.

4. Never assume lock-in completion means immediate termination is permitted.

5. Never calculate contractual notice deadlines without considering the agreement's actual conditions.

6. Preserve original contractual wording and extracted clause references.

7. Never overwrite historical commercial terms.

8. Distinguish proposed amendments from executed amendments.

9. Distinguish contractual dates from estimated dates.

10. Never assume missing financial values are zero.

11. Clearly distinguish rent from CAM and other charges.

12. Preserve the source of every important contractual value.

13. Flag conflicting dates and terms for review.

14. Never send contractual notices or external communications automatically.

15. Require human review for material lease record changes.

16. Maintain a complete audit trail.

17. Never present AI-generated legal interpretations as verified legal advice.

18. Do not automatically create a confirmed property requirement from an upcoming lease expiry.

19. Recalculate affected reminders when contractual dates change.

20. Preserve historical versions of executed agreements and amendments.

---

# 18. END-TO-END TEST SCENARIOS

Test the following scenarios:

1. Create a new lease record.
2. Associate the lease with a company and property.
3. Upload an executed lease agreement.
4. Extract commercial terms.
5. Extract lease commencement and expiry dates.
6. Extract lock-in period.
7. Extract notice period.
8. Extract rent escalation clauses.
9. Extract break option clauses.
10. Identify uncertain contractual dates.
11. Identify conflicting information between documents.
12. Record an amendment.
13. Preserve original commercial terms.
14. Calculate an upcoming escalation.
15. Identify an upcoming lease expiry.
16. Calculate a renewal notice deadline.
17. Track a renewal discussion.
18. Record a renewal agreement.
19. Track a termination process.
20. Track a handover checklist.
21. Track security deposit recovery.
22. Identify a lease-based business opportunity.
23. Retrieve alternative properties from Module 14.
24. Trigger reminders through Module 9.
25. Retrieve lease context through Module 12.
26. Verify historical information preservation.
27. Verify that draft documents are not treated as executed agreements.
28. Verify that lease expiry does not automatically create a confirmed relocation requirement.
29. Verify access permissions.
30. Verify the complete lease audit history.

Each test must validate calculation accuracy, source traceability, date handling, historical preservation, workflow triggering and approval controls.

---

# 19. IMPLEMENTATION PRIORITY

Build the module in the following order.

PHASE 1 – LEASE RECORD MANAGEMENT
- Lease creation.
- Company and property associations.
- Lease status.
- Basic commercial terms.

PHASE 2 – CONTRACTUAL INFORMATION
- Important dates.
- Lock-in.
- Notice period.
- Break options.
- Escalations.
- Renewal clauses.

PHASE 3 – DOCUMENT MANAGEMENT
- Document uploads.
- Document classification.
- Clause extraction.
- Document versioning.
- Source traceability.

PHASE 4 – LIFECYCLE TRACKING
- Critical date tracking.
- Reminder engine.
- Renewal management.
- Termination management.
- Handover management.

PHASE 5 – FINANCIAL MANAGEMENT
- Rent schedules.
- Escalations.
- CAM.
- Security deposits.
- Historical financial records.

PHASE 6 – PORTFOLIO MANAGEMENT
- Lease dashboard.
- Renewal pipeline.
- Critical date calendar.
- Obligation tracker.
- Portfolio analytics.

PHASE 7 – BUSINESS OPPORTUNITY IDENTIFICATION
- Expiry-based opportunities.
- Renewal versus relocation.
- Alternative supply matching.
- Relationship-based follow-ups.

PHASE 8 – SYSTEM INTEGRATION AND TESTING
- Connect all relevant modules.
- Implement event-driven automation.
- Validate contractual calculations.
- Test historical preservation.
- Test end-to-end workflows.

---

# 20. FINAL EXPECTED OUTCOME

The Lease Lifecycle module must provide complete visibility into every important stage of a commercial lease.

The user should be able to understand:

- What leases exist.
- Which leases are active.
- What commercial terms apply.
- When important contractual dates occur.
- Which obligations are pending.
- Which rent escalations are approaching.
- Which renewal opportunities exist.
- Which notice deadlines require attention.
- Which leases may terminate.
- What handover activities remain.
- Which clients may need relocation or renewal advisory.
- Which alternative properties are available.

The module must transform static lease agreements into actionable, continuously monitored business records.

The ultimate objective is to prevent missed lease deadlines, improve client retention, identify upcoming CRE advisory opportunities and maintain visibility throughout the entire lease lifecycle.

CORE PRINCIPLE:

A LEASE AGREEMENT SHOULD NEVER BECOME A FORGOTTEN DOCUMENT.

IT SHOULD BECOME AN ACTIVE BUSINESS RECORD THAT TRACKS OBLIGATIONS, DATES, COMMERCIAL CHANGES, RENEWAL OPPORTUNITIES AND THE NEXT ACTION REQUIRED.