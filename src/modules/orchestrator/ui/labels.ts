/**
 * Plain-word labels for the Automation UI (no workflow-engine jargon). Pure — safe in client and server code.
 */
type Tone = "neutral" | "ok" | "warn" | "bad" | "brand";

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Waiting to start", tone: "neutral" },
  running: { label: "Running", tone: "brand" },
  waiting_dependency: { label: "Waiting for an earlier step", tone: "neutral" },
  waiting_approval: { label: "Needs your approval", tone: "warn" },
  partially_completed: { label: "Partly done — will retry", tone: "warn" },
  completed: { label: "Done", tone: "ok" },
  done: { label: "Done", tone: "ok" },
  skipped: { label: "Nothing to do", tone: "neutral" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  paused: { label: "Paused", tone: "warn" },
};
export const STEP_STATUS: Record<string, { label: string; tone: Tone }> = {
  ...RUN_STATUS,
  dead: { label: "Failed — retries used up", tone: "bad" },
};
export const DEF_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "On", tone: "ok" }, paused: { label: "Paused", tone: "warn" }, draft: { label: "Not switched on", tone: "neutral" },
};
export const MARK: Record<string, { label: string; tone: Tone; hint: string }> = {
  needs_refresh: { label: "Needs refresh", tone: "warn", hint: "Something it depends on changed. Refresh to bring it up to date." },
  stale: { label: "May be out of date", tone: "warn", hint: "A data source it depends on could not be checked." },
  outdated_warning: { label: "Outdated", tone: "bad", hint: "It is approved or already shared, so it was not changed. Review it and create a new version if needed." },
  review: { label: "Needs review", tone: "warn", hint: "A change may affect this record. Check it." },
};
/** A needs-refresh mark whose record was already recalculated by the orchestrator only needs a review, not a Refresh. */
export function isRecalculated(m: { mark?: unknown; detail?: unknown }): boolean {
  const d = (m.detail ?? null) as Record<string, unknown> | null;
  return m.mark === "needs_refresh" && !!d && (d.recalculated === true || d.new_version != null);
}
export function markLabel(m: { mark?: unknown; detail?: unknown }): { label: string; tone: Tone; hint: string } {
  if (isRecalculated(m)) return { label: "Recalculated — review", tone: "warn", hint: "It was recalculated automatically with the new figures. Open it to check the new result, then dismiss this note." };
  return MARK[String(m.mark)] ?? { label: String(m.mark), tone: "warn", hint: "" };
}
export const TRIGGER_EVENT: Record<string, string> = {
  "meeting.scheduled": "a meeting is scheduled", "meeting.rescheduled": "a meeting is moved", "meeting.cancelled": "a meeting is cancelled",
  "meeting.completed": "a meeting is marked done", "commercial.quote_received": "a new rent quotation arrives",
  "commercial.requirement_changed": "a client requirement changes", "contact.employment_changed": "a contact changes employer",
  "research.signal_detected": "a new signal is found", "integration.failed": "a connected account stops working",
  "integration.recovered": "a connected account works again",
};

export function everyText(min: number | null | undefined): string {
  if (!min) return "";
  if (min % 10080 === 0) return min === 10080 ? "every week" : `every ${min / 10080} weeks`;
  if (min % 1440 === 0) return min === 1440 ? "every day" : `every ${min / 1440} days`;
  if (min % 60 === 0) return min === 60 ? "every hour" : `every ${min / 60} hours`;
  return `every ${min} minutes`;
}

/** "Runs when a new rent quotation arrives" / "Runs every day" / "Runs when you start it". */
export function triggerText(t: { type: string; events?: string[]; everyMinutes?: number }, everyMinutes?: number | null): string {
  if (t.type === "schedule") return `Runs ${everyText(everyMinutes ?? t.everyMinutes) || "on a schedule"}`;
  if (t.type === "event") return `Runs when ${(t.events ?? []).map((e) => TRIGGER_EVENT[e] ?? e.replace(/[._]/g, " ")).join(" or ") || "something changes"}`;
  if (t.type === "condition") return "Runs when a condition is met";
  return "Runs when you (or the assistant) start it";
}

const PRIORITY: [number, string][] = [[80, "High"], [40, "Normal"], [0, "Low"]];
export const priorityText = (p: number | null | undefined) => (PRIORITY.find(([n]) => (p ?? 50) >= n) ?? PRIORITY[2])[1];

/** In-app link for a record reference (types used by the orchestrator: DB table names). */
/** Toolkit page for one saved analysis, by its kind. */
export function analysisHref(kind: string, id: string): string {
  switch (kind) {
    case "property_comparison": return `/toolkit/compare/${id}`;
    case "renewal_vs_relocation": return `/toolkit/renewal/${id}`;
    case "conventional_vs_managed": return `/toolkit/managed/${id}`;
    case "fitout": return `/toolkit/fitout/${id}`;
    case "financing": return `/toolkit/financing/${id}`;
    case "negotiation": return `/toolkit/negotiation/${id}`;
    case "investment": return `/toolkit/investment/${id}`;
    case "bts": return `/toolkit/bts/${id}`;
    case "lease_economics": return `/toolkit/lease?id=${id}`;
    case "occupancy": return `/toolkit/occupancy?id=${id}`;
    case "deliverable": return `/toolkit/deliverables`;
    default: return "/toolkit";
  }
}

export function refHref(type: string, id: string, kind?: string | null): string | null {
  switch (type) {
    case "organisation": case "company": return `/companies/${id}`;
    case "person": return `/people/${id}`;
    case "asset": return `/buildings/${id}`;
    case "requirement": return `/requirements/${id}`;
    case "opportunity": return `/deals/${id}`;
    case "deal_analysis": case "analysis": return analysisHref(kind ?? "", id);
    case "meeting_prep": return `/meetings/${id}`;
    case "meeting_visit": case "meeting": return `/meetings?visit=${id}`;
    case "task": return "/tasks";
    case "signal_claim": case "signal": return `/signals/${id}`;
    case "quote": return `/toolkit/quotes/${id}`;
    case "change_proposal": return "/approvals";
    case "workflow_run": return `/automation/runs/${id}`;
    default: return null;
  }
}
export const REF_TYPE: Record<string, string> = {
  organisation: "Company", person: "Person", asset: "Building", requirement: "Requirement", opportunity: "Deal", deal_analysis: "Analysis",
  document_version: "Document", meeting_prep: "Meeting", meeting_visit: "Meeting", task: "Task", signal_claim: "Signal", quote: "Quote", user: "User",
};

/** Capacity warning kinds in plain words. */
export const CAPACITY_KIND: Record<string, string> = {
  too_many_meetings: "Too many meetings", reschedule: "Move something", overlap: "Meetings overlap", travel_conflict: "Travel time",
  decline_or_move_meeting: "Decline or move a meeting", overdue_commitments: "Overdue promises", urgent_proposals: "Urgent proposals",
  insufficient_prep: "Not enough prep time", prep_slot: "Prep time", over_capacity: "Day is overbooked",
};
export const capacityKindLabel = (k: string) => CAPACITY_KIND[k] ?? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
