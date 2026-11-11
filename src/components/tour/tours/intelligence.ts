import type { Tour } from "../types";

export const tour: Tour = {
  key: "intelligence",
  module: "Module 13",
  title: "Intelligence & memory",
  summary: "See what CRE OS remembers about companies, contacts, buildings and requirements: what changed, what to do next, the timeline and memory quality.",
  minutes: 6,
  practice: { label: "your practice company", href: "/companies/{company}", fallback: "/companies" },
  learned: [
    "Every company, contact, building and requirement page has an Intelligence panel with changes, recommendations and history",
    "Employer moves keep the old job as history; the old company's deals stay with that company",
    "Requirement versions are kept: what changed, when, from which source and why",
    "Preferences mentioned in several notes stay preferences until the client confirms them",
    "Recommendations explain why, with evidence and sources — nothing runs by itself",
    "Memory quality counts outdated, missing, contradictory and unsourced information; unknown stays unknown",
  ],
  steps: [
    { route: "/intelligence", title: "What CRE OS has learned", body: "Intelligence collects recommendations, detected changes, the timeline and memory quality in one place. Every item links to its source; unknown stays unknown." },
    { route: "@practice", title: "The Intelligence panel", body: "Company, contact, building, requirement and deal pages have a collapsible “Intelligence” panel near the top: a labelled summary, important changes, recommendations, people, deals, promises, objections and open questions." },
    { route: "@practice", title: "Contacts and employer moves", body: "On a contact, the panel keeps current and previous employers. When someone moves, the old job becomes history and the old company's deals stay with that company. Relationship strength lists every factor and its points — talking often counts for little on its own." },
    { route: "/requirements", title: "Requirement history", body: "Open a requirement and its Intelligence panel: “What changed” shows old → new values with the version, date and reason. The original is never overwritten; an old value is obsolete only when the client confirmed the new one." },
    { route: "/intelligence/changes", title: "Detected changes", body: "Employer changes, decision-maker changes, requirement area / budget / location / timeline changes, old quotes and rejected buildings with new availability. Filter by type, record and state; Acknowledge or Dismiss each one." },
    { route: "/intelligence/recommendations", kind: "do", task: "Open the Recommendations tab", title: "Recommendations", body: "Each suggestion shows why, the evidence, its sources, a confidence level and the next step. Done and Dismiss record your decision; rule-based ones clear by themselves when the record is updated.", waitFor: { type: "route", route: "/intelligence/recommendations" } },
    { route: "/intelligence/timeline", title: "Timeline with filters", body: "Conversations, meetings, job changes, requirement versions, quotes, commitments, objections and rejections — newest first. Filter by company, contact, event type and dates." },
    { route: "/intelligence/quality", title: "Memory quality", body: "Eleven checks with exact counts: outdated, missing, contradictory, unsupported assumptions, unverified requirements, stale quotes and more. Scan for changes, acknowledge changes or correct a status with a reason." },
    { route: "/meetings", title: "Before a meeting", body: "A meeting brief includes “From your records”: attendees' current roles and past employers, the last discussion, pending promises, the requirement, old quotes and questions to ask." },
    { route: "/assistant", title: "Ask AI about history", body: "Ask, for example, “Has the requirement changed?”, “Who are the decision-makers?” or “Which properties did they reject and why?” Answers come from your records with sources." },
  ],
};
