# MODULE 13: INTELLIGENCE LAYER
## Remembering Relationships, Business Context and Changes Over Time

### 1. PROJECT OBJECTIVE

Develop Module 13 – Intelligence Layer for the CRE AI Operating System.

The Intelligence Layer is responsible for maintaining contextual understanding of companies, people, relationships, property requirements, business opportunities and historical interactions.

Its primary responsibility is to ensure that the system does not simply store information but understands how different pieces of information are connected and how they change over time.

The system must remember:

- Who a person is.
- Which company they work for.
- Their previous employment history.
- Their designation and decision-making authority.
- Their relationship with the user.
- Their company's real estate requirements.
- Their previous conversations and commitments.
- Their commercial preferences.
- Their objections and concerns.
- Their historical business activities.
- Changes in their requirements and circumstances.
- The current status of business relationships.
- What the user should know before interacting with them again.

The Intelligence Layer must make this contextual information available to all relevant modules.

It must not become an isolated AI agent or duplicate the existing database.

### 2. CORE ARCHITECTURE

The Intelligence Layer must operate using five interconnected intelligence components:

1. Entity Memory.
2. Relationship Memory.
3. Requirement Memory.
4. Historical and Change Memory.
5. Context Retrieval and Decision Support.

All five components must work together.

The system must maintain a continuous understanding of the business rather than treating every interaction as an isolated event.

---

# 3. ENTITY MEMORY

The system must maintain contextual memory for every important entity.

### 3.1 Person Memory

For every contact, maintain an evolving understanding of:

- Full name.
- Current company.
- Previous companies.
- Current designation.
- Previous designations.
- Department.
- Seniority.
- Decision-making authority.
- Professional responsibilities.
- Business interests.
- Known property-related responsibilities.
- Communication preferences.
- Interaction history.
- Relationship with the user.
- Previous commitments.
- Known objections.
- Relevant professional connections.
- Last interaction date.
- Next expected interaction.

The system must distinguish verified information from inferred information.

Example:

A contact previously worked as a Facilities Manager at Company A and is now working as a Corporate Real Estate Director at Company B.

The Intelligence Layer must preserve both employment records and recognise that the person has moved to a new organisation.

It must not automatically transfer Company A's opportunities or requirements to Company B.

### 3.2 Company Memory

Maintain contextual memory for every company.

Information should include:

- Company identity.
- Industry.
- Business activities.
- Office locations.
- Existing occupancy information.
- Historical property requirements.
- Expansion plans.
- Consolidation activities.
- Real estate decision-makers.
- Important contacts.
- Relationship history.
- Previous transactions.
- Known commercial preferences.
- Historical rent information.
- Important business developments.
- Current opportunities.
- Previous opportunities.
- Important unresolved questions.

The system should understand the difference between a company, its subsidiaries, business units and individual office locations.

### 3.3 Property Memory

Maintain contextual information for buildings and commercial properties.

Information should include:

- Building identity.
- Alternate building names.
- Location.
- Developer.
- Landlord.
- Property manager.
- Available inventory.
- Historical quotations.
- Previous commercial offers.
- Rent changes.
- CAM changes.
- Property specifications.
- Previous client interest.
- Rejected requirements.
- Reasons for rejection.
- Property suitability history.

Preserve historical commercial values and their sources.

Do not treat an old quotation as current availability or current pricing.

---

# 4. RELATIONSHIP MEMORY

The system must understand the relationship between the user and every important contact.

### 4.1 Relationship History

Maintain:

- First interaction date.
- Most recent interaction.
- Total recorded interactions.
- Meeting history.
- Call history.
- Email and communication history where connected.
- Previous business discussions.
- Agreed commitments.
- Pending commitments.
- Previous proposals.
- Previous transactions.
- Relationship changes.
- Important personal or professional context voluntarily shared in business interactions.

### 4.2 Relationship Strength

Maintain a relationship assessment based on observable evidence.

Consider:

- Interaction frequency.
- Recency of communication.
- Responsiveness.
- Meeting engagement.
- Information shared voluntarily.
- Willingness to introduce other decision-makers.
- Previous successful collaboration.
- Fulfilment of commitments.
- Level of professional trust demonstrated.

Do not confuse frequent communication with a strong business relationship.

