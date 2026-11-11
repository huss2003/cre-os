import { MODEL_DEEP, MODEL_FAST } from "./provider";

export type Intent =
  | "company_summary" | "meeting_prep" | "compare_properties" | "leases_expiring" | "rejected_options" | "deal_review"
  | "priority_accounts" | "commitments" | "send_proposal" | "memory_correction" | "research" | "general"
  | "research_why" | "decision_makers" | "history" | "outreach_draft" | "requirement_correction" | "automation"
  | "requirement_change" | "similar_requirements" | "what_changed";

/** Cheap keyword classifier (no LLM call). Order matters: the more specific intents first. */
const RULES: [Intent, RegExp][] = [
  // "prepare tomorrow's meetings and list pending client commitments" / "what is running?" — background workflows
  ["automation", /\b(prepare|prep)\b.*\bmeetings\b.*\b(commitments?|promises?)\b|\b(background (jobs?|tasks?)|running (jobs?|tasks?)|workflows?|automation|pending approvals?)\b|\bwhat('s| is) running\b|\b(cancel|pause) (the|that|this) (job|task|run|workflow)\b/i],
  // "now 30,000 SF, not 25,000" / "280 seats instead of 250" — a correction to a requirement value (before memory_correction)
  ["requirement_correction", /\bnow\s+(?:₹\s*)?[\d][\d,.]*\s*(?:k\b)?.*\bnot\b|\binstead of\s+(?:₹\s*)?[\d][\d,.]*/i],
  // Module 13 memory questions (§7.3)
  ["similar_requirements", /\bsimilar requirements?\b|\b(companies|clients|accounts)\b.*\bsimilar\b|\bsimilar\b.*\b(companies|clients|needs)\b/i],
  ["requirement_change", /\b(has|have|did)\b.*\brequirements?\b.*\bchang\w*|\brequirements?\b.*\b(changed|evolv\w*|history)\b/i],
  ["what_changed", /\bwhat('s| has)? changed\b|\bwhat changed\b|\bany changes\b/i],
  ["memory_correction", /\b(outdated|no longer|now prefers?|correct(ion)?|that('s| is) wrong|update (the|that) (memory|preference)|forget that)\b/i],
  ["send_proposal", /\b(send|email|share|forward)\b.*\b(proposal|quote|deck|offer|brochure|document)\b/i],
  ["deal_review", /\b(deal|opportunit(y|ies)|mandate)\b.*\breview\b|\breview\b.*\b(deal|opportunity)\b|prepare (this|the) deal/i],
  ["history", /\bwhat did\b.*\b(say|said|mention\w*|tell|told|discuss\w*)\b|\b(said|say|mentioned)\s+about\b|\blast discuss\w*\b|\bspoken to\b.*\bbefore\b/i],
  ["meeting_prep", /\bknow before (meeting|my meeting|the meeting|speaking|calling|seeing)\b/i],
  ["meeting_prep", /\b(prepare|prep|brief)\b.*\bmeeting\b|\bmeeting\b.*\b(prep|brief)\b/i],
  ["outreach_draft", /\b(draft|write|prepare)\b.*\b(follow[- ]?up|e-?mail|message|note to|outreach|reply|intro)\b/i],
  ["research_why", /\bwhy\b.*\b(identif\w*|opportunit\w*|flag\w*|relevant|signal\w*)\b/i],
  ["decision_makers", /\b(important people|decision.?makers?|stakeholders?|key (people|contacts)|who (are|should|do)\b.*\b(speak|talk|meet|contact|approach))\b/i],
  ["compare_properties", /\bcompar(e|ison)\b|\b(vs\.?|versus)\b|\bfinancially (better|best|cheaper)\b|\b(cheapest|cheaper|better) (option|property|building|deal)\b/i],
  ["leases_expiring", /\blease[s]?\b.*\b(expir|end|renew)|\bexpir\w*\b.*\blease/i],
  ["rejected_options", /\breject(ed|ions?)?\b|\bturned down\b|\bdeclined\b/i],
  ["commitments", /\b(commitments?|promise[sd]?|follow[- ]?ups?|owe)\b/i],
  ["priority_accounts", /\b(priorit\w*|focus on|top accounts?|which accounts?|rank)\b/i],
  ["research", /\b(metro|infrastructure|news|research|web|search online|latest|benefit from|near(by)?|distance)\b/i],
  ["company_summary", /\b(everything|tell me about|summar\w*|overview|profile|who is|what do we know)\b/i],
];

export function classifyIntent(request: string): Intent {
  for (const [intent, re] of RULES) if (re.test(request)) return intent;
  return "general";
}

const DEEP_INTENTS: Intent[] = ["deal_review", "compare_properties", "research", "priority_accounts", "meeting_prep", "research_why"];

export interface Route { intent: Intent; route: "fast" | "deep"; model: string; webSearch: boolean }

/** fast (haiku) for lookups, deep (sonnet) for multi-step / comparison / review / research / "why" / ranking. */
export function routeRequest(request: string, opts: { hasAttachments?: boolean } = {}): Route {
  const intent = classifyIntent(request);
  const multiStep = /\b(and then|then|after that|step by step)\b/i.test(request) || request.split(/[?.]\s/).length > 2;
  const why = /\bwhy\b/i.test(request) && intent !== "rejected_options";
  const deep = DEEP_INTENTS.includes(intent) || multiStep || why || request.length > 400 || !!opts.hasAttachments;
  return { intent, route: deep ? "deep" : "fast", model: deep ? MODEL_DEEP() : MODEL_FAST(), webSearch: intent === "research" };
}
