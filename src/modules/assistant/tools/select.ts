/**
 * Picks the tool subset sent to the model for one request (token saver #2).
 * Groups are fixed and always emitted in the same canonical order, so the same kind of question
 * produces a byte-identical tool list — which keeps Anthropic's prompt cache warm.
 * If the model needs something outside the subset it calls `load_more_tools`, and the engine
 * adds that group for the rest of the run.
 */
import type { Intent } from "../engine/router";
import type { EntityType } from "../types";

export const TOOL_GROUPS = {
  core: ["search_companies", "get_company_profile", "search_contacts", "get_contact_profile", "search_opportunities", "get_opportunity_details", "recall_memories"],
  properties: ["search_properties", "get_property_details", "search_requirements", "get_requirement_details", "calculate_distance", "show_on_map"],
  meetings: ["get_upcoming_meetings", "get_meeting_history", "get_commitments", "generate_meeting_brief", "create_internal_task"],
  outreach: ["get_outreach_history", "find_decision_makers", "generate_outreach_draft", "prepare_send"],
  scoring: ["get_scores", "rank_priority_accounts", "get_research_signals"],
  leases: ["find_leases_expiring"],
  finance: ["compare_properties", "calculate_lease_economics", "compare_renewal_vs_relocation", "calculate_occupancy_cost", "compare_quotes", "analyse_fitout"],
  deals: ["explain_deal_stuck", "generate_deal_review", "get_commitments", "get_meeting_history"],
  documents: ["search_documents", "retrieve_document_content", "extract_lease_terms", "save_lease_terms"],
  research: ["web_research", "get_research_signals", "search_properties", "calculate_distance", "show_on_map"],
  memory: ["save_memory", "correct_memory", "forget_memory", "restrict_memory"],
  changes: ["update_company_record", "update_requirement_record", "change_opportunity_stage", "create_opportunity", "archive_record"],
  commands: ["list_saved_commands", "save_command"],
  data: ["search_company_locations", "add_company_location", "save_landlord_offer", "revise_landlord_offer", "compare_landlord_offers"],
  briefs: ["morning_brief", "capture_meeting_notes"],
  outputs: ["export_deliverable", "show_on_map"],
} as const;
export type ToolGroup = keyof typeof TOOL_GROUPS;
export const GROUP_ORDER = Object.keys(TOOL_GROUPS) as ToolGroup[];

const BY_INTENT: Partial<Record<Intent, ToolGroup[]>> = {
  company_summary: ["properties", "meetings", "scoring", "leases", "documents"],
  meeting_prep: ["meetings", "properties", "documents"],
  compare_properties: ["properties", "finance", "data"],
  leases_expiring: ["leases", "properties", "data"],
  rejected_options: ["properties", "documents", "meetings"],
  deal_review: ["deals", "properties", "finance", "meetings"],
  priority_accounts: ["scoring", "meetings"],
  commitments: ["meetings", "outreach"],
  send_proposal: ["outreach", "documents"],
  memory_correction: ["memory"],
  research: ["research", "properties"],
};

const BY_WORDS: [ToolGroup, RegExp][] = [
  ["properties", /\b(building|tower|propert|space|floor|option|requirement|vacan|availab|micro.?market|location)/i],
  ["meetings", /\b(meeting|call|visit|task|remind|promis|commit|follow.?up|agenda)/i],
  ["outreach", /\b(email|draft|message|whatsapp|linkedin|outreach|write to|reply|send|decision.?maker)/i],
  ["scoring", /\b(score|rank|priorit|hot|focus|signal|expan|hiring|funding)/i],
  ["leases", /\b(lease|expir|renew|lock.?in|escalat)/i],
  ["finance", /\b(rent|cost|tco|npv|fit.?out|quote|economics|cheaper|budget|calculat|compar)/i],
  ["deals", /\b(deal|opportunit|stuck|stage|pipeline|mandate)/i],
  ["documents", /\b(document|pdf|note|attachment|file|said|mentioned|minutes|proposal)/i],
  ["research", /\b(metro|news|web|online|infrastructure|research|market|construction|road)/i],
  ["memory", /\b(remember|memory|forget|prefer|outdated)/i],
  ["changes", /\b(update|change|set|move .* to|archive|delete|create (an? )?(deal|opportunity)|mark)/i],
  ["data", /\b(factory|factories|plant|warehouse|midc|hq|headquarter|offices? in|locations?|landlord|offer|loi|term sheet)/i],
  ["briefs", /\b(morning brief|my day|today|notes?|minutes|debrief|just met|after (the|my) meeting)/i],
  ["outputs", /\b(deck|slides?|powerpoint|pptx|word doc|docx|pdf|export|download|map|plot)/i],
  ["commands", /\b(save (this|as)|saved command|every (morning|day|week)|schedule|routine)/i],
];

const BY_FOCUS: Partial<Record<EntityType, ToolGroup[]>> = {
  company: ["scoring", "meetings", "outreach"],
  person: ["meetings", "outreach"],
  asset: ["properties", "finance"],
  requirement: ["properties", "finance"],
  opportunity: ["deals", "properties", "finance"],
  meeting: ["meetings", "documents", "briefs"],
  outreach: ["outreach"],
  analysis: ["finance", "properties"],
};

export interface Selection { groups: ToolGroup[]; ids: string[]; all: boolean }

/** Returns the canonical, de-duplicated tool id list. `general` questions with no keyword match get every tool. */
export function selectTools(opts: { intent: Intent; request: string; focusType?: EntityType | null; extraGroups?: ToolGroup[]; available: string[] }): Selection {
  const picked = new Set<ToolGroup>(["core"]);
  for (const g of BY_INTENT[opts.intent] ?? []) picked.add(g);
  for (const [g, re] of BY_WORDS) if (re.test(opts.request)) picked.add(g);
  for (const g of (opts.focusType && BY_FOCUS[opts.focusType]) ?? []) picked.add(g);
  for (const g of opts.extraGroups ?? []) picked.add(g);
  if (opts.intent === "general" && picked.size <= 1) return { groups: GROUP_ORDER, ids: opts.available, all: true };
  const groups = GROUP_ORDER.filter((g) => picked.has(g));
  const ids: string[] = [];
  for (const g of groups) for (const id of TOOL_GROUPS[g]) if (!ids.includes(id) && opts.available.includes(id)) ids.push(id);
  return { groups, ids, all: false };
}

/** The meta tool always included with a subset, so the model can widen it instead of failing. */
export const LOAD_MORE_TOOLS = {
  name: "load_more_tools",
  description: "Use only if none of the listed tools can do the job. Adds a tool group for the rest of this request. Groups: " +
    GROUP_ORDER.filter((g) => g !== "core").map((g) => `${g} (${TOOL_GROUPS[g].slice(0, 3).join(", ")}${TOOL_GROUPS[g].length > 3 ? ", …" : ""})`).join("; "),
  input_schema: { type: "object", properties: { group: { type: "string", enum: GROUP_ORDER.filter((g) => g !== "core") } }, required: ["group"] },
};