The relationship assessment must explain the evidence behind its evaluation.

### 4.3 Relationship Timeline

Provide a chronological timeline showing:

- First contact.
- Important conversations.
- Meetings.
- Business discussions.
- Requirements identified.
- Proposals shared.
- Commercial negotiations.
- Decisions.
- Objections.
- Commitments.
- Relationship changes.
- Latest developments.

Users must be able to understand the complete relationship history without manually reviewing every interaction.

---

# 5. REQUIREMENT MEMORY

The Intelligence Layer must maintain an evolving understanding of each company's property requirements.

### 5.1 Requirement History

Remember:

- Required area.
- Preferred locations.
- Budget.
- Property type.
- Occupancy purpose.
- Employee headcount.
- Target possession date.
- Lease duration.
- Preferred building specifications.
- Parking requirements.
- Infrastructure requirements.
- Commercial preferences.
- Decision-makers.
- Approval process.
- Previous property options.
- Rejected properties.
- Reasons for rejection.
- Previous requirement changes.

### 5.2 Requirement Evolution

The system must understand how requirements change over time.

Example:

Initial requirement:
- 10,000 SF.
- Hinjawadi.
- Target possession in December.

Updated requirement:
- 15,000 SF.
- Kharadi.
- Target possession in March.

The Intelligence Layer must:

1. Preserve the original requirement.
2. Record the updated requirement.
3. Identify what changed.
4. Identify when it changed.
5. Identify the source of the change.
6. Identify whether the previous requirement is obsolete.
7. Update the current requirement context.
8. Notify relevant modules about material changes.

### 5.3 Requirement Confidence

Classify requirement information as:

- Confirmed.
- Indicative.
- Estimated.
- Inferred.
- Outdated.
- Conflicting.
- Unknown.

Do not present an inferred requirement as a confirmed client requirement.

---

# 6. HISTORICAL MEMORY AND CHANGE DETECTION

The system must understand changes across companies, contacts, properties and requirements.

### 6.1 Change Detection

Identify changes such as:

- Contact changing employers.
- Contact receiving a promotion.
- Company changing office locations.
- Company expanding operations.
- Company reducing office space.
- Property rent changing.
- CAM charges changing.
- Property inventory changing.
- Lease expiry approaching.
- Requirement area changing.
- Budget changing.
- Decision-maker changing.
- Business opportunity becoming inactive.
- Previously rejected property becoming relevant again.

### 6.2 Historical Comparison

For every important change:

- Retrieve the previous value.
- Retrieve the latest value.
- Identify the difference.
- Record the change date.
- Record the source.
- Record verification status.
- Identify affected records.
- Identify affected opportunities.
- Identify relevant downstream modules.

### 6.3 Change Impact Analysis

The system must understand the business impact of a change.

Example:

A company's decision-maker changes.

The Intelligence Layer should:

1. Identify the previous decision-maker.
2. Identify the new decision-maker.
3. Retrieve the relationship history with the previous person.
4. Identify existing contacts at the company.
5. Identify active opportunities.
6. Determine which opportunities may require relationship reassessment.
7. Recommend updating the buying-group information.
8. Notify the relevant modules.

It must not automatically assume that the new decision-maker has the same preferences or commercial authority.

---

# 7. CONTEXTUAL RETRIEVAL ENGINE

The Intelligence Layer must provide relevant contextual information whenever another module needs it.

### 7.1 Context Retrieval

When the user opens a company, contact, property or opportunity, the system should retrieve the most relevant information.

For example, when opening a company, display:

- Company overview.
- Current requirements.
- Important contacts.
- Decision-makers.
- Relationship history.
- Previous conversations.
- Active opportunities.
- Previous proposals.
- Important objections.
- Outstanding commitments.
- Recent business developments.
- Important changes.
- Recommended next actions.

### 7.2 Contextual Preparation

Before an interaction, the system should prepare relevant context.

For an upcoming meeting, retrieve:

- Who is attending.
- Their current designation.
- Previous interactions.
- Last discussion.
- Previous commitments.
- Current requirements.
- Important objections.
- Commercial discussions.
- Pending questions.
- Recent developments.
- Suggested discussion points.

This information should be made available to Module 7 – Meeting Intelligence.

