import type { EntityType } from "../types";

/** Which record the current screen is about, derived from the URL. Labels are filled in later (or show the type). */
export interface PageFocus { type: EntityType; id: string; href: string }

const ROUTES: [RegExp, EntityType][] = [
  [/^\/companies\/([^/]+)/, "company"],
  [/^\/people\/([^/]+)/, "person"],
  [/^\/buildings\/([^/]+)/, "asset"],
  [/^\/requirements\/([^/]+)/, "requirement"],
  [/^\/deals\/([^/]+)/, "opportunity"],
  [/^\/meetings\/([^/]+)/, "meeting"],
  [/^\/outreach\/([^/]+)/, "outreach"],
  [/^\/signals\/([^/]+)/, "signal"],
  [/^\/toolkit\/[^/]+\/([^/]+)/, "analysis"],
];
const NOT_IDS = new Set(["new", "edit", "import", "settings"]);

export function focusFromPath(pathname: string | null | undefined): PageFocus | null {
  if (!pathname) return null;
  for (const [re, type] of ROUTES) {
    const m = pathname.match(re);
    if (m && !NOT_IDS.has(m[1])) return { type, id: decodeURIComponent(m[1]), href: m[0] };
  }
  return null;
}

export const TYPE_LABEL: Record<EntityType, string> = {
  company: "Company", person: "Person", asset: "Building", space: "Space", requirement: "Requirement",
  opportunity: "Deal", lease: "Lease", meeting: "Meeting", outreach: "Outreach", analysis: "Analysis",
  document: "Document", task: "Task", signal: "Signal",
};

/** Record-specific quick prompts (spec §12.2). */
export const QUICK_PROMPTS: Partial<Record<EntityType, string[]>> = {
  company: ["Summarise this company", "Find its decision-makers", "Show its latest signals", "Prepare an outreach message"],
  person: ["Summarise our relationship", "What did I discuss with this person?", "Draft a follow-up", "Prepare me for the next meeting"],
  asset: ["Compare this property with alternatives", "Show its commercial details", "Find companies that may need this property", "Prepare a property presentation"],
  opportunity: ["Why is this deal stuck?", "Show unresolved issues", "Prepare this deal for review", "Compare the current offers"],
  requirement: ["Summarise this requirement", "What is still missing?", "Shortlist matching buildings", "Compare renewal vs moving"],
  meeting: ["Prepare my meeting brief", "Summarise this meeting", "Extract commitments", "Create follow-up tasks"],
  outreach: ["Summarise this outreach", "Improve this draft", "Who else should I contact?"],
  signal: ["Explain this signal", "Which accounts does this affect?", "Draft a follow-up"],
  analysis: ["Explain this analysis", "What assumptions matter most?", "Summarise for the client"],
};

export const GENERAL_PROMPTS = [
  "Which five accounts should I focus on this week?",
  "Prepare me for my next meeting",
  "Find leases expiring in 12 months",
  "What did I promise clients last week?",
  "Compare renewal vs moving",
  "Find buildings near the upcoming metro",
];
