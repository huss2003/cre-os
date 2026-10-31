/**
 * Brief-module settings. Defaults follow spec Part I §7 and Part III "Scheduled job specification".
 * Workspace-level overrides: workspace_setting key "brief" (admin-editable).
 * Per-user overrides: user_preference.prefs (top-level keys listed in UserPrefs).
 * Pure module (no DB) so it can be unit-tested and imported by pages.
 */

export interface DndWindow { start: string; end: string } // "HH:mm" local, may wrap midnight

export type UrgentCategory = "near_term_visit" | "commercial_decision" | "expiring_offer" | "critical_deadline";

export interface CapacitySettings {
  workdayStart: string;          // "09:30"
  workdayEnd: string;            // "19:00"
  dailyCallMinutes: number;      // call/approach budget on a free day
  callMinutesPerTarget: number;  // effort for a target with a contact path
  researchMinutesPerTarget: number; // effort when contact path must be researched first
  maxDailyTargets: number;
  explorationShare: number;      // 0.10-0.20 (spec §9)
  travelBufferMinutes: number;   // per external meeting/site visit
  adminReserveMinutes: number;   // approvals/capture time kept free
  approvalsFullThreshold: number;
}

export interface ReversePlanSettings {
  moveBufferDays: number;
  fitoutMonthsBySize: { maxSf: number | null; months: number }[]; // ascending; null = above all
  procurementMonths: number;     // LOI, documentation, approvals
  decisionMonths: number;        // options, visits, comparison, negotiation
  engagementLeadMonths: number;  // start calls this long before options work must begin
}

export interface BriefSettings {
  briefTime: string;             // "08:00" local
  debriefTime: string;           // "20:30"
  weeklyReview: { weekday: number; time: string }; // ISO weekday 1=Mon..7=Sun; Friday=5
  workdays: number[];            // ISO weekdays
  weekendBrief: boolean;         // still prepare a light brief on non-workdays
  dnd: DndWindow;
  urgentCategories: UrgentCategory[]; // opt-in; empty = everything waits for the 08:00 brief
  preMeetingLeadMinutes: number;
  cohortTarget: { minimum: number; pace: number }; // new-company approaches per month (spec §13: 120 / 170)
  staleTaskAfterDays: number;
  sourceStaleHours: { inbox: number; calendar: number; sent: number };
  fitBand: { minSf: number | null; maxSf: number | null }; // "plausible fit" band for lease area
  capacity: CapacitySettings;
  reversePlan: ReversePlanSettings;
}

export const BRIEF_DEFAULTS: BriefSettings = {
  briefTime: "08:00",
  debriefTime: "20:30",
  weeklyReview: { weekday: 5, time: "18:00" },
  workdays: [1, 2, 3, 4, 5],
  weekendBrief: true,
  dnd: { start: "22:00", end: "07:00" },
  urgentCategories: [],
  preMeetingLeadMinutes: 60,
  cohortTarget: { minimum: 120, pace: 170 },
  staleTaskAfterDays: 14,
  sourceStaleHours: { inbox: 3, calendar: 12, sent: 24 },
  fitBand: { minSf: 5000, maxSf: null },
  capacity: {
    workdayStart: "09:30",
    workdayEnd: "19:00",
    dailyCallMinutes: 150,
    callMinutesPerTarget: 15,
    researchMinutesPerTarget: 30,
    maxDailyTargets: 12,
    explorationShare: 0.15,
    travelBufferMinutes: 30,
    adminReserveMinutes: 60,
    approvalsFullThreshold: 15,
  },
  reversePlan: {
    moveBufferDays: 14,
    fitoutMonthsBySize: [
      { maxSf: 10000, months: 2 },
      { maxSf: 25000, months: 3 },
      { maxSf: 60000, months: 4 },
      { maxSf: null, months: 6 },
    ],
    procurementMonths: 2,
    decisionMonths: 2,
    engagementLeadMonths: 3,
  },
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep-merge known keys only; invalid values are ignored (defaults win). */
function merge<T>(base: T, over: unknown): T {
  if (!isObj(over) || !isObj(base)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, bv] of Object.entries(base as Record<string, unknown>)) {
    const ov = (over as Record<string, unknown>)[k];
    if (ov === undefined || ov === null) continue;
    if (Array.isArray(bv)) {
      if (Array.isArray(ov)) out[k] = ov;
    } else if (isObj(bv)) {
      out[k] = merge(bv, ov);
    } else if (typeof bv === "string") {
      if (typeof ov === "string" && (!HHMM.test(bv) || HHMM.test(ov))) out[k] = ov;
    } else if (typeof bv === "number") {
      if (typeof ov === "number" && Number.isFinite(ov)) out[k] = ov;
    } else if (typeof bv === "boolean") {
      if (typeof ov === "boolean") out[k] = ov;
    } else if (bv === null) {
      if (typeof ov === "number") out[k] = ov;
    }
  }
  return out as T;
}

