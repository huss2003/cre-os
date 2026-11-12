# MODULE 16: TRANSACTION EXECUTION AND NEGOTIATION
## Master AI Development and Implementation Prompt

### 1. PROJECT OBJECTIVE

Develop Module 16 – Transaction Execution and Negotiation for the CRE AI Operating System.

The module must manage the detailed execution of commercial real estate transactions, starting when a client requirement is confirmed and continuing until the transaction is executed and the relevant handover activities are completed.

It must function as a central transaction command centre.

The system must coordinate:

- Transaction planning.
- Negotiation management.
- Offers and counteroffers.
- Commercial comparisons.
- Client requirements.
- Adviser recommendations.
- Landlord and operator proposals.
- Technical inspections.
- Legal and documentary requirements.
- Approvals.
- Letters of Intent (LOIs).
- Term sheets.
- Lease agreements.
- Deposits.
- Execution.
- Possession.
- Fit-out.
- Handover.
- Closure documentation.

The module must integrate with the existing CRE AI Operating System.

Do not build an isolated CRM or duplicate the existing Database, Deal Toolkit, Lease Lifecycle or Property Supply modules.

The objective is to turn every confirmed requirement into a structured, trackable transaction with a clear route to completion.

---

# 2. TRANSACTION CREATION AND WORKSPACE

Once a client requirement is confirmed and a transaction is ready to be actively progressed, the system must create a dedicated transaction workspace.

### 2.1 Transaction Creation

Features:

- Create a new transaction.
- Generate a unique transaction ID.
- Associate the transaction with the client company.
- Associate relevant contacts.
- Associate the property or properties under consideration.
- Associate the confirmed requirement.
- Assign an internal transaction owner.
- Record transaction creation date.
- Record transaction type.
- Record transaction status.
- Maintain transaction history.

### 2.2 Transaction Folder

Create a dedicated folder or equivalent logical workspace containing all relevant transaction information.

Organise the information into:

1. Transaction Overview.
2. Client Requirements.
3. Property Information.
4. Offers and Counteroffers.
5. Commercial Negotiations.
6. Technical Inspections.
7. Open Issues.
8. Stakeholders.
9. Approvals.
10. LOI and Term Sheet.
11. Legal Documents.
12. Financial Information.
13. Execution Milestones.
14. Possession and Fit-out.
15. Handover.
16. Closure Pack.

Features:

- Store transaction-related documents.
- Store negotiation records.
- Store meeting notes.
- Store commercial proposals.
- Store inspection reports.
- Store approvals.
- Store correspondence references.
- Maintain document versions.
- Maintain a chronological transaction timeline.
- Preserve historical information.

All records must remain connected to the central database.

---

# 3. TRANSACTION TYPE AND PLANNING

The system must generate a transaction plan appropriate to the type of CRE transaction.

### 3.1 Supported Transaction Types

Support:

1. Conventional Leasing.
2. Managed Office.
3. Coworking.
4. Lease Renewal.
5. Relocation.
6. Build-to-Suit (BTS).
7. Commercial Property Investment.

Allow additional transaction types to be configured.

### 3.2 Transaction-Specific Workflows

Each transaction type must have its own configurable workflow template.

#### A. Conventional Leasing

Typical stages:

- Requirement confirmation.
- Property identification.
- Property shortlist.
- Availability confirmation.
- Site visits.
- Client feedback.
- Commercial proposal.
- Negotiation.
- LOI.
- Legal documentation.
- Agreement execution.
- Deposit.
- Possession.
- Fit-out.
- Handover.

#### B. Managed Office

Typical stages:

- Requirement confirmation.
- Operator identification.
- Capacity confirmation.
- Location comparison.
- Commercial proposal.
- Seat and configuration confirmation.
- Service and amenity clarification.
- Negotiation.
- Agreement.
- Payment and deposit.
- Access and onboarding.
- Occupancy.

#### C. Lease Renewal

Typical stages:

- Existing lease review.
- Renewal timeline review.
- Client consultation.
- Existing commercial assessment.
- Landlord proposal.
- Alternative property assessment.
- Renewal versus relocation comparison.
- Negotiation.
- Approval.
- Renewal documentation.
- Execution.

