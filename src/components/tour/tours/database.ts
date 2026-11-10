import type { Tour } from "../types";

export const tour: Tour = {
  key: "database",
  module: "Module 1",
  title: "Database",
  summary: "Where your companies, people, buildings, requirements and deals live, and how data gets in.",
  minutes: 4,
  steps: [
    { route: "/companies", target: "companies-header", title: "Companies", body: "Every occupier, landlord and developer you deal with has one company page. It collects their people, buildings, leases and deals in one place.", placement: "bottom" },
    { route: "/people", target: "people-header", title: "People", body: "Your contacts at those companies, with how to reach them. Nobody is invented: a contact only appears if you or an import added them.", placement: "bottom" },
    { route: "/buildings", target: "buildings-header", title: "Buildings", body: "Campuses, towers and spaces in Pune and beyond. Vacancy is only shown when there is a dated source behind it.", placement: "bottom" },
    { route: "/requirements", target: "requirements-header", title: "Requirements", body: "What each client is looking for: size, location, budget, timing. You can see what is confirmed and what still needs asking.", placement: "bottom" },
    { route: "/deals", target: "deals-header", title: "Deals", body: "Your pipeline, stage by stage. Open a deal to see its options, quotes, maths and fees.", placement: "bottom" },
    { route: "/search", target: "search-form", title: "Search everything", body: "Type a company, person or building name to find it anywhere in the system.", placement: "bottom" },
    { route: "/imports", target: "imports-upload", title: "Bring in your sheets", body: "Upload your Excel files here, such as building lists or lease trackers. Each row is matched to existing records instead of creating duplicates. You can also add notes, cards and emails from Capture.", placement: "left" },
    { route: "/approvals", target: "review-header", title: "Review before it counts", body: "Anything that changes your records, from an import, a capture or the AI, waits here first. Check it and press Reviewed to add it.", placement: "bottom" },
    { route: "/approvals", target: "review-tabs", title: "Queues", body: "Use these tabs to work through each type of item waiting for you. Nothing is saved to your records until you approve it.", placement: "bottom" },
  ],
};
