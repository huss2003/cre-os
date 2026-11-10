import type { Tour } from "../types";

export const tour: Tour = {
  key: "toolkit",
  module: "Module 8",
  title: "Deal toolkit",
  summary: "Compare three Kharadi options for the practice requirement, cost the winner, negotiate and build the deliverables.",
  minutes: 14,
  practice: { label: "Practice Co — 25,000 sf in Kharadi (tutorial)", href: "/requirements/{requirement}", fallback: "/requirements" },
  learned: [
    "A comparison rates each option against the requirement; failing a must-have means Not eligible",
    "Blank means unknown, never zero — missing figures are listed, not guessed",
    "Lease economics shows total cost and present value, with the deposit kept separate",
    "Each landlord offer is a new version, and you see exactly what moved",
    "Deliverables keep estimated and unconfirmed figures labelled",
  ],
  steps: [
    { route: "/toolkit", target: "toolkit-sections", title: "Your deal toolkit", body: "Each section is one step of a deal. You'll take the practice requirement — 25,000 sq ft in Kharadi — from comparison to deliverables." },
    { route: "/toolkit/compare", target: "compare-new", kind: "do", task: "Press New comparison", title: "Start a comparison", body: "Press New comparison.", waitFor: { type: "click" } },
    { route: "@current", target: "compare-basics", kind: "do", task: "Give it a title and pick the practice requirement", title: "Basics", body: "Title: \"Kharadi 25k options\". Requirement: \"Practice Co — 25,000 sf in Kharadi (tutorial)\". Leave the rest.", waitFor: { type: "input" } },
    { route: "@current", target: "compare-manual", kind: "do", task: "Fill Property 1 with Building A", title: "Property 1 — Building A", body: "Name: Building A · Micro-market: Kharadi · Grade: A · Area basis: chargeable · Area 25000 · Rent 85 · CAM 15 · Deposit 6 · Rent-free 3 · Escalation 15 every 3 · Metro 1.2 · Figures are: quoted", waitFor: { type: "input" } },
    { route: "@current", target: "compare-manual", kind: "do", task: "Fill B and C, then press Run comparison", title: "Properties 2 and 3", body: "Open Property 2 — Building B: Kharadi · A+ · chargeable · 26000 · Rent 95 · CAM 18 · Deposit 10 · Rent-free 2 · 15 every 3 · Metro 0.8 · quoted.\nOpen Property 3 — Building C: Hadapsar · B · chargeable · 18000 · Rent 65 · CAM 12 · Deposit 6 · Rent-free 1 · 15 every 3 · Metro 4.5 · estimated.\nThen press Run comparison at the bottom.", waitFor: { type: "element", selector: "[data-tour=\"compare-recommendation\"]" } },
    { route: "@current", target: "compare-recommendation", title: "The recommendation", body: "The top-scoring eligible option, with the reason in plain words. Anything to check before advising is flagged on the right." },
    { route: "@current", target: "compare-table", title: "Eligible or not", body: "Building C is too small for a 25,000 sq ft need and outside the preferred area, so it should show Not eligible — whatever its score. Manual rows are marked for verification." },
    { route: "/toolkit/lease", target: "lease-form", kind: "do", task: "Enter Building A's terms and press Calculate & save", title: "Lease economics for A", body: "Title: Building A terms · Discount 10 · Offer name: Building A · Area 25000 · Rent 85 · Tenure 60 · Lease commencement 2027-04-01 · Rent-free 3 · Deposit 6 · Escalation 15 every 36 · CAM 15. Leave parking blank — blank means unknown, not zero.", waitFor: { type: "click", target: "lease-save" } },
    { route: "@current", target: "toolkit-lease", title: "What A really costs", body: "Total cost and present value over the lease, with the deposit shown separately because it comes back. Unknown parking is flagged as incomplete instead of counted as zero." },
    { route: "/toolkit/negotiation", target: "nego-offer1", kind: "do", task: "Record the landlord's Offer 1 and save it", title: "Negotiation — Offer 1", body: "Title: Building A — landlord · Discount 10 · then the same terms as before: area 25000, rent 85, tenure 60, commencement 2027-04-01, rent-free 3, deposit 6, escalation 15 every 36, CAM 15. Press Save Offer 1.", waitFor: { type: "click", target: "nego-save1" } },
    { route: "@current", target: "nego-add-offer", kind: "do", task: "Record Offer 2: rent 82, rent-free 4", title: "The landlord counters", body: "The form is pre-filled with Offer 1. Change Rent to 82 and Rent-free to 4, add a note like \"Counter after site visit\", and press Save as Offer 2.", waitFor: { type: "click", target: "nego-save-offer" } },
    { route: "@current", target: "nego-offers", title: "What moved", body: "Both offers side by side, plus exactly which terms changed and what that is worth. Nothing is sent to the landlord from here." },
    { route: "/toolkit/deliverables", target: "deliv-pick", kind: "do", task: "Choose the practice requirement and press Show analyses", title: "Client deliverables", body: "Pick \"Practice Co — 25,000 sf in Kharadi (tutorial)\" and press Show analyses.", waitFor: { type: "element", selector: "[data-tour=\"deliv-generate\"]" } },
    { route: "@current", target: "deliv-generate", title: "Generate the files", body: "Tick the analyses to include and press Generate 3 files: a Word proposal, an Excel workbook and a decision summary. Estimated or unconfirmed figures stay labelled in every file." },
  ],
};
