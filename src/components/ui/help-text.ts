/**
 * Plain-language help for section titles. Matched on the start of the title (counts in brackets are ignored),
 * so "Hard constraints (3)" uses the "Hard constraints" entry. Keep each tip to 1–3 short sentences.
 */
export const HELP_TEXT: Record<string, string> = {
  // Database / setup
  "Needs review": "Things the system was not sure about — possible duplicates, import problems, conflicting values and proposed changes. Nothing is merged or overwritten until someone reviews it.",
  "Recent changes": "Every create, edit and archive, newest first: what changed, the old and new value, and who did it.",
  "Places": "Your location tree: City → Corridor → Micro-market → Locality. Buildings and requirements point to these places, so add places before using them.",
  "Upload": "Upload an Excel or CSV file. Nothing goes straight into your records — rows are checked, matched to existing records and shown to you first.",
  "Sources": "Original files that were imported. They are kept unchanged so every number can be traced back to where it came from.",
  "Identity review": "Rows that might be an existing company, person or building. Confirm the match or keep them separate — nothing is merged automatically.",
  "Mapping review": "How each column in the file maps to a field in CRE OS. Check this when a file has new or renamed columns.",
  "Quarantined rows": "Rows that could not be imported safely (missing or invalid values). They are kept with the reason so nothing is silently lost.",
  "Rows with a problem": "Rows that were read but have something to fix, like a missing value or an odd date. Mark each as fixed or ignored.",
  "Possible duplicates": "Rows that look like a record you already have. Say 'same' to link them or 'different' to keep them separate. Nothing is merged automatically.",
  "Values that differ from your records": "The file says something different from what is saved (for example a new area). Approve to update the record, or keep yours.",
  "New people from this file": "People named in the file. They are added when you approve, and linked to their company.",
  "Rows that could not be read": "Rows skipped because they could not be understood. They are kept with the reason so you can fix the file.",
  // Company
  "Identity": "The company's official details: legal name, website, CIN and GSTIN. CIN and GSTIN must be unique, which prevents duplicate companies.",
  "Next action": "The next step agreed on this company's open deal. Set it on the deal page.",
  "Signals": "News or public events about this company (hiring, funding, expansion) with how reliable each source is.",
  "Requirements & opportunities": "Space needs this company has told you about (requirements) and the deals you are working on for them (opportunities).",
  "Sites & leases": "Offices this company leases today, with size and expiry dates.",
  "Evidence trail": "Where the facts on this page came from and when, so you can check them.",
  "Priority": "How important this account is right now, based on lease expiry, signals and activity.",
  "People": "Employees of this company — current and past. Add someone new by typing their name, or pick a person already saved.",
  "Stakeholders": "People involved in this company's requirements and the role each plays in the decision.",
  "Related organisations": "Parent companies, subsidiaries and affiliates. They stay separate records — linking never merges them. Aliases help search find the company by other names.",
  "Shared with": "Who else in your team can see this record.",
  "Archive": "Archiving hides a record from normal lists but keeps all its history. Records are never deleted.",
  // Person
  "Employment timeline": "Every job this person has had. When someone changes company, end the old role and add the new one — the history is kept.",
  "Contact methods": "Emails and phone numbers this person shared. Invalid formats are rejected and nothing is guessed.",
  "Relationship context": "How you know this person and how strong the relationship is. Knowing someone does not mean they agreed to make introductions.",
  "Consent & permissions": "What this person allowed you to do (for example contact them) and until when.",
  "Stakeholder roles": "The requirements this person is involved in and their role in each.",
  "Profile": "Other details about the person, such as preferred language and channel.",
  "Interactions": "Calls, meetings and visits with this person.",
  "Intro paths": "Who in your network could introduce you, based on recorded relationships.",
  // Building
  "Building": "The building's basic facts, its location, specifications and sourced values. 'Unknown' means nobody has told us yet — it is never shown as zero.",
  "Spaces & availability": "Floors and units in this building. Availability is saved as dated snapshots, so older information is kept and never overwrites newer information.",
  "Leases": "Leases in this building: tenant, landlord, dates and area. Link the floors/units each lease covers and add its key dates (expiry, lock-in, notice).",
  "Market transactions": "Deals done in this building that were reported in the market.",
  "Observations": "Values from different sources. When sources disagree both are kept, and you choose the current value through Approvals.",
  // Requirement
  "Requirement contract": "Everything the client needs, field by field. Each value shows whether it is estimated, reported or confirmed by the client.",
  "Questions to ask": "Information still missing. Ask the client these; answers fill the requirement in.",
  "Client confirmation": "Fields the client has not confirmed yet. A deal can only move to later stages once the key fields are confirmed.",
  "Locations & required features": "Where the client wants to be (preferred, acceptable or excluded) and must-have building features such as parking or power backup. Hard constraints filter out buildings that do not qualify.",
  "Hard constraints": "Rules a building must pass before it can be suggested — for example area range. A high score can never override them, and missing building data means 'needs checking', not a match.",
  "Stakeholder map": "Who at the client is involved and their role (approver, finance, technical…). Pick a person already saved or type a new name.",
  "Update a field": "Change one value on this requirement. Say where the information came from so others can trust it.",
  "Changes vs previous version": "What changed since the last saved version of this requirement.",
  "Shortlist": "Buildings that match this requirement, ranked. Buildings with missing information are flagged, not hidden.",
  "Follow-up & verification tasks": "To-dos created from open questions on this requirement. They close as answers are confirmed.",
  "Opportunity": "The deal for this requirement. Track it to follow stages from first contact to signing.",
  "New opportunity": "Start tracking a deal for this requirement.",
  "Who and what": "Name the requirement and the client company.",
  "Size, budget and timing": "Fill in what you know. Leave blanks if unknown — blanks stay 'unknown' and are never treated as zero.",
  // Deal
  "Stage": "Where the deal is. Some stages need evidence or a client-confirmed requirement before you can move on.",
  "Stage history": "Every stage change with date and reason.",
  "Labels & outcome": "Temperature, mandate type, expected close and the final outcome (won, lost…).",
  "Closing checklist & move dependencies": "Steps needed before signing and moving in. Items marked 'needed before' block that stage until done.",
  "Outstanding documents": "Documents still needed to close the deal.",
  "Objections": "Concerns the client raised (price, location, timing…) so the team can address them.",
  // Capture & approvals
  "New capture": "Speak, type or snap a photo after a call or visit. CRE OS files the meeting, creates tasks and asks before changing any record.",
  "Recent captures": "Your latest captures. Open one to answer its questions or check what it created.",
  "Questions before anything material changes": "CRE OS was unsure about something in your note. Answer these before any record is changed.",
  "Who and where": "The company, people and place this capture is about.",
  "Roles and requirement details": "Details picked up from your note, proposed against the company's requirement.",
  "Tasks": "To-dos created from this capture.",
  "Review queue": "Changes waiting for approval. Approve to apply them, or reject to leave the record as it is.",
  "History": "Earlier versions and decisions for this record.",
};

export function helpFor(title: unknown): string | undefined {
  if (typeof title !== "string") return undefined;
  const t = title.replace(/\s*\(.*$/, "").trim();
  return HELP_TEXT[t] ?? Object.entries(HELP_TEXT).find(([k]) => t.startsWith(k))?.[1];
}
