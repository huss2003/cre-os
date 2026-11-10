import { MODEL_DEEP, MODEL_FAST } from "./provider";

export type Intent =
  | "company_summary" | "meeting_prep" | "compare_properties" | "leases_expiring" | "rejected_options" | "deal_review"
  | "priority_accounts" | "commitments" | "send_proposal" | "memory_correction" | "research" | "general";

/** Cheap keyword classifier (no LLM call). Order matters: the more specific intents first. */
const RULES: [Intent, RegExp][] = [
  ["memory_correction", /\b(outdated|no longer|now prefers?|correct(ion)?|that('s| is) wrong|update (the|that) (memory|preference)|forget that)\b/i],
  ["send_proposal", /\b(send|email|share|forward)\b.*\b(proposal|quote|deck|offer|brochure|document)\b/i],
  ["deal_review", /\b(deal|opportunit(y|ies)|mandate)\b.*\breview\b|\breview\b.*\b(deal|opportunity)\b|prepare (this|the) deal/i],
  ["meeting_prep", /\b(prepare|prep|brief)\b.*\bmeeting\b|\bmeeting\b.*\b(prep|brief)\b/i],
  ["compare_properties", /\bcompar(e|ison)\b|\b(vs\.?|versus)\b/i],
  ["leases_expiring", /\blease[s]?\b.*\b(expir|end|renew)|\bexpir\w*\b.*\blease/i],
  ["rejected_options", /\breject(ed|ions?)?\b|\bturned down\b|\bdeclined\b/i],
  ["commitments", /\b(commitments?|promised|follow[- ]?ups?|owe)\b/i],
  ["priority_accounts", /\b(priorit\w*|focus on|top accounts?|which accounts?|rank)\b/i],
  ["research", /\b(metro|infrastructure|news|research|web|search online|latest|benefit from|near(by)?|distance)\b/i],
  ["company_summary", /\b(everything|tell me about|summar\w*|overview|profile|who is|what do we know)\b/i],
];

export function classifyIntent(request: string): Intent {
  for (const [intent, re] of RULES) if (re.test(request)) return intent;
  return "general";
}

const DEEP_INTENTS: Intent[] = ["deal_review", "compare_properties", "research", "priority_accounts", "meeting_prep"];

export interface Route { intent: Intent; route: "fast" | "deep"; model: string; webSearch: boolean }

/** fast (haiku) for lookups, deep (sonnet) for multi-step / comparison / review / research / "why" / ranking. */
export function routeRequest(request: string, opts: { hasAttachments?: boolean } = {}): Route {
  const intent = classifyIntent(request);
  const multiStep = /\b(and then|then|after that|step by step)\b/i.test(request) || request.split(/[?.]\s/).length > 2;
  const why = /\bwhy\b/i.test(request) && intent !== "rejected_options";
  const deep = DEEP_INTENTS.includes(intent) || multiStep || why || request.length > 400 || !!opts.hasAttachments;
  return { intent, route: deep ? "deep" : "fast", model: deep ? MODEL_DEEP() : MODEL_FAST(), webSearch: intent === "research" };
}