#### D. Relocation

Typical stages:

- Existing lease assessment.
- New requirement confirmation.
- Property search.
- Property comparison.
- Site visits.
- Commercial negotiations.
- Relocation cost assessment.
- Existing lease exit planning.
- New agreement.
- Possession.
- Fit-out.
- Relocation.
- Handover.

#### E. Build-to-Suit

Typical stages:

- Requirement confirmation.
- Site identification.
- Feasibility assessment.
- Technical specifications.
- Development proposal.
- Commercial negotiations.
- Design approval.
- Development milestones.
- Inspection.
- Completion.
- Agreement and possession.
- Handover.

#### F. Investment

Typical stages:

- Investment requirement.
- Asset identification.
- Initial evaluation.
- Financial analysis.
- Due diligence.
- Commercial negotiation.
- Legal review.
- Approval.
- Documentation.
- Transaction execution.
- Closing and handover.

The system must allow users to customise stages without changing the underlying transaction architecture.

---

# 4. OFFER AND COUNTEROFFER MANAGEMENT

This is one of the most important functionalities of Module 16.

The system must maintain a complete version history of offers and counteroffers.

### 4.1 Offer Creation

Record:

- Offer ID.
- Transaction ID.
- Offering party.
- Receiving party.
- Property.
- Offer date.
- Offer validity.
- Quoted area.
- Area measurement type.
- Rent.
- CAM.
- Security deposit.
- Rent-free period.
- Rent escalation.
- Lock-in period.
- Lease duration.
- Fit-out support.
- Possession conditions.
- Parking.
- Other concessions.
- Additional conditions.
- Source document.
- Submitted by.
- Approval status.

### 4.2 Counteroffer Management

Features:

- Create counteroffers.
- Link counteroffers to the original offer.
- Record proposed changes.
- Identify changed commercial terms.
- Maintain negotiation history.
- Record the party making the counteroffer.
- Record the date.
- Record the reason for the change.
- Track acceptance or rejection.
- Track pending responses.
- Preserve all previous versions.

### 4.3 Offer Comparison

Allow users to compare:

- Original offer.
- First counteroffer.
- Revised offer.
- Final proposed offer.
- Commercially agreed terms.

Highlight:

- Rent changes.
- CAM changes.
- Deposit changes.
- Escalation changes.
- Lock-in changes.
- Rent-free period changes.
- Fit-out support changes.
- Flexibility changes.
- Handover changes.
- Other contractual changes.

Never overwrite an earlier offer.

---

# 5. NEGOTIATION AND CONCESSION MANAGEMENT

The system must compare negotiations as complete commercial packages rather than looking only at headline rent.

### 5.1 Negotiation Variables

Track:

- Rent.
- CAM.
- Rent-free period.
- Security deposit.
- Rent escalation.
- Lock-in period.
- Lease duration.
- Fit-out support.
- Fit-out contribution.
- Possession date.
- Handover condition.
- Parking.
- Early termination flexibility.
- Renewal options.
- Other commercial concessions.

### 5.2 Concession Comparison

Features:

- Compare different concession packages.
- Calculate known commercial differences.
- Identify the financial impact of concessions.
- Highlight changes in contractual flexibility.
- Compare landlord and tenant positions.
- Identify trade-offs between commercial terms.
- Maintain negotiation history.

Example:

Offer A:
- Rent: ₹100/SF.
- CAM: ₹15/SF.
- Rent-free period: 3 months.
- Deposit: 6 months.

Offer B:
- Rent: ₹95/SF.
- CAM: ₹20/SF.
- Rent-free period: 1 month.
- Deposit: 4 months.

The system should compare the full commercial package rather than automatically declaring Offer B better because its headline rent is lower.

Clearly identify assumptions and missing financial components.

### 5.3 Negotiation Intelligence

The AI should assist the user by:

- Identifying negotiation gaps.
- Identifying changes between offers.
- Highlighting unfavourable clauses.
- Identifying missing commercial information.
- Suggesting questions to clarify.
- Identifying potential negotiation opportunities.
- Preparing comparison summaries.
- Highlighting trade-offs.