/**
 * Map the admin module's Settings keys (src/modules/admin/settings.ts: brief_time, cohort_targets, size_rules) onto
 * BriefSettings so the tenant Settings page drives the brief. The "brief" key (full BriefSettings shape) wins over these.
 */
export function fromAdminKeys(map: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!map) return out;
  const bt = map.brief_time;
  if (isObj(bt)) {
    if (typeof bt.time === "string") out.briefTime = bt.time;
    if (typeof bt.debrief_time === "string") out.debriefTime = bt.debrief_time;
  }
  const ct = map.cohort_targets;
  if (isObj(ct)) {
    out.cohortTarget = {
      ...(typeof ct.approaches_per_month_min === "number" ? { minimum: ct.approaches_per_month_min } : {}),
      ...(typeof ct.approaches_per_month_pace === "number" ? { pace: ct.approaches_per_month_pace } : {}),
    };
  }
  const sr = map.size_rules;
  if (isObj(sr)) {
    out.fitBand = {
      ...(typeof sr.min_sf === "number" ? { minSf: sr.min_sf } : {}),
      ...(typeof sr.max_sf === "number" ? { maxSf: sr.max_sf } : {}),
    };
  }
  return out;
}

/** Accept the integrations module's snake_case alert prefs (urgent_categories) as aliases. */
function normaliseUserPrefs(p: Record<string, unknown>): Record<string, unknown> {
  const out = { ...p };
  if (!("urgentCategories" in out) && Array.isArray(p.urgent_categories)) out.urgentCategories = p.urgent_categories;
  return out;
}

/**
 * Workspace settings (admin keys, then the "brief" key) then user prefs (user wins for personal keys).
 */
export function resolveSettings(workspaceSetting: unknown, userPrefs: unknown, adminKeys?: Record<string, unknown> | null): BriefSettings {
  let s = merge(BRIEF_DEFAULTS, fromAdminKeys(adminKeys));
  s = merge(s, workspaceSetting);
  if (isObj(userPrefs)) {
    const prefs = normaliseUserPrefs(userPrefs);
    const personal: Record<string, unknown> = {};
    for (const k of ["briefTime", "debriefTime", "weeklyReview", "workdays", "weekendBrief", "dnd", "urgentCategories", "preMeetingLeadMinutes", "capacity"]) {
      if (k in prefs) personal[k] = prefs[k];
    }
    s = merge(s, personal);
  }
  s.capacity.explorationShare = Math.min(0.2, Math.max(0.1, s.capacity.explorationShare));
  return s;
}

/** "HH:mm" + minutes offset -> "HH:mm" plus day offset (for slots that cross midnight). */
export function shiftHHMM(hhmm: string, deltaMinutes: number): { hhmm: string; dayOffset: number } {
  const [h, m] = hhmm.split(":").map(Number);
  let total = h * 60 + m + deltaMinutes;
  let dayOffset = 0;
  while (total < 0) { total += 1440; dayOffset -= 1; }
  while (total >= 1440) { total -= 1440; dayOffset += 1; }
  return { hhmm: `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`, dayOffset };
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
