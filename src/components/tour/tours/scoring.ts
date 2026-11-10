import type { Tour } from "../types";

export const tour: Tour = {
  key: "scoring",
  module: "Module 3",
  title: "Scoring engine",
  summary: "See who to focus on first, why each score is what it is, and how to tune the rules.",
  minutes: 4,
  steps: [
    { route: "/scoring", target: "scoring-header", title: "Your priority list", body: "Every company, contact and deal gets a score from 0 to 100. Higher means worth your time sooner." },
    { route: "/scoring", target: "scoring-stats", title: "Scores at a glance", body: "These numbers show how many records are scored, waiting to recalculate, or short of data. They come straight from the database." },
    { route: "/scoring", target: "scoring-header", title: "Score everything at once", body: "Admins can press Score all to rescore every record in one go. It runs in the background, so you can keep working." },
    { route: "/scoring", target: "scoring-unranked", title: "New records not ranked yet", body: "When you add companies or contacts, they show up here until they are scored. Press Score these now to rank them." },
    { route: "/scoring", target: "scoring-tabs", title: "Pick what to rank", body: "Switch between companies, leads, contacts, requirements, deals and properties. Click any row to open its score." },
    { route: "/scoring", title: "Why a score is what it is", body: "Open any score to see each factor and the points it added. Missing information is listed so you know what to find out next." },
    { route: "/scoring", title: "Unknown stays unknown", body: "If a fact is missing, the score does not guess. It shows lower confidence instead, so a thin record never looks better than it is." },
    { route: "/scoring/models", target: "scoring-factors", title: "Rules and weights", body: "Change how much each factor counts, with no code. Weights are scaled to 100 for you." },
    { route: "/scoring/models", target: "scoring-versions", title: "Versions", body: "Every save makes a new version and keeps the old ones. Past scores stay explainable, and you can switch back any time." },
  ],
};