AI recommendations must remain suggestions.

The system must not independently make commercial commitments.

---

# 6. SEPARATION OF COMMERCIAL POSITIONS

The system must maintain a clear distinction between three types of information.

### 6.1 Client Requirements

What the client wants or has explicitly requested.

Examples:
- Maximum budget.
- Preferred location.
- Required area.
- Desired possession date.
- Required parking.
- Commercial flexibility.

### 6.2 Adviser Recommendations

What the CRE adviser recommends based on available information.

Examples:
- Recommended properties.
- Recommended commercial terms.
- Suggested counteroffer.
- Recommended negotiation strategy.
- Recommended alternative options.

### 6.3 Counterparty Proposals

What the landlord, developer or operator has offered.

Examples:
- Quoted rent.
- Deposit conditions.
- Lock-in requirements.
- Rent escalation.
- Fit-out contribution.
- Possession conditions.

These three categories must remain separate throughout the transaction.

Never convert an adviser recommendation into a client instruction or a counterparty proposal into an agreed commercial term.

---

# 7. LIVE ISSUES AND ACTION TRACKER

Every transaction must have a live issues list.

### 7.1 Issue Creation

Record:

- Issue ID.
- Transaction ID.
- Issue title.
- Description.
- Issue category.
- Responsible party.
- Internal owner.
- Priority.
- Date identified.
- Due date.
- Current status.
- Decision required.
- Supporting documents.
- Dependencies.
- Resolution details.

### 7.2 Issue Categories

Support:

- Commercial.
- Technical.
- Legal.
- Financial.
- Documentation.
- Property.
- Approval.
- Possession.
- Fit-out.
- Handover.
- Other.

### 7.3 Issue Status

Support:

- Open.
- Under Review.
- Awaiting Client.
- Awaiting Landlord.
- Awaiting Operator.
- Awaiting Legal.
- Awaiting Finance.
- Awaiting Approval.
- Resolved.
- Closed.

### 7.4 Issue Management Rules

- Every unresolved issue must have a next action.
- Every issue must have an owner.
- Every issue must have a due date or an explicitly recorded reason why no due date applies.
- Identify overdue issues.
- Highlight issues blocking transaction progress.
- Identify issues dependent on other activities.
- Track resolution history.
- Notify the assigned user about important overdue issues.

---

# 8. TECHNICAL INSPECTIONS AND DOCUMENTARY CLARIFICATIONS

The system must coordinate technical inspections and property-related clarifications.

### 8.1 Technical Inspection Management

Record:

- Property.
- Inspection date.
- Inspection participants.
- Inspection type.
- Inspection findings.
- Photographs.
- Inspection reports.
- Technical observations.
- Outstanding concerns.
- Responsible party.
- Resolution status.

### 8.2 Technical Clarifications

Track:

- HVAC specifications.
- Electrical capacity.
- Power backup.
- Floor loading.
- Fire safety documentation.
- Lift capacity.
- Internet connectivity.
- Parking.
- Building access.
- Fit-out conditions.
- Other technical requirements.

Features:

- Record clarification requests.
- Assign responsible parties.
- Track responses.
- Attach supporting documents.
- Compare responses against client requirements.
- Highlight unresolved discrepancies.

### 8.3 Documentary Requests

Track requested documents such as:

- Property ownership documents.
- Authorisation documents.
- Building approvals.
- Occupancy-related documentation.
- Technical specifications.
- Floor plans.
- Commercial proposals.
- Lease drafts.
- Other transaction-specific documents.

Maintain the request date, responsible party, due date and received status.

Do not treat a document as verified merely because it has been uploaded.

---

# 9. STAKEHOLDER COORDINATION

The system must coordinate all parties involved in a transaction.

### 9.1 Stakeholder Categories

Support:

- Client.
- Client decision-maker.
- Client finance team.
- Client procurement team.
- Client legal team.
- Landlord.
- Developer.
- Asset manager.
- Property manager.
- Leasing representative.
- Managed office operator.
- Legal adviser.
- Procurement adviser.
- Finance representative.
- Fit-out contractor.
- Technical consultant.
- Internal transaction team.

