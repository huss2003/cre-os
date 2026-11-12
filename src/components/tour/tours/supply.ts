import type { Tour } from "../types";

export const tour: Tour = {
  key: "supply",
  module: "Module 14",
  title: "Property supply & matching",
  summary: "See what is really available, compare operator centres, and match spaces to a requirement with clear explanations.",
  minutes: 4,
  learned: [
    "Nine availability statuses; lease expiry and future supply are never shown as vacancy",
    "Each row shows its source, last verification date and a confidence level",
    "Missing CAM or prices stay unknown — never zero; old prices are marked historical",
    "Matching applies hard filters first and explains every option, including failures",
    "Reconfirm stale or incomplete options before a presentation or site visit",
    "Rejections need a reason and are kept in the shortlist history",
  ],
  steps: [
    { route: "/buildings/supply", title: "Supply inventory", body: "Every space's current availability: status, area, rent and CAM, source and verification date, and how confident we are. Stale rows are counted at the top — reconfirm them before presenting." },
    { route: "/buildings/supply?tab=operators", title: "Operators", body: "Managed-office and coworking centres: seats available out of capacity, private offices, price per seat, services, extra charges and brokerage. Add or update a centre below." },
    { route: "/buildings/supply?tab=match", title: "Match a requirement", body: "Pick a requirement from the list to rank every space against it." },
    { route: "@current", title: "Explanations", body: "Each option shows why it ranks where it does: what it satisfies or fails, advantages, disadvantages, missing information, availability confidence and what needs verifying. Failures are ranked last, never hidden." },
    { route: "@current", title: "Reconfirm and feedback", body: "Check ready to present lists options to reconfirm before a presentation or site visit. Record client feedback on each shortlisted option; a rejection needs a reason and is kept in the history." },
  ],
};
