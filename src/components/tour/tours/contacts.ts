import type { Tour } from "../types";

export const tour: Tour = {
  key: "contacts",
  module: "Module 4",
  title: "Contact enrichment",
  summary: "Find the decision-makers at a company, check them, and approve them into your contacts.",
  minutes: 5,
  steps: [
    { route: "/contacts", target: "contacts-tabs", title: "Four sections", body: "To review holds what research found. Find people starts new research. Your contacts is your saved list, and Checks shows runs, job changes and duplicates." },
    { route: "/contacts?tab=research", target: "contacts-find-company", title: "Find people at a company", body: "Choose a company and press Find people. Only public sources are searched, and nothing is saved until you approve it." },
    { route: "/contacts?tab=research", target: "contacts-appointment-news", title: "Appointment news", body: "Scan the news for new real estate, facilities and finance heads from the last 90 days. A new head often means a new office move." },
    { route: "/contacts?tab=research", target: "contacts-linkedin-import", title: "Import LinkedIn connections", body: "Download Connections.csv from LinkedIn and upload it here. Your own network then shows up next to the research." },
    { route: "/contacts?tab=review", target: "contacts-section-hint", title: "Approve or reject", body: "Each finding shows where it came from. Approve to add the person, or reject to drop it. If it looks like someone you already have, choose whether it is the same person." },
    { route: "/contacts?tab=review", title: "Verification statuses", body: "Each person has a status, such as Needs review, Employment check or Verified. Only Verified details have been checked against a source." },
    { route: "/contacts?tab=decision", target: "contacts-filters", title: "Your contacts", body: "Filter your saved people by name, department, company or location. Use Missing info to see who needs more details." },
    { route: "/contacts?tab=history", target: "contacts-subnav", title: "Checks", body: "See past research runs, people who changed jobs, possible duplicates and the sources used." },
    { route: "/contacts", title: "Plan outreach", body: "Open any contact and press Plan outreach to prepare a message. Nothing is sent for you; you send it yourself." },
  ],
};