### 9.2 Stakeholder Management

For every participant, maintain:

- Name.
- Organisation.
- Designation.
- Role in transaction.
- Contact details.
- Responsibilities.
- Pending actions.
- Decision authority.
- Relevant communications.
- Participation history.

### 9.3 Coordination Features

- Assign tasks to relevant stakeholders.
- Track pending responses.
- Identify decision-makers.
- Track approval dependencies.
- Maintain a communication history.
- Record meeting outcomes.
- Identify stakeholders blocking progress.
- Maintain internal and external responsibility distinctions.

External messages must remain subject to human review and manual sending.

---

# 10. LOI AND TERM-SHEET MANAGEMENT

The system must manage the progression from negotiated commercial terms to formal documentation.

### 10.1 Letter of Intent

Track:

- LOI preparation.
- LOI version.
- LOI submission.
- Client review.
- Counterparty review.
- Negotiation points.
- Approval status.
- Signing status.
- Execution date.
- Supporting documents.

### 10.2 Term Sheet

Track:

- Term sheet creation.
- Commercial points.
- Open conditions.
- Agreed conditions.
- Disputed conditions.
- Approval status.
- Version history.
- Signing status.

### 10.3 Commercial Agreement Tracker

Maintain a structured list of commercial points and their status.

Classify each point as:

- Proposed.
- Under Negotiation.
- Agreed.
- Rejected.
- Pending Clarification.
- Subject to Approval.
- Documented.
- Verified Against Executed Agreement.

The system must distinguish commercially agreed points from terms that have actually been incorporated into an executed agreement.

---

# 11. AGREEMENT VERSION COMPARISON

The system must compare agreed commercial points against subsequent document versions.

### 11.1 Document Comparison

Features:

- Upload agreement drafts.
- Maintain version history.
- Compare successive versions.
- Identify added clauses.
- Identify removed clauses.
- Identify modified clauses.
- Identify changed dates.
- Identify changed financial terms.
- Identify changed obligations.
- Highlight differences from the commercially agreed terms.

### 11.2 Commercial Term Reconciliation

Compare the latest agreement against the approved commercial position.

Identify:

- Rent mismatches.
- CAM mismatches.
- Deposit mismatches.
- Lock-in mismatches.
- Escalation mismatches.
- Lease duration mismatches.
- Possession mismatches.
- Rent-free period mismatches.
- Fit-out support mismatches.
- Other agreed-term discrepancies.

### 11.3 Review and Approval

- Generate a document difference report.
- Link each difference to the relevant source.
- Highlight material changes.
- Assign changes to the appropriate reviewer.
- Track reviewer decisions.
- Preserve review history.

AI can identify clause differences and questions.

Legal clearance must remain with the legal team.

Never mark a legal clause as approved simply because AI has analysed it.

---

# 12. APPROVAL MANAGEMENT

The system must manage approvals for material transaction decisions.

### 12.1 Approval Categories

Support:

- Client commercial approval.
- Internal adviser approval.
- Landlord approval.
- Operator approval.
- Financial approval.
- Legal approval.
- Technical approval.
- Management approval.

### 12.2 Approval Records

Maintain:

- Approval ID.
- Transaction ID.
- Approval type.
- Requested by.
- Assigned reviewer.
- Date requested.
- Deadline.
- Supporting documents.
- Decision.
- Decision date.
- Comments.
- Version approved.

### 12.3 Approval Status

Support:

- Not Required.
- Pending.
- Under Review.
- Approved.
- Rejected.
- Changes Requested.
- Withdrawn.

### 12.4 Approval Rules

- No unapproved commercial commitment may be communicated.
- Material agreement changes must return to the appropriate reviewer.
- Approval must be linked to the exact version being reviewed.
- Changes to an approved version must invalidate or trigger reassessment of the relevant approval.
- Maintain a complete audit trail.
- External communications must require human approval.

---

# 13. DEPOSITS, EXECUTION AND FINANCIAL MILESTONES