### 7.3 Contextual Question Answering

The system must support questions such as:

- What did we last discuss with this company?
- What is their current property requirement?
- Who is the actual decision-maker?
- Have we spoken to this person before?
- What properties have they rejected?
- Why did they reject those properties?
- What commercial terms were previously discussed?
- What commitments are pending?
- Has their requirement changed?
- What should I know before meeting this person?
- Which companies have similar requirements?
- Which contacts have strong relationships with this company?

Answers must use available records and provide source references where possible.

If the system does not have the information, it must clearly state that it is unknown.

It must never invent relationship history or business context.

---

# 8. MEMORY CONSOLIDATION

The system must consolidate information from multiple interactions without losing important details.

Features:

- Combine relevant information from multiple meeting notes.
- Consolidate repeated company observations.
- Consolidate contact interaction history.
- Identify recurring client preferences.
- Identify repeated objections.
- Identify repeated commercial requirements.
- Identify recurring business concerns.
- Summarise long interaction histories.
- Preserve important original observations.
- Retain links to original sources.
- Identify conflicting observations.
- Distinguish repeated claims from independent confirmation.

Example:

A contact mentions three times that their company prefers Grade A buildings with immediate occupancy.

The system may identify this as a recurring preference.

However, it must retain the underlying observations and must not convert the preference into a confirmed contractual requirement.

---

# 9. INTELLIGENCE-BASED RECOMMENDATIONS

The Intelligence Layer should identify useful business actions based on existing context.

Examples:

- A company requirement has not been reviewed recently.
- A decision-maker has changed.
- A contact has not been contacted after an important meeting.
- A previous property option may now be suitable.
- A company has repeatedly rejected properties because of parking limitations.
- A requirement has changed significantly.
- A commercial quotation is outdated.
- A relationship needs attention before an important transaction.
- A previously inactive opportunity has received a new relevant signal.

Every recommendation must include:

- What was identified.
- Why it matters.
- Supporting information.
- Source references.
- Confidence level.
- Suggested next action.

Recommendations must not automatically execute external actions.

---

# 10. RELATIONSHIP AND OPPORTUNITY MEMORY

The system must understand that companies, contacts and opportunities are connected but are not interchangeable.

Features:

- Link contacts to companies.
- Link contacts to multiple companies where historically appropriate.
- Maintain employment history.
- Link requirements to the correct company and business unit.
- Link properties to relevant requirements.
- Link transactions to companies and contacts.
- Preserve opportunity history.
- Track relationship changes.
- Track changes in buying groups.
- Identify opportunities affected by organisational changes.

A contact leaving a company does not mean the company's opportunity disappears.

An opportunity must remain associated with the correct company and retain its own history.

---

# 11. INTELLIGENCE SHARING ACROSS MODULES

The Intelligence Layer must provide contextual information to all relevant modules.

### Module 1 – Database
- Read structured records.
- Maintain contextual relationships.
- Preserve historical observations.
- Reference original sources.

### Module 2 – Signal Engine
- Provide company history.
- Identify previous business signals.
- Identify recurring patterns.
- Provide context for new developments.
- Avoid treating previously known information as a new development.

### Module 3 – Scoring Engine
- Provide relationship strength evidence.
- Provide requirement readiness context.
- Provide historical engagement.
- Identify stale information.
- Support evidence-based scoring.

### Module 4 – Contact Enrichment
- Provide existing contact history.
- Identify employer changes.
- Maintain professional relationship context.
- Avoid duplicate contact identities.

### Module 5 – Outreach Engine
- Provide previous conversation context.
- Identify communication preferences.
- Provide known objections.
- Provide relationship history.
- Prevent repetitive outreach based on already completed interactions.

### Module 7 – Meeting Intelligence
- Generate contextual meeting preparation information.
- Provide previous meeting history.
- Identify outstanding commitments.
- Supply relevant company and contact context.

### Module 8 – Deal Toolkit
- Provide historical requirement information.
- Provide previous commercial discussions.
- Retrieve previously rejected properties.
- Identify changing client preferences.
- Support contextual property comparisons.

### Module 9 – Orchestrator
- Notify the Orchestrator about important changes.
- Trigger appropriate dependent workflows.
- Identify events requiring reassessment.
- Coordinate contextual updates.

