import "server-only";
/**
 * Module 13 — historical/change memory, consolidation, recommendations, quality and lifecycle: public API for other
 * modules (meetings, assistant, toolkit, outreach, signals, orchestrator, Today planner). Entity/relationship/
 * requirement/context memory lives in `@/modules/intelligence/memory` (CONTRACT.md).
 */
import type { MemCtx } from "../types";

export { detectChanges, listChanges, whatChanged, getRequirementEvolution, analyseDecisionMakerChange, setChangeState, type ChangeScope, type ChangeRow, type RequirementEvolution, type DetectResult } from "../changes/service";
export { CHANGE_LABEL, type DetectedChange, type ChangeKind } from "../changes/types";
export { consolidateEntity, consolidateMeetings, loadObservations } from "../consolidate/service";
export { listRecommendations, plannerRecommendations, setRecommendationState } from "../recommend/service";
export type { Recommendation } from "../recommend/rules";
export { qualityReport, type QualityReport, type QualityCheck } from "../quality/service";
export { correctMemoryStatus, listCorrections, lifecycleStatus, applyCorrections, LifecycleError, LIFECYCLE_STATUSES } from "../quality/lifecycle";
export { loadRejections, recurringRejectionThemes, reasonTheme } from "./rejections";
export { findSimilarRequirements } from "./similar";
export { outreachRepetitionWarnings, knownBeforeSignal, meetingMemoryForBrief, comparisonRejections } from "./hooks";

/** AppContext / ToolContext.ctx → MemCtx (RLS client). */
export const memCtxFromTool = (c: { db: unknown; workspaceId: string; userId: string }): MemCtx => ({ db: c.db as MemCtx["db"], workspaceId: c.workspaceId, userId: c.userId });
