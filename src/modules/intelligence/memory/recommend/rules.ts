/**
 * Module 13 §9 — intelligence-based recommendations (pure rules). Every recommendation carries: what was identified,
 * why it matters, supporting information, source references, confidence and a suggested next action. Recommendations
 * only SUGGEST — nothing here sends, books or changes anything (S3/S4).
 */
import { CHANGE_LABEL, hrefFor, type DetectedChange, type SourceRef } from "../changes/types";

export type RecConfidence = "high" | "medium" | "low";
export interface Recommendation {
  ref: string;                 // stable dedupe key
  kind: string;
  entityType: string | null; entityId: string | null;
  title: string;               // what was identified
  why: string;                 // why it matters
  supporting: string[];        // supporting information
  sourceRefs: SourceRef[];
  confidence: RecConfidence;
  nextAction: string;          // suggested next action (never executed automatically)
  href: string | null;
  persistedId?: string | null;
}

const conf = (v: string): RecConfidence => (v === "verified" ? "high" : v === "reported" || v === "estimated" ? "medium" : "low");

export function recommendationForChange(c: DetectedChange, changeId: string): Recommendation | null {
  const base = { entityType: c.entityType, entityId: c.entityId, sourceRefs: c.source ? [c.source] : [], href: hrefFor(c.entityType, c.entityId), supporting: [c.difference.text] };
  const ref = `change:${changeId}`;
  switch (c.kind) {
    case "decision_maker_change":
      return { ...base, ref, kind: "decision_maker_changed", title: CHANGE_LABEL[c.kind], why: `The approval path changed; ${c.affectedOpportunityIds.length} active opportunit${c.affectedOpportunityIds.length === 1 ? "y" : "ies"} may need relationship reassessment.`,
        confidence: "medium", nextAction: "Update the buying group and confirm the new decision-maker's priorities and authority (do not assume they match the previous person's)." };
    case "employer_change":
      return { ...base, ref, kind: "contact_moved", title: CHANGE_LABEL[c.kind], why: "The relationship moves with the person, the opportunity stays with the original company.", confidence: conf(c.verification),
        nextAction: "Find a new contact at the previous company for its open opportunities, and consider a (draft) congratulation note to the contact." };
    case "requirement_area_change": case "requirement_budget_change": case "requirement_location_change": case "requirement_timeline_change":
      return { ...base, ref, kind: "requirement_changed", title: `${CHANGE_LABEL[c.kind]} significantly`, why: "Shortlists, comparisons and proposals built on the old requirement may no longer fit.", confidence: conf(c.verification),
        nextAction: c.verification === "verified" ? "Refresh the shortlist and comparison against the updated requirement." : "Confirm the new requirement with the client, then refresh the shortlist." };
    case "rejected_property_relevant":
      return { ...base, ref, kind: "rejected_property_relevant", title: CHANGE_LABEL[c.kind], why: "New commercial or availability information may address the earlier rejection reason.", confidence: "low",
        nextAction: "Check whether the rejection reason still applies before re-proposing the building." };
    case "opportunity_inactive":
      return { ...base, ref, kind: "opportunity_inactive", title: CHANGE_LABEL[c.kind], why: "Deals without contact for this long tend to go cold.", confidence: "high", nextAction: "Review the opportunity and plan a follow-up (draft only)." };
    case "lease_expiry_approaching":
      return { ...base, ref, kind: "lease_expiry", title: CHANGE_LABEL[c.kind], why: "Renewal or relocation decisions need lead time.", confidence: conf(c.verification), nextAction: "Prepare a renewal-vs-relocation view and contact the decision-maker." };
    case "rent_change": case "cam_change": case "inventory_change":
      return c.affectedOpportunityIds.length ? { ...base, ref, kind: "commercial_change", title: CHANGE_LABEL[c.kind], why: "Comparisons using the old values are outdated.", confidence: conf(c.verification), nextAction: "Refresh affected comparisons; treat the new value as reported until confirmed." } : null;
    case "promotion":
      return { ...base, ref, kind: "promotion", title: CHANGE_LABEL[c.kind], why: "Decision-making authority may have changed.", confidence: conf(c.verification), nextAction: "Confirm their new responsibilities before relying on them in a buying group." };
    default:
      return null;
  }
}

// ------------------------------------------------------------------ computed (live) rules

export interface RuleInputs {
  today: string;
  staleRequirements: { id: string; title: string; orgName: string | null; lastReviewed: string; days: number }[];
  meetingsWithoutFollowup: { meetingId: string; title: string; at: string; days: number; personIds: string[]; href: string }[];
  repeatedRejections: { requirementId: string; title: string; theme: string; count: number; sources: SourceRef[] }[];
  outdatedQuotes: { id: string; requirementId: string; label: string; createdAt: string; validUntil: string | null; days: number }[];
  relationshipBeforeTransaction: { opportunityId: string; name: string; stage: string; lastContact: string | null; days: number | null }[];
  inactiveWithSignal: { opportunityId: string; name: string; signalId: string; signalTitle: string; detectedAt: string; verification: string }[];
}

const LATE_STAGES = ["proposal_negotiation", "loi", "documentation"];

export function liveRecommendations(i: RuleInputs): Recommendation[] {
  const r: Recommendation[] = [];
  for (const x of i.staleRequirements) r.push({ ref: `req_review:${x.id}:${x.lastReviewed.slice(0, 10)}`, kind: "requirement_not_reviewed", entityType: "requirement", entityId: x.id,
    title: `Requirement not reviewed for ${x.days} days: ${x.title}`, why: "Requirements drift; an unreviewed requirement may no longer be current.", supporting: [`${x.orgName ?? "Company unknown"} — last updated ${x.lastReviewed.slice(0, 10)}`],
    sourceRefs: [{ type: "requirement", id: x.id, label: x.title, href: hrefFor("requirement", x.id) }], confidence: "high", nextAction: "Confirm the requirement with the client and update it.", href: hrefFor("requirement", x.id) });
  for (const m of i.meetingsWithoutFollowup) r.push({ ref: `meeting_followup:${m.meetingId}`, kind: "no_followup_after_meeting", entityType: "meeting", entityId: m.meetingId,
    title: `No follow-up recorded after: ${m.title}`, why: "Momentum after a meeting is easily lost.", supporting: [`Meeting on ${m.at.slice(0, 10)}, ${m.days} days ago; no later interaction with the attendees on record.`],
    sourceRefs: [{ type: "meeting_visit", id: m.meetingId, label: m.title, href: m.href }], confidence: "medium", nextAction: "Draft a follow-up with the agreed actions (draft only — you send it).", href: m.href });
  for (const x of i.repeatedRejections) r.push({ ref: `rej_theme:${x.requirementId}:${x.theme}`, kind: "repeated_rejection_reason", entityType: "requirement", entityId: x.requirementId,
    title: `${x.count} buildings rejected because of ${x.theme}`, why: `Options with the same ${x.theme} limitation will likely be rejected again.`, supporting: x.sources.map((s) => s.label),
    sourceRefs: x.sources, confidence: "medium", nextAction: `Filter future options on ${x.theme}, or confirm it as a hard requirement with the client.`, href: hrefFor("requirement", x.requirementId) });
  for (const qx of i.outdatedQuotes) r.push({ ref: `quote_outdated:${qx.id}`, kind: "quotation_outdated", entityType: "requirement", entityId: qx.requirementId,
    title: `Quotation outdated: ${qx.label}`, why: "An old quotation is not current pricing.", supporting: [`Quoted ${qx.createdAt.slice(0, 10)} (${qx.days} days ago)${qx.validUntil ? `, valid until ${qx.validUntil}` : ", validity unknown"}`],
    sourceRefs: [{ type: "quote", id: qx.id, label: qx.label, href: hrefFor("requirement", qx.requirementId) }], confidence: "high", nextAction: "Ask the landlord for refreshed terms before using these numbers.", href: hrefFor("requirement", qx.requirementId) });
  for (const o of i.relationshipBeforeTransaction) if (LATE_STAGES.includes(o.stage)) r.push({ ref: `rel_attention:${o.opportunityId}:${o.lastContact?.slice(0, 10) ?? "none"}`, kind: "relationship_attention", entityType: "opportunity", entityId: o.opportunityId,
    title: `Relationship needs attention before closing: ${o.name}`, why: `The deal is at ${o.stage.replace(/_/g, " ")} but contact has been thin.`, supporting: [o.lastContact ? `Last recorded contact ${o.lastContact.slice(0, 10)} (${o.days} days ago)` : "No recorded contact on this deal"],
    sourceRefs: [{ type: "opportunity", id: o.opportunityId, label: o.name, href: hrefFor("opportunity", o.opportunityId) }], confidence: o.lastContact ? "medium" : "low", nextAction: "Schedule a check-in with the decision-maker.", href: hrefFor("opportunity", o.opportunityId) });
  for (const s of i.inactiveWithSignal) r.push({ ref: `inactive_signal:${s.opportunityId}:${s.signalId}`, kind: "inactive_opportunity_signal", entityType: "opportunity", entityId: s.opportunityId,
    title: `New signal on an inactive deal: ${s.name}`, why: "A fresh development can be a reason to re-open the conversation.", supporting: [`${s.signalTitle} (${s.detectedAt.slice(0, 10)}, ${s.verification === "fact" ? "confirmed" : "reported, not confirmed"})`],
    sourceRefs: [{ type: "signal", id: s.signalId, label: s.signalTitle, href: "/signals" }], confidence: s.verification === "fact" ? "medium" : "low", nextAction: "Review the signal and decide whether to re-engage (draft only).", href: hrefFor("opportunity", s.opportunityId) });
  return r;
}

const ORDER: Record<RecConfidence, number> = { high: 0, medium: 1, low: 2 };
export function rankRecommendations(list: Recommendation[]): Recommendation[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x.ref) ? false : (seen.add(x.ref), true))).sort((a, b) => ORDER[a.confidence] - ORDER[b.confidence]);
}

/** Today planner feed shape (orchestrator Rec). */
export const toPlannerRec = (x: Recommendation) => ({ title: x.title, why: `${x.why} → ${x.nextAction}`, href: x.href ?? "/intelligence/quality", ref: `intel:${x.ref}` });
