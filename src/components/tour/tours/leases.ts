import type { Tour } from "../types";

export const tour: Tour = {
  key: "leases",
  module: "Module 15",
  title: "Lease lifecycle",
  summary: "Track every lease from draft to handover: dates read from the agreement, human-confirmed deadlines, escalations, renewals, terminations and obligations.",
  minutes: 6,
  learned: [
    "Leases start as draft or negotiation; executed and active need a signed agreement and confirmed dates",
    "Dates are read from the agreement by code, with the clause and page — only a person's confirmation makes a contractual deadline",
    "Reminders are created only from confirmed dates and stay inside CRE OS",
    "Escalations show the expected rent and check it against what was recorded",
    "Expiry is a conversation to start, not proof the tenant will move — renewals have their own pipeline",
    "Totals use known values only; missing information is listed, never counted as zero",
  ],
  steps: [
    { route: "/leases", title: "The lease dashboard", body: "Headline counts (active leases, expiries, renewal deadlines, escalations, lock-ins, break options, obligations) count only confirmed dates. Dates awaiting review are shown separately." },
    { route: "/leases", title: "Filters and milestones", body: "Filter by status, category, event type and time window. Upcoming milestones lists each confirmed date with its lease; the table below shows what each lease still needs." },
    { route: "/leases/new", title: "Add a lease", body: "Pick the tenant, landlord and property (Unknown is fine), the category and status, and any terms you know. Blank stays unknown — never zero." },
    { route: "/leases", kind: "do", task: "Open any lease", title: "Open a lease", body: "Click a tenant name in the lease table to open its page.", waitFor: { type: "route", route: "/leases/*" } },
    { route: "@current", title: "Important dates", body: "Each date shows how it was worked out, the exact clause and page, and its status: calculated, needs review, conflicting or confirmed. Check the clause, then press Confirm after review." },
    { route: "@current", title: "Documents, terms and obligations", body: "Attach the agreement text under Documents: dates, terms and obligations are extracted with page references. Extracted terms stay Proposed until you confirm them; amendments keep the history." },
    { route: "@current", title: "Renewal, termination and handover", body: "Start a renewal review (a task is created), record a termination notice and the deposit, and work through the handover checklist — each item needs evidence." },
    { route: "/leases/calendar", title: "Calendar", body: "All lease milestones between two dates, filtered by lease, company, property and event. Tick Include unverified to see dates still awaiting review — they keep their label." },
    { route: "/leases/renewals", title: "Renewals", body: "Leases expiring within 12 months without a renewal record, then every renewal by stage: discussion, proposals, negotiation, agreed, completed and at risk." },
    { route: "/leases/obligations", title: "Obligations", body: "Every lease's obligations in one tracker — filter by status and by party (tenant, landlord, shared, unclear). Summaries with page references, not legal advice." },
    { route: "/leases/portfolio", title: "Portfolio", body: "Totals from known, compatible values only, with how many leases were included and excluded — and a list of leases with incomplete information." },
  ],
};
