import "server-only";
/** Module 13 memory — public API (see docs/intelligence-layer/CONTRACT.md). */
export * from "./types";
export { getPersonContext, type PersonContext } from "./entity/person";
export { getCompanyContext, type CompanyContext } from "./entity/company";
export { getPropertyContext, type PropertyContext, type ValueChange } from "./entity/property";
export { getRequirementContext, type RequirementContext, type RequirementField, REQUIREMENT_STALE_DAYS } from "./requirement/service";
export { requirementConfidence, diffRequirementVersions, requirementEvolution, CONFIDENCE_LABEL, TRACKED, type RequirementChange, type VersionRow } from "./requirement/confidence";
export { relationshipStrength, type RelationshipAssessment, type RelationshipEvidence, type RelationshipLevel, type RelationshipFactor } from "./relationship/strength";
export { gatherRelationshipEvidence, assessRelationship, relationshipHistory, type RelationshipHistory } from "./relationship/service";
export { getMeetingContext, type MeetingContext, type MeetingAttendee } from "./context/meeting";
export { getTimeline } from "./context/timeline";
export { summariseContext, mockSummary, type ContextSummary } from "./context/summary";
export { commitmentsFrom, objectionsFrom, interactionsFor, type Commitment, type Objection } from "./data";
