/**
 * Workflows — pure rules (no DB, no AI). Window detection, signal strength, lead band, settings, rent arithmetic.
 * Arithmetic is decimal.js (S5); unknown inputs return null (S6).
 */
import Decimal from "decimal.js";
import { edate } from "@/lib/util/time";

export type StepStatus = "queued" | "running" | "done" | "skipped" | "failed" | "waiting_approval";
export type RunStatus = "running" | "done" | "skipped" | "failed" | "waiting_approval";
export type WorkflowKind = "signal_chain" | "lease_chain" | "reply_chain" | "employer_chain" | "feedback_chain" | "meeting_chain";

export const SETTING_KEYS = ["signal_chain", "lease_chain", "reply_chain", "employer_chain", "feedback_chain", "meeting_chain"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type WorkflowSettings = Record<SettingKey, boolean>;
export const DEFAULT_SETTINGS: WorkflowSettings = Object.fromEntries(SETTING_KEYS.map((k) => [k, true])) as WorkflowSettings;
/** Every automation defaults ON; only an explicit `false` turns one off. */
export function parseSettings(v: unknown): WorkflowSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, o[k] !== false])) as WorkflowSettings;
}
export const isSettingKey = (k: string): k is SettingKey => (SETTING_KEYS as readonly string[]).includes(k);

/** Contact-discovery cooldown, outreach quiet period, decision-maker threshold. */
export const DISCOVERY_COOLDOWN_DAYS = 14;
export const OUTREACH_QUIET_DAYS = 30;
export const MIN_DECISION_MAKERS = 2;
/** Role classes from contacts/rules.ts that count as decision-makers. */
export const DECISION_ROLES = ["decision_maker", "economic_buyer"];
/** contact_method.verify_status values outreach treats as usable (same list as outreach buildContext). */
export const USABLE_CHANNEL = ["verified", "likely_valid", "published_business", "business_mobile", "user_provided"];
/** Lead-model band labels the scoring module itself treats as high (scoring dashboard HIGH set). */
export const HIGH_LEAD_BANDS = ["Very High", "High"];

/**
 * A signal is "strong" for outreach when the signals engine rated its evidence medium/high, or it is a recorded fact.
 * ai_inference / hypothesis signals with low/insufficient evidence still get company/contacts/scores, but no draft.
 */
export function signalStrength(s: { verification?: string | null; confidence?: string | null }): { strong: boolean; reason: string } {
  if (s.verification === "fact") return { strong: true, reason: "Signal is a recorded fact." };
  if (s.confidence === "high" || s.confidence === "medium") return { strong: true, reason: `Signal evidence is ${s.confidence} (signals engine).` };
  return { strong: false, reason: `Signal is ${s.verification ?? "unverified"} with ${s.confidence ?? "unknown"} evidence — signals rules need medium/high evidence before outreach.` };
}

export function isHighLead(band: string | null | undefined): boolean {
  return !!band && HIGH_LEAD_BANDS.includes(band);
}

export interface LeaseIn { id: string; contractual_expiry: string | null }
export interface LeaseEventIn { lease_id: string; event_type: string; event_date: string | null }
export interface LeaseWindow { key: string; kind: "expiry_12m" | "lockin_6m" | "notice_6m"; date: string; label: string }

/**
 * The lease window that triggers the renewal chain (earliest wins): lock-in end or notice deadline within 6 months,
 * else contractual expiry within 12 months. Past dates never trigger. Returns null when no window applies.
 */
export function leaseWindow(lease: LeaseIn, events: LeaseEventIn[], today: string): LeaseWindow | null {
  const six = edate(today, 6); const twelve = edate(today, 12);
  const c: LeaseWindow[] = [];
  for (const e of events) {
    if (e.lease_id !== lease.id || !e.event_date || e.event_date < today || e.event_date > six) continue;
    if (e.event_type === "lockin_end") c.push({ key: `lockin_6m:${e.event_date}`, kind: "lockin_6m", date: e.event_date, label: `Lock-in ends ${e.event_date}` });
    if (e.event_type === "notice_deadline") c.push({ key: `notice_6m:${e.event_date}`, kind: "notice_6m", date: e.event_date, label: `Notice deadline ${e.event_date}` });
  }
  if (lease.contractual_expiry && lease.contractual_expiry >= today && lease.contractual_expiry <= twelve)
    c.push({ key: `expiry_12m:${lease.contractual_expiry}`, kind: "expiry_12m", date: lease.contractual_expiry, label: `Lease expires ${lease.contractual_expiry}` });
  c.sort((a, b) => a.date.localeCompare(b.date));
  return c[0] ?? null;
}

