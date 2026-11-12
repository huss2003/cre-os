/** Lease lifecycle statuses (SPEC §2.3) and evidence-gated transitions. PURE. */
export const LEASE_STATUSES = [
  "draft", "under_negotiation", "awaiting_approval", "awaiting_execution", "executed", "active", "renewal_under_discussion",
  "renewal_agreed", "termination_notice_served", "expiring", "expired", "terminated", "surrendered", "closed",
] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];
export const STATUS_LABEL: Record<LeaseStatus, string> = {
  draft: "Draft", under_negotiation: "Under negotiation", awaiting_approval: "Awaiting approval", awaiting_execution: "Awaiting execution",
  executed: "Executed", active: "Active", renewal_under_discussion: "Renewal under discussion", renewal_agreed: "Renewal agreed",
  termination_notice_served: "Termination notice served", expiring: "Expiring", expired: "Expired", terminated: "Terminated", surrendered: "Surrendered", closed: "Closed",
};
export const isLeaseStatus = (s: unknown): s is LeaseStatus => typeof s === "string" && (LEASE_STATUSES as readonly string[]).includes(s);

export const LEASE_CATEGORIES = ["conventional_office", "managed_office", "coworking", "commercial_office", "retail", "industrial_warehouse", "other"] as const;
export type LeaseCategory = (typeof LEASE_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<LeaseCategory, string> = {
  conventional_office: "Conventional office lease", managed_office: "Managed office agreement", coworking: "Coworking agreement",
  commercial_office: "Commercial office agreement", retail: "Retail commercial lease", industrial_warehouse: "Industrial / warehouse lease", other: "Other",
};
/** Category-specific tracking: which date types matter (managed/coworking rarely have escalation by clause or handover restoration). */
export const CATEGORY_TRACKS: Record<LeaseCategory, string[]> = {
  conventional_office: ["lockin_end", "escalation", "renewal_notice_deadline", "termination_notice_deadline", "expiry", "handover", "rent_free_end"],
  managed_office: ["lockin_end", "termination_notice_deadline", "expiry", "escalation"],
  coworking: ["termination_notice_deadline", "expiry"],
  commercial_office: ["lockin_end", "escalation", "renewal_notice_deadline", "termination_notice_deadline", "expiry", "handover"],
  retail: ["lockin_end", "escalation", "renewal_notice_deadline", "termination_notice_deadline", "expiry", "handover", "rent_free_end"],
  industrial_warehouse: ["lockin_end", "escalation", "renewal_notice_deadline", "termination_notice_deadline", "expiry", "handover"],
  other: ["expiry", "termination_notice_deadline"],
};

const NEXT: Record<LeaseStatus, LeaseStatus[]> = {
  draft: ["under_negotiation", "awaiting_approval", "awaiting_execution", "closed"],
  under_negotiation: ["awaiting_approval", "awaiting_execution", "draft", "closed"],
  awaiting_approval: ["awaiting_execution", "under_negotiation", "closed"],
  awaiting_execution: ["executed", "under_negotiation", "closed"],
  executed: ["active", "termination_notice_served", "terminated", "surrendered"],
  active: ["renewal_under_discussion", "termination_notice_served", "expiring", "terminated", "surrendered"],
  renewal_under_discussion: ["renewal_agreed", "active", "expiring", "termination_notice_served", "expired"],
  renewal_agreed: ["active", "expired", "closed"],
  termination_notice_served: ["terminated", "active", "expired"],
  expiring: ["renewal_under_discussion", "termination_notice_served", "expired", "renewal_agreed"],
  expired: ["closed", "renewal_agreed"],
  terminated: ["closed"],
  surrendered: ["closed"],
  closed: [],
};
export const nextStatuses = (s: LeaseStatus) => NEXT[s];

export interface TransitionEvidence {
  executedDocument?: { id: string; execution_state: string } | null;
  executionDate?: string | null;
  confirmedCommencementOrPossession?: string | null;  // a lease_date confirmed by a human
  confirmedExpiry?: string | null;
  noticeDate?: string | null;
  noticeDocumentId?: string | null;
  agreedRenewalId?: string | null;
  confirmedTerminationDate?: string | null;
  note?: string | null;
  handoverComplete?: boolean;
  today: string;
}

/** Evidence gate. Executed/active are NEVER automatic: the caller (a human action) must supply the evidence. */
export function checkTransition(from: LeaseStatus, to: LeaseStatus, e: TransitionEvidence): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (from === to) errors.push("Status is unchanged.");
  else if (!NEXT[from].includes(to)) errors.push(`Cannot move from "${STATUS_LABEL[from]}" to "${STATUS_LABEL[to]}".`);
  switch (to) {
    case "executed":
      if (!e.executedDocument || !["executed", "signed"].includes(e.executedDocument.execution_state)) errors.push("Attach a signed/executed agreement — drafts and unsigned proposals are never treated as executed.");
      if (!e.executionDate) errors.push("Execution date is required.");
      break;
    case "active":
      if (!e.confirmedCommencementOrPossession) errors.push("A human-confirmed commencement or possession date is required before a lease is active.");
      else if (e.confirmedCommencementOrPossession > e.today) errors.push(`Commencement/possession (${e.confirmedCommencementOrPossession}) is in the future.`);
      break;
    case "termination_notice_served":
      if (!e.noticeDate) errors.push("Notice date is required.");
      if (!e.noticeDocumentId && !e.note) errors.push("Attach the termination notice or record how it was served.");
      break;
    case "renewal_agreed":
      if (!e.agreedRenewalId) errors.push("Record the renewal as agreed in the renewal pipeline first.");
      break;
    case "terminated":
      if (!e.confirmedTerminationDate) errors.push("A confirmed termination date is required.");
      break;
    case "expired":
      if (!e.confirmedExpiry) errors.push("Expiry date must be confirmed by a human first.");
      else if (e.confirmedExpiry >= e.today) errors.push(`Lease expiry (${e.confirmedExpiry}) has not passed.`);
      break;
    case "surrendered":
      if (!e.note && !e.noticeDocumentId) errors.push("Record the surrender evidence (document or note).");
      break;
    case "closed":
      if (!e.note && !e.handoverComplete) errors.push("Complete the handover checklist or record why the lease is closed.");
      break;
  }
  return { ok: errors.length === 0, errors };
}