### Module 10 – Input Engine
- Receive newly extracted information.
- Consolidate new observations with existing memory.
- Identify historical conflicts.
- Update contextual understanding after validation.

### Module 12 – Supercharged Assistant
- Provide contextual answers.
- Retrieve relevant business history.
- Answer questions using shared system memory.
- Provide source-linked explanations.
- Maintain continuity across conversations.

---

# 12. MEMORY QUALITY AND RELIABILITY

The Intelligence Layer must continuously assess the quality of its memory.

Features:

- Identify outdated information.
- Identify missing information.
- Identify contradictory information.
- Identify unsupported assumptions.
- Identify incomplete relationship histories.
- Identify unverified requirements.
- Identify stale property quotations.
- Identify contacts with outdated employment information.
- Identify records without source references.
- Identify duplicate observations.
- Identify information requiring review.

Every important memory item must maintain:

- Entity ID.
- Information category.
- Stored value or observation.
- Source reference.
- Observation date.
- Last verification date, if available.
- Verification status.
- Confidence level.
- Historical version.
- Relationship to other records.

The system must not assign artificial certainty to incomplete information.

---

# 13. MEMORY LIFECYCLE MANAGEMENT

The Intelligence Layer must manage information throughout its lifecycle.

Features:

- Create new contextual memories.
- Update existing memories.
- Preserve historical memories.
- Identify obsolete memories.
- Mark outdated information.
- Consolidate repeated observations.
- Maintain source references.
- Support manual corrections.
- Preserve audit history.
- Reassess memory when new evidence arrives.

Historical information must not be permanently overwritten simply because newer information is available.

The system must distinguish between:

- Current information.
- Historical information.
- Superseded information.
- Unverified information.
- Conflicting information.

---

# 14. MAIN USER INTERFACE

The Intelligence Layer should primarily operate in the background.

It should expose its capabilities through existing company, contact, property and opportunity screens.

### A. Company Intelligence Panel

Display:

- Company overview.
- Business history.
- Current property requirements.
- Important contacts.
- Decision-makers.
- Relationship history.
- Active opportunities.
- Historical requirements.
- Recent developments.
- Important changes.
- Outstanding commitments.
- Recommended actions.

### B. Contact Intelligence Panel

Display:

- Professional profile.
- Current employer.
- Previous employers.
- Designation history.
- Decision-making role.
- Relationship strength.
- Interaction timeline.
- Previous discussions.
- Known preferences.
- Important commitments.
- Recent changes.
- Recommended next action.

### C. Property Intelligence Panel

Display:

- Property overview.
- Historical quotations.
- Latest known commercial terms.
- Previous client interest.
- Historical availability observations.
- Previous objections.
- Related requirements.
- Important changes.
- Source and verification status.

### D. Requirement Intelligence Panel

Display:

- Current requirement.
- Requirement history.
- Area changes.
- Location changes.
- Budget changes.
- Timeline changes.
- Commercial preferences.
- Decision-makers.
- Previous property options.
- Rejection reasons.
- Outstanding questions.
- Requirement confidence.

### E. Intelligence Timeline

Provide a chronological timeline of meaningful changes and interactions.

Allow filtering by:

- Company.
- Contact.
- Property.
- Requirement.
- Opportunity.
- Date.
- Event type.

---

# 15. TECHNICAL IMPLEMENTATION REQUIREMENTS

Before implementation:

1. Inspect the existing application architecture.
2. Inspect Module 1's database schema.
3. Identify existing company, contact, property and opportunity relationships.
4. Identify existing interaction and activity records.
5. Inspect the Input Engine integration.
6. Inspect the Orchestrator event system.
7. Reuse existing database tables and services wherever appropriate.
8. Avoid creating duplicate records or a separate database.
9. Preserve existing authentication and permissions.
10. Integrate with existing AI model infrastructure.

The implementation should support:

- Structured entity memory.
- Relationship graph or equivalent relationship representation.
- Historical observations.
- Change detection.
- Context retrieval.
- Memory consolidation.
- Source references.
- Confidence and verification tracking.
- Contextual recommendations.
- Event-driven updates.
- Permission-aware retrieval.

Use deterministic backend logic for identity, relationships, historical records and access permissions.