type Num = number | string | null | undefined;
const known = (x: Num) => x !== null && x !== undefined && String(x).trim() !== "" && Number.isFinite(Number(x));
/** Monthly rent = rate per sq ft per month × area. Unknown either side → null (never 0). */
export function monthlyRent(ratePerSf: Num, areaSf: Num): string | null {
  if (!known(ratePerSf) || !known(areaSf)) return null;
  return new Decimal(String(ratePerSf)).times(String(areaSf)).toFixed(2);
}

export const signalDedupeKey = (signalId: string, strong: boolean) => `signal:${signalId}:${strong ? "strong" : "weak"}`;
export const leaseDedupeKey = (leaseId: string, w: LeaseWindow) => `lease:${leaseId}:${w.key}`;
export const requirementTitle = (company: string) => `Renewal or relocation — ${company}`;

// ------------------------------------------------------------------ round 2 chains

/** Reply outcomes (outreach recordResponse) that start the reply → meeting chain. */
export const MEETING_OUTCOMES = ["meeting_scheduled", "interested"];
export function replyWantsMeeting(item: { status?: string | null; response?: { outcome?: string } | null }): boolean {
  return item.status === "meeting" || MEETING_OUTCOMES.includes(String(item.response?.outcome ?? ""));
}

/** Outreach relationship levels (outreach/rules.ts Level) that count as a prior relationship worth re-engaging. */
export const PRIOR_LEVELS = ["spoke_on_call", "met_once", "met_few", "good"];
export function priorRelationship(level: string | null | undefined, warmEdges: number): { prior: boolean; reason: string } {
  if (level === "not_interested") return { prior: false, reason: "They said they're not interested — no re-engagement." };
  if (level && PRIOR_LEVELS.includes(level)) return { prior: true, reason: `Relationship level: ${level.replace(/_/g, " ")}.` };
  if (warmEdges > 0) return { prior: true, reason: `${warmEdges} relationship link(s) on record.` };
  return { prior: false, reason: "No prior relationship on record (no meaningful interactions, no relationship links) — a cold note to a new employer is not a re-engagement." };
}

/**
 * Site-visit feedback → shortlist option status. Only an explicit rejection (user ticked "client clearly said no")
 * rejects; negative comments such as "rent is high" stay feedback and the option becomes `visited`.
 * Options already rejected/selected are never downgraded.
 */
export function optionStatusFromFeedback(f: { interest?: string | null; explicit_rejection?: boolean | null }, current: string): { status: string | null; rejected: boolean } {
  if (f.interest === "rejected" && f.explicit_rejection === true) return { status: current === "rejected" ? null : "rejected", rejected: true };
  if (current === "rejected" || current === "selected" || current === "visited") return { status: null, rejected: false };
  return { status: "visited", rejected: false };
}
/** Overall 1–5 → 0–1 custom factor score for the property comparison (unknown stays undefined, never 0). */
export function feedbackScore(overall: unknown): number | undefined {
  const n = Number(overall);
  if (overall === null || overall === undefined || overall === "" || !Number.isInteger(n) || n < 1 || n > 5) return undefined;
  return new Decimal(n - 1).div(4).toNumber();
}
export const FEEDBACK_FACTOR = "client_feedback";
export function feedbackNote(f: Record<string, unknown>): string {
  const parts = ["location", "commute", "layout", "quality", "parking", "pricing", "stakeholders", "notes"].map((k) => f[k]).filter((v) => typeof v === "string" && v.trim()) as string[];
  return parts.join(" · ").slice(0, 400);
}

export const replyDedupeKey = (itemId: string) => `reply:${itemId}`;
export const employerDedupeKey = (employmentId: string) => `employer:${employmentId}`;
export const feedbackDedupeKey = (feedbackId: string, rowVersion: number | string) => `feedback:${feedbackId}:v${rowVersion}`;
export const meetingDedupeKey = (prepId: string) => `meeting:${prepId}`;