Track important financial and execution milestones.

### 13.1 Deposit Management

Record:

- Deposit type.
- Amount.
- Due date.
- Responsible party.
- Payment status.
- Payment date.
- Receipt reference.
- Refund conditions.
- Supporting documents.

### 13.2 Execution Management

Track:

- Final agreement version.
- Legal clearance.
- Commercial approval.
- Client approval.
- Counterparty approval.
- Signature status.
- Execution date.
- Executed document.
- Outstanding conditions.

### 13.3 Financial Rules

Distinguish between:

- Deposit proposed.
- Deposit approved.
- Deposit due.
- Deposit paid.
- Deposit acknowledged.
- Deposit refundable.
- Deposit refunded.

Do not assume that an approved or due deposit has been paid.

Do not record a transaction as financially completed without supporting information.

---

# 14. POSSESSION, FIT-OUT AND HANDOVER MANAGEMENT

The system must continue tracking the transaction after agreement execution.

### 14.1 Possession Milestones

Record:

- Expected possession date.
- Confirmed possession date.
- Possession conditions.
- Property readiness.
- Outstanding conditions.
- Possession inspection.
- Possession acknowledgement.

### 14.2 Fit-Out Management

Track:

- Fit-out requirements.
- Fit-out scope.
- Fit-out approvals.
- Contractor details.
- Fit-out start date.
- Target completion date.
- Progress.
- Delays.
- Outstanding work.
- Final inspection.

### 14.3 Handover Observations

Record:

- Property condition.
- Outstanding defects.
- Incomplete work.
- Technical observations.
- Photographs.
- Responsible party.
- Resolution deadline.
- Completion status.

### 14.4 Handover Completion

Features:

- Generate a handover checklist.
- Record completed items.
- Record outstanding items.
- Attach supporting evidence.
- Assign unresolved items.
- Record acknowledgement.
- Preserve final handover documents.

---

# 15. TRANSACTION TIMELINE AND COMMAND VIEW

This is the main interface of Module 16.

The system must provide a transaction command view showing:

- Transaction overview.
- Current stage.
- Agreed terms.
- Open issues.
- Pending decisions.
- Dependencies.
- Assigned stakeholders.
- Approval status.
- Document status.
- Upcoming deadlines.
- Blockers.
- Next actions.
- Route to completion.

### 15.1 Transaction Overview

Display:

- Transaction name.
- Client.
- Property.
- Transaction type.
- Transaction owner.
- Transaction stage.
- Current status.
- Expected completion date.
- Transaction priority.

### 15.2 Negotiation View

Display:

- Latest offer.
- Latest counteroffer.
- Previous versions.
- Agreed commercial points.
- Disputed points.
- Pending clarifications.
- Proposed concessions.

### 15.3 Issues View

Display:

- Open issues.
- Overdue issues.
- Blocking issues.
- Responsible owners.
- Next actions.
- Due dates.

### 15.4 Dependencies View

Display:

- Tasks waiting on approvals.
- Documents waiting on signatures.
- Inspections waiting on access.
- Commercial terms waiting on decisions.
- Possession waiting on conditions.
- Fit-out waiting on approvals.

### 15.5 Timeline View

Provide a chronological timeline containing:

- Requirement confirmation.
- Transaction creation.
- Property shortlist.
- Site visits.
- Offers.
- Counteroffers.
- Negotiation decisions.
- Technical inspections.
- LOI.
- Term sheet.
- Agreement versions.
- Approvals.
- Deposits.
- Execution.
- Possession.
- Fit-out.
- Handover.

---

# 16. TRANSACTION CLOSURE PACK

When a transaction reaches closure, generate a structured closure pack.

Include:

- Transaction overview.
- Client details.
- Property details.
- Transaction type.
- Final commercial terms.
- Final agreed area.
- Rent and CAM.
- Deposit.
- Escalation.
- Lock-in.
- Lease duration.
- Possession date.
- Executed agreement reference.
- Important approvals.
- Final offer history.
- Outstanding obligations.
- Handover observations.
- Pending post-execution activities.

The closure pack must distinguish between:

- Commercially agreed.
- Legally approved.
- Signed.
- Executed.
- Possession completed.
- Occupied.
- Handover completed.

These milestones must never be treated as interchangeable.

---

# 17. AUTOMATION AND MODULE INTEGRATION

Module 16 must operate as part of the connected CRE AI Operating System.

### Module 1 – Database

- Store transaction records.
- Maintain transaction relationships.
- Store commercial terms.
- Store documents and references.
- Maintain historical information.

### Module 3 – Scoring Engine

- Provide transaction priority context.
- Identify transaction health.
- Highlight opportunities requiring attention.

### Module 7 – Meeting Intelligence

- Retrieve transaction context before negotiations.
- Capture meeting decisions.
- Extract commitments.
- Update relevant transaction records.

### Module 8 – Deal Toolkit

- Provide commercial calculations.
- Compare property offers.
- Evaluate financial concessions.
- Support negotiation analysis.

### Module 9 – Orchestrator

Trigger workflows when:

- A new offer is received.
- A counteroffer is created.
- An offer is approaching expiry.
- An issue becomes overdue.
- An approval is pending.
- A document version changes.
- A material commercial term changes.
- An agreement is executed.
- Possession is approaching.
- Handover is incomplete.

### Module 10 – Input Engine

Accept:

- Commercial proposals.
- Counteroffers.
- Inspection reports.
- Technical documents.
- LOIs.
- Term sheets.
- Lease agreement drafts.
- Executed agreements.
- Handover documents.

Extract relevant information and send it through the validation process.

### Module 13 – Intelligence Layer

- Retrieve client relationship context.
- Retrieve previous negotiations.
- Remember historical commercial preferences.
- Identify previous objections.
- Maintain transaction history.

### Module 14 – Property Supply

- Retrieve matching properties.
- Verify supply information.
- Provide property availability.
- Supply commercial quotations.
- Identify alternative properties.

### Module 15 – Lease Lifecycle

- Receive executed lease information.
- Create or update the relevant lease record.
- Track lease commencement and expiry.
- Track contractual obligations.
- Continue monitoring after transaction execution.

### Module 12 – Supercharged Assistant

Support questions such as:

- What is blocking this transaction?
- What is the latest agreed rent?
- Which commercial terms remain unresolved?
- What was the landlord's last counteroffer?
- Which approvals are pending?
- Which documents are outstanding?
- What is the next action?
- Which stakeholder is responsible?
- What changed in the latest agreement?
- What needs to happen before possession?

The assistant must retrieve actual transaction information and must not invent negotiation outcomes or approvals.

---

# 18. IMPORTANT BUSINESS RULES

The following rules are mandatory.

1. No unapproved commercial commitment may be communicated.

2. Material agreement changes must return to the appropriate reviewer.

3. Client requirements, adviser recommendations and counterparty proposals must remain separate.

4. Every unresolved issue must have a next action.

5. Every important issue must have an owner.

6. Preserve all offer and counteroffer versions.

7. Never overwrite previously agreed commercial terms.

8. Commercially agreed, signed and occupied are distinct milestones.

9. Legal clearance must remain with the legal team.

10. AI can identify clause differences and questions but cannot independently provide final legal clearance.

11. An approval must be linked to the exact version reviewed.

12. A revised document must trigger appropriate reassessment of earlier approvals.

13. A deposit being due does not mean it has been paid.

14. Agreement execution does not automatically establish possession.

15. Possession does not automatically establish occupancy.

16. Every material transaction change must have a source and audit record.

17. All external communications must follow human review and manual-send requirements.

18. No transaction should be marked complete while required closure conditions remain unresolved.

---

# 19. END-TO-END TEST SCENARIOS

Test the following scenarios:

1. Create a conventional leasing transaction.
2. Create a managed office transaction.
3. Create a renewal transaction.
4. Create a relocation transaction.
5. Create a BTS transaction.
6. Create an investment transaction.
7. Generate a transaction-specific plan.
8. Create an initial offer.
9. Create multiple counteroffers.
10. Compare offer versions.
11. Compare complete concession packages.
12. Separate client requirements from adviser recommendations.
13. Separate counterparty proposals from agreed terms.
14. Create an unresolved commercial issue.
15. Assign an issue to a stakeholder.
16. Track overdue issues.
17. Record a technical inspection.
18. Track documentary requests.
19. Coordinate multiple stakeholders.
20. Create an LOI.
21. Track term-sheet approval.
22. Compare agreement versions.
23. Identify differences from commercially agreed terms.
24. Trigger legal review.
25. Track financial approval.
26. Track deposit due and paid statuses separately.
27. Record agreement execution.
28. Record possession.
29. Track fit-out.
30. Record handover observations.
31. Generate the closure pack.
32. Transfer executed lease information to Module 15.
33. Trigger Orchestrator workflows.
34. Verify transaction history.
35. Verify that no unapproved commercial commitment can be communicated.
36. Verify approval version control.
37. Verify all milestone distinctions.

Each test must validate transaction integrity, commercial accuracy, version control, approval enforcement, stakeholder coordination and audit history.

---

# 20. IMPLEMENTATION PRIORITY

Build Module 16 in the following order.

PHASE 1 – TRANSACTION FOUNDATION
- Transaction creation.
- Transaction workspace.
- Transaction types.
- Workflow templates.
- Stakeholder assignment.

PHASE 2 – NEGOTIATION MANAGEMENT
- Offer creation.
- Counteroffer management.
- Version history.
- Commercial comparison.
- Concession analysis.

PHASE 3 – ISSUE AND DEPENDENCY MANAGEMENT
- Live issues list.
- Ownership.
- Deadlines.
- Dependencies.
- Blocker tracking.

PHASE 4 – TECHNICAL AND STAKEHOLDER COORDINATION
- Inspections.
- Clarifications.
- Documentary requests.
- Stakeholder assignments.
- Pending responses.

PHASE 5 – DOCUMENTATION AND APPROVALS
- LOI.
- Term sheet.
- Agreement tracking.
- Document comparison.
- Approval management.
- Legal review workflow.

PHASE 6 – EXECUTION AND HANDOVER
- Deposit tracking.
- Agreement execution.
- Possession.
- Fit-out.
- Handover.
- Closure pack.

PHASE 7 – SYSTEM INTEGRATION
- Database.
- Deal Toolkit.
- Orchestrator.
- Input Engine.
- Intelligence Layer.
- Property Supply.
- Lease Lifecycle.
- Supercharged Assistant.

PHASE 8 – TESTING AND OPTIMISATION
- Transaction workflow testing.
- Negotiation accuracy.
- Approval enforcement.
- Document version comparison.
- Dependency testing.
- End-to-end closure testing.

---

# 21. FINAL EXPECTED OUTCOME

Module 16 must become the central execution environment for every active CRE transaction.

The user should be able to understand:

- Where the transaction stands.
- What has been offered.
- What has been negotiated.
- What has been commercially agreed.
- What remains unresolved.
- Who is responsible for each issue.
- Which documents are pending.
- Which approvals are required.
- What has changed in the agreement.
- What must happen before execution.
- What remains before possession.
- What remains before final handover.

The system must transform fragmented negotiations, emails, documents, commercial proposals and stakeholder discussions into a single structured transaction workflow.

The final visible result must be a transaction command view showing:

1. Agreed terms.
2. Open issues.
3. Pending decisions.
4. Dependencies.
5. Stakeholder responsibilities.
6. Approval status.
7. Document status.
8. Execution milestones.
9. Next actions.
10. Route to completion.

CORE PRINCIPLE:

EVERY TRANSACTION MUST HAVE A CLEAR STATUS, A COMPLETE NEGOTIATION HISTORY, A RESPONSIBLE OWNER, A VISIBLE LIST OF UNRESOLVED ISSUES AND A DEFINED ROUTE TO EXECUTION.

THE SYSTEM MUST NEVER CONFUSE A PROPOSAL WITH AN AGREEMENT, AN AGREEMENT WITH A SIGNED CONTRACT, OR A SIGNED CONTRACT WITH AN OCCUPIED PROPERTY.