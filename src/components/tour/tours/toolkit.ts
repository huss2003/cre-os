import type { Tour } from "../types";

export const tour: Tour = {
  key: "toolkit",
  module: "Module 8",
  title: "Deal toolkit",
  summary: "Take a Pune office requirement from brief to comparison, costing, negotiation and a client-ready deliverable.",
  minutes: 9,
  steps: [
    { route: "/toolkit", target: "toolkit-sections", title: "Your deal toolkit", body: "Each section is one step of a deal, from the requirement brief to the client deliverable. The number on the right shows how many analyses you have saved." },
    { route: "/toolkit", target: "toolkit-needs-info", title: "What needs attention", body: "Needs information lists analyses with missing figures. Expired or expiring quotes are flagged at the top, so you never present stale rent to a client." },
    { route: "/toolkit/brief", target: "toolkit-brief", title: "Requirement brief", body: "Pick a requirement, for example 25,000 sq ft in Kharadi. Every item is marked Confirmed, Estimated, Assumption or Missing. To confirm something, it goes through Review first." },
    { route: "/toolkit/compare", target: "toolkit-compare", title: "Compare properties", body: "Press New comparison and choose the shortlisted buildings. Each gets a weighted rating, and a building that fails a must-have is shown as Not eligible, whatever its score." },
    { route: "/toolkit/models", target: "toolkit-models", title: "Rating models", body: "Set what matters to this client, such as location, rent and parking. Weights must total 100. Mark rules as mandatory or disqualifying to enforce must-haves." },
    { route: "/toolkit/lease", target: "toolkit-lease", title: "Lease economics", body: "Enter rent, CAM, escalation, rent-free months and deposit. The deposit is shown separately because it comes back. Leave a box blank if you don't know it; blank means unknown, not zero." },
    { route: "/toolkit/occupancy", target: "toolkit-occupancy", title: "Occupancy economics", body: "See effective rent after rent-free, cash needed at signing and present value. Use the what-if controls to test a lower rent or longer rent-free period." },
    { route: "/toolkit/negotiation", target: "toolkit-negotiation", title: "Negotiation rounds", body: "Save each landlord offer as its own version. You see what changed between offers and what each concession package is worth. Nothing is sent to the landlord from here." },
    { route: "/toolkit/managed", target: "toolkit-managed", title: "Conventional vs managed", body: "Compare a bare lease with a managed-office quote on equal terms: same period, per usable seat. Services already in the managed price are counted once, never twice." },
    { route: "/toolkit/renewal", target: "toolkit-renewal", title: "Renew or relocate", body: "Compare staying with moving, including fit-out and moving costs. The break-even month shows when a move pays off. A lower rent alone does not mean relocating wins." },
    { route: "/toolkit/financing", target: "toolkit-financing", title: "Fit-out budget and financing", body: "In Fit-out, track each cost as estimated, approved or actual. Here, finance it: a partner like Jasfo is treated like any other partner, and you get the full EMI schedule." },
    { route: "/toolkit/quotes", target: "toolkit-quotes", title: "Quotation intake", body: "Upload or paste a landlord or operator quote. AI reads the terms for you to check, and each quote is saved as a new version so you can compare versions." },
    { route: "/toolkit/packs", target: "toolkit-packs", title: "Site visit pack and deck", body: "Pick the requirement and buildings for a site visit. You get a Word visit pack with a checklist and an editable PowerPoint deck." },
    { route: "/toolkit/deliverables", target: "toolkit-deliverables", title: "Client deliverables", body: "Choose the analyses to include and generate a proposal, a workbook and a decision summary. Estimated or unconfirmed figures stay labelled in every file." },
  ],
};
