import type { Tour } from "../types";

export const tour: Tour = {
  key: "transactions",
  module: "Module 16",
  title: "Transactions",
  summary: "Run a confirmed requirement through to handover: offers, negotiation, approvals, documents, deposits, execution, possession and closure.",
  minutes: 6,
  learned: [
    "Each transaction has a unique code and a stage plan for its type; templates can change the stages",
    "Every offer and counteroffer is a new version with a reason — compare whole packages, not just rent",
    "Client requirement, adviser recommendation and counterparty proposal stay in separate columns",
    "Agreeing a term needs evidence; agreed values are never overwritten",
    "Approvals are tied to the exact document version — a new version invalidates them",
    "Due is not paid, signed is not executed, possession is not handover — each milestone has its own evidence",
    "Completion is blocked until issues, approvals, documents, deposits and handover are resolved; messages are drafts you send",
  ],
  steps: [
    { route: "/transactions", title: "Transactions", body: "Each transaction runs a confirmed client requirement from offers to handover. The list shows its code, type, status, priority and current stage." },
    { route: "/transactions", title: "Create one", body: "Give it a name and type (conventional, managed office, coworking, renewal, relocation, build-to-suit or investment), link the confirmed requirement and deal, and press Create transaction." },
    { route: "/transactions", kind: "do", task: "Open a transaction", title: "Open a transaction", body: "Click a transaction name in the list.", waitFor: { type: "route", route: "/transactions/*" } },
    { route: "@current", title: "The command view", body: "Agreed and disputed terms, open, overdue and blocking issues, pending approvals, outstanding documents and closure blockers — then next actions and the route to completion." },
    { route: "@current", title: "Offers and positions", body: "Section 4 keeps every offer version with its parent and reason; compare any two as packages. Section 2 keeps the client's, your and the landlord's positions apart; section 5 tracks each point to agreed, documented and verified." },
    { route: "@current", title: "Issues, inspections and stakeholders", body: "Every issue has an owner, next action and due date (or a reason), with dependencies. Clarifications are checked against the requirement; document requests go requested → received → verified. Stakeholders show who is blocking." },
    { route: "@current", title: "Documents and approvals", body: "LOI, term sheet and agreement versions get a clause diff and a check against agreed terms. Approvals store the version's fingerprint; only the assigned reviewer decides, and legal only by the legal reviewer." },
    { route: "@current", title: "Execution to closure", body: "Track each deposit stage with evidence, each execution milestone separately, fit-out and the handover checklist. Generate the closure pack any time; completion stays blocked until everything is resolved. Executed leases are handed to Leases." },
  ],
};
