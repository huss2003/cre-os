import type { Tour } from "../types";

export const tour: Tour = {
  key: "contacts",
  module: "Module 4",
  title: "Contact enrichment",
  summary: "Find the decision-makers at a company, check them, and approve them into your contacts.",
  minutes: 6,
  practice: { label: "Priya Sharma (tutorial)", href: "/contacts/{contact}", fallback: "/contacts?tab=decision" },
  steps: [
    { route: "/contacts", target: "contacts-tabs", kind: "do", task: "Click any of the four sections", waitFor: { type: "click" }, title: "Four sections", body: "To review holds what research found. Find people starts new research. Your contacts is your saved list, and Checks shows runs, job changes and duplicates." },
    { route: "/contacts?tab=research", target: "contacts-find-company", title: "Find people at a company", body: "Choose a company and press Find people. Only public sources are searched, and nothing is saved until you approve it." },
    { route: "/contacts?tab=research", target: "contacts-appointment-news", title: "Appointment news", body: "Scan the news for new real estate, facilities and finance heads from the last 90 days. A new head often means a new office move." },
    { route: "/contacts?tab=research", target: "contacts-linkedin-import", title: "Import LinkedIn connections", body: "Download Connections.csv from LinkedIn and upload it here. Your own network then shows up next to the research." },
    { route: "/contacts?tab=review", target: "contacts-section-hint", title: "Approve or reject", body: "Each finding shows where it came from. Approve to add the person, or reject to drop it. If it looks like someone you already have, choose whether it is the same person." },
    { route: "/contacts?tab=review", title: "Verification statuses", body: "Each person has a status, such as Needs review, Employment check or Verified. Only Verified details have been checked against a source." },
    { route: "/contacts?tab=decision", target: "contacts-filters", kind: "do", task: "Type Priya in the name filter", title: "Your contacts", body: "Filter your saved people by name, department, company or location. Type: Priya", waitFor: { type: "input" } },
    { route: "@current", target: "contacts-filters", kind: "do", task: "Filter, then open Priya Sharma (tutorial)", title: "Open a contact", body: "Apply the filter, then click Priya Sharma (tutorial).", waitFor: { type: "route", route: "/contacts/*" } },
    { route: "/contacts?tab=history", target: "contacts-subnav", title: "Checks", body: "See past research runs, people who changed jobs, possible duplicates and the sources used." },
    { route: "@current", title: "Plan outreach", body: "On a contact page, press Plan outreach to prepare a message. Nothing is sent for you; you send it yourself — the Outreach tutorial walks you through it with Priya." },
  ],
};