Use AI for summarisation, contextual interpretation, pattern recognition and recommendations.

Do not allow an AI model to silently rewrite important business records.

---

# 16. IMPORTANT BUSINESS RULES

1. The Database remains the source of structured business records.

2. The Intelligence Layer provides contextual understanding of those records.

3. Never invent conversations, relationships, preferences or commitments.

4. Never present assumptions as confirmed facts.

5. Preserve historical information.

6. Never automatically transfer company opportunities when a contact changes employers.

7. Distinguish company identity from individual contact identity.

8. Distinguish current requirements from historical requirements.

9. Distinguish a recurring preference from a confirmed requirement.

10. Preserve source references for important information.

11. Identify stale information rather than silently treating it as current.

12. Do not treat repeated information from the same source as independent confirmation.

13. Do not expose information across accounts or users without the required permissions.

14. Recommendations must explain their supporting evidence.

15. Unknown information must remain unknown.

---

# 17. END-TO-END TEST SCENARIOS

The following scenarios must be tested before considering the module complete.

1. Create a new contact and establish contextual memory.
2. Add multiple interactions with the same contact.
3. Retrieve the complete interaction history.
4. Change a contact's employer.
5. Preserve the previous employer relationship.
6. Verify that existing company opportunities remain with the original company.
7. Update a company's property requirement.
8. Retrieve the previous requirement.
9. Identify changes in area, budget and location.
10. Identify a recurring client preference.
11. Distinguish a recurring preference from a confirmed requirement.
12. Identify conflicting commercial information.
13. Identify outdated property quotations.
14. Retrieve relevant context before a meeting.
15. Identify outstanding commitments.
16. Identify changes in company decision-makers.
17. Retrieve previous property rejection reasons.
18. Consolidate multiple meeting notes.
19. Answer contextual questions through Module 12.
20. Ensure source references remain available.
21. Verify access permissions.
22. Verify historical memory preservation.
23. Verify that AI-generated assumptions are clearly labelled.
24. Verify that new information triggers appropriate contextual reassessment.

---

# 18. IMPLEMENTATION PRIORITY

Build the Intelligence Layer in the following order.

PHASE 1 – ENTITY MEMORY
- Company memory.
- Contact memory.
- Property memory.
- Requirement memory.

PHASE 2 – RELATIONSHIP MEMORY
- Interaction history.
- Relationship timeline.
- Employment history.
- Decision-maker context.
- Commitment history.

PHASE 3 – HISTORICAL MEMORY
- Historical values.
- Requirement evolution.
- Change detection.
- Historical comparisons.

PHASE 4 – CONTEXTUAL RETRIEVAL
- Company context.
- Contact context.
- Property context.
- Requirement context.
- Meeting preparation context.

PHASE 5 – MEMORY CONSOLIDATION
- Repeated observations.
- Recurring preferences.
- Historical summaries.
- Conflict detection.
- Source traceability.

PHASE 6 – INTELLIGENCE AND RECOMMENDATIONS
- Change impact analysis.
- Relationship assessments.
- Requirement reassessment.
- Contextual recommendations.

PHASE 7 – SYSTEM-WIDE INTEGRATION
- Integrate with relevant modules.
- Enable contextual retrieval.
- Implement event-driven memory updates.
- Validate permissions and memory consistency.

---

# 19. FINAL EXPECTED OUTCOME

The Intelligence Layer must make the CRE AI Operating System remember the business.

It should understand the history of every important company, contact, property, requirement and opportunity.

It must understand not only what information exists, but also:

- Where the information came from.
- When it was observed.
- Whether it is verified.
- How it relates to other information.
- What changed.
- Why the change matters.
- What the user should know.
- What action may be appropriate.

The user should not need to repeatedly explain the history of a company, contact or transaction.

When the user opens a record, prepares for a meeting or asks a question, the system should already have the relevant context available.

The ultimate objective is to create a CRE operating system with persistent business memory, contextual understanding and awareness of how relationships and opportunities evolve over time.

CORE PRINCIPLE:

THE DATABASE STORES WHAT THE BUSINESS KNOWS.

THE INTELLIGENCE LAYER UNDERSTANDS WHAT THAT INFORMATION MEANS, HOW IT CONNECTS AND WHAT HAS CHANGED.