/**
 * Default scoring models. Admins change them on /scoring/models — no code change. When these defaults change, a workspace
 * still on an untouched default version gets a NEW version (old results keep pointing at the old one — history stays).
 */
import type { ModelKey, ModelVersion, FactorDef } from "./engine";

const f = (key: string, label: string, weight: number, unknown: FactorDef["unknown"], description: string): FactorDef => ({ key, label, weight, unknown, description });
const FIVE: ModelVersion["bands"] = [{ min: 80, label: "Very High" }, { min: 60, label: "High" }, { min: 40, label: "Medium" }, { min: 20, label: "Low" }, { min: 0, label: "Very Low" }];

export const DEFAULT_INDUSTRY_WEIGHTS: Record<string, number> = {
  "it": 1, "technology": 1, "software": 1, "gcc": 1, "bfsi": 0.95, "banking": 0.95, "financial": 0.9, "insurance": 0.85, "consulting": 0.9,
  "professional services": 0.85, "healthcare": 0.75, "pharma": 0.75, "manufacturing": 0.6, "engineering": 0.7, "automotive": 0.6,
  "retail": 0.4, "education": 0.4, "real estate": 0.2, "coworking": 0.2,
};

export const MODELS: Record<ModelKey, { name: string; purpose: string; entity: string; version: ModelVersion }> = {
  company: {
    name: "Company attractiveness", entity: "organisation", purpose: "Which companies are worth targeting as office occupiers.",
    version: { bands: FIVE, config: { industry_weights: DEFAULT_INDUSTRY_WEIGHTS, focus_cities: ["Pune"] }, factors: [
      f("scale", "Company scale", 20, "exclude", "Headcount, number of known sites. Unknown headcount is excluded, not penalised."),
      f("industry", "Industry attractiveness", 15, "neutral", "Sector weight from the industry table (configurable)."),
      f("geography", "Pune relevance", 20, "exclude", "Existing Pune occupancy, Pune expansion evidence, GCC status."),
      f("growth", "Growth indicators", 20, "zero", "Expansion, hiring, funding, new-office signals from Module 2 (one per event)."),
      f("cre", "CRE relevance", 15, "zero", "Leases, upcoming lease events, open requirements."),
      f("commercial", "Commercial size", 10, "exclude", "Largest known lease or requirement area. Never estimated."),
    ] },
  },
  lead: {
    name: "Lead priority", entity: "organisation", purpose: "How soon a company is likely to become an actionable CRE opportunity. A high score is not readiness to transact.",
    version: { bands: FIVE, config: {}, factors: [
      f("timing", "Timing", 25, "exclude", "Days to the nearest dated event or requirement decision date."),
      f("need", "Need / trigger", 25, "zero", "Lease event, requirement, expansion/GCC/relocation/consolidation signal."),
      f("authority", "Relationship access", 20, "zero", "Best contact relevance at the company (decision-maker access)."),
      f("fit", "Commercial fit", 15, "neutral", "Company attractiveness, plus a recorded requirement budget (never inferred)."),
      f("engagement", "Engagement", 10, "zero", "Meaningful interactions in the last 180 days."),
      f("evidence", "Evidence freshness", 5, "zero", "Recency and strength of the best supporting signal."),
    ] },
  },
  contact: {
    name: "Contact relevance", entity: "person", purpose: "Which people matter for a property decision. Seniority alone is not authority.",
    version: { bands: FIVE, config: {}, factors: [
      f("role", "Role relevance", 35, "neutral", "Real estate / facilities / admin / workplace / procurement / finance / HR / GCC / MD."),
      f("employment", "Current employment verified", 20, "neutral", "Current role and how it is known (confirmed vs reported)."),
      f("relationship", "Relationship", 20, "zero", "Interactions with this person, recency."),
      f("reachability", "Contact details", 15, "zero", "Unsuppressed email/phone on record, verification date."),
      f("recency", "Verification recency", 10, "exclude", "When the role was last confirmed."),
    ] },
  },
  requirement: {
    name: "Requirement quality", entity: "requirement", purpose: "How complete, verified, urgent and attractive an office requirement is. Missing values are never filled in.",
    version: { bands: FIVE, config: {}, factors: [
      f("verified", "Verified", 15, "zero", "Client-confirmed vs draft/estimated."),
      f("area", "Area range", 15, "zero", "Min/target/max area provided."),
      f("location", "Preferred micro-market", 10, "zero", "Preferred geographies set."),
      f("budget", "Budget", 10, "exclude", "Budget min/max recorded. Unknown budget is excluded (not scored as zero) and listed as missing."),
      f("timing", "Move-in / decision date", 15, "zero", "Occupation or decision date set, and how soon."),
      f("specs", "Lease terms & specs", 10, "zero", "Lease duration, furnishing and other constraints captured."),
      f("decision_maker", "Decision-maker", 10, "zero", "Confirmed-by person or stakeholder recorded."),
      f("approval", "Approval process", 5, "zero", "Procurement process / commercial authority or an approver stakeholder recorded."),
      f("feasibility", "Commercial feasibility", 5, "exclude", "Recorded budget compared with asking rents of matched / shortlisted properties."),
      f("freshness", "Last verified", 15, "exclude", "Days since confirmation / last update."),
    ] },
  },
  opportunity: {
    name: "Opportunity attractiveness", entity: "opportunity", purpose: "Which open deals deserve attention first. Separate from stage and from win probability.",
    version: { bands: FIVE, config: {}, factors: [
      f("requirement", "Requirement strength", 15, "zero", "Requirement quality score."),
      f("company", "Company attractiveness", 10, "neutral", "Company score."),
      f("access", "Decision-maker access", 10, "zero", "Best contact relevance."),
      f("relationship", "Relationship strength", 10, "zero", "Relationship score."),
      f("supply", "Property availability", 10, "exclude", "Eligible shortlisted options from property matching."),
      f("value", "Commercial potential", 15, "exclude", "Expected fee, or requirement area. Never invented."),
      f("timing", "Timing", 10, "exclude", "Expected close / decision date."),
      f("mandate", "Mandate status", 10, "neutral", "Exclusive > non-exclusive > none."),
      f("engagement", "Engagement history", 5, "zero", "Recent meaningful interactions."),
      f("next_action", "Next action defined", 5, "zero", "A next action is recorded."),
    ] },
  },
  relationship: {
    name: "Relationship strength", entity: "organisation", purpose: "How strong the working relationship with a company is. Many logged emails do not by themselves mean strong.",
    version: { bands: [{ min: 75, label: "Strong" }, { min: 55, label: "Active" }, { min: 35, label: "Developing" }, { min: 15, label: "Weak" }, { min: 0, label: "No established relationship" }], config: {}, factors: [
      f("meetings", "Meetings", 25, "zero", "Meetings / site visits held."),
      f("recency", "Recency", 20, "zero", "Days since last meaningful interaction."),
      f("depth", "Quality of interactions", 15, "zero", "Share of interactions marked meaningful (not volume)."),
      f("duration", "Relationship duration", 10, "zero", "Months between first and last interaction."),
      f("business", "Past business", 15, "zero", "Won deals / existing mandates."),
      f("owner", "Owner assessment", 15, "exclude", "Assessment recorded by an authorised user, with reason."),
    ] },
  },
};
export const MODEL_KEYS = Object.keys(MODELS) as ModelKey[];
