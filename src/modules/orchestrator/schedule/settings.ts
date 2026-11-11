/**
 * Orchestrator scheduling + notification preferences (pure). Built ON the brief module's settings so there is one
 * source of truth for brief time, weekly review slot, workdays, DND and working hours:
 *   brief defaults → workspace_setting "brief" → user_preference.prefs (brief keys)
 * plus orchestrator-only keys:
 *   workspace_setting "orchestrator" → user_preference.prefs.orchestrator
 *   { timezone, dailyPlanTime, weeklyReview:{weekday,time}, prepLeadMinutes, quietHours:{start,end},
 *     notifications:{ muted:[category], urgentCategories:[category], groupWindowMinutes }, capacity:{ maxMeetings, ... } }
 */
import { resolveSettings, type BriefSettings } from "@/modules/brief/settings";

export interface CapacityLimits {
  maxMeetings: number;            // "too many meetings on one day"
  maxOverdueCommitments: number;  // "several overdue client commitments"
  maxUrgentProposals: number;     // "multiple urgent proposals"
  prepMinutes: number;            // preparation needed before an external meeting / site visit
  defaultTaskMinutes: number;
}

export interface NotificationPrefs {
  muted: string[];                // categories the user does not want in-app (urgent still shown)
  urgentCategories: string[];     // categories that bypass quiet hours
  groupWindowMinutes: number;     // fold same-group notifications within this window
}

export interface OrchSettings {
  timezone: string;
  dailyPlanTime: string;          // "08:00"
  weeklyReview: { weekday: number; time: string };
  workdays: number[];
  prepLeadMinutes: number;
  workingHours: { start: string; end: string };
  quietHours: { start: string; end: string };
  notifications: NotificationPrefs;
  capacity: CapacityLimits;
  brief: BriefSettings;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const hhmm = (v: unknown, d: string) => (typeof v === "string" && HHMM.test(v) ? v : d);
const num = (v: unknown, d: number, min = 0, max = 10_000) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : d);
const strs = (v: unknown, d: string[]) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : d);

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

export const DEFAULT_URGENT = ["meeting_prep", "failed_job", "budget", "commercial_change"];

export function resolveOrchSettings(opts: {
  workspaceTz?: string | null; briefSetting?: unknown; adminKeys?: Record<string, unknown> | null;
  orchSetting?: unknown; userPrefs?: unknown;
}): OrchSettings {
  const prefs = isObj(opts.userPrefs) ? opts.userPrefs : {};
  const brief = resolveSettings(opts.briefSetting ?? null, prefs, opts.adminKeys ?? null);
  const ws = isObj(opts.orchSetting) ? opts.orchSetting : {};
  const u = isObj(prefs.orchestrator) ? prefs.orchestrator : {};
  const pick = (k: string) => (u[k] !== undefined ? u[k] : ws[k]);
  const tzCand = [u.timezone, prefs.timezone, ws.timezone, opts.workspaceTz].find(isValidTimeZone);
  const wr = isObj(pick("weeklyReview")) ? pick("weeklyReview") : {};
  const qh = isObj(pick("quietHours")) ? pick("quietHours") : {};
  const wh = isObj(pick("workingHours")) ? pick("workingHours") : {};
  const np = { ...(isObj(ws.notifications) ? ws.notifications : {}), ...(isObj(u.notifications) ? u.notifications : {}) };
  const cp = { ...(isObj(ws.capacity) ? ws.capacity : {}), ...(isObj(u.capacity) ? u.capacity : {}) };
  return {
    timezone: (tzCand as string | undefined) ?? "Asia/Kolkata",
    dailyPlanTime: hhmm(pick("dailyPlanTime"), brief.briefTime), // default 08:00 = the brief module's delivery time
    weeklyReview: { weekday: num(wr.weekday, brief.weeklyReview.weekday, 1, 7), time: hhmm(wr.time, brief.weeklyReview.time) },
    workdays: brief.workdays,
    prepLeadMinutes: num(pick("prepLeadMinutes"), brief.preMeetingLeadMinutes, 15, 240),
    workingHours: { start: hhmm(wh.start, brief.capacity.workdayStart), end: hhmm(wh.end, brief.capacity.workdayEnd) },
    quietHours: { start: hhmm(qh.start, brief.dnd.start), end: hhmm(qh.end, brief.dnd.end) },
    notifications: {
      muted: strs(np.muted, []),
      urgentCategories: strs(np.urgentCategories, DEFAULT_URGENT),
      groupWindowMinutes: num(np.groupWindowMinutes, 120, 0, 24 * 60),
    },
    capacity: {
      maxMeetings: num(cp.maxMeetings, 5, 1, 30),
      maxOverdueCommitments: num(cp.maxOverdueCommitments, 3, 1, 100),
      maxUrgentProposals: num(cp.maxUrgentProposals, 2, 1, 50),
      prepMinutes: num(cp.prepMinutes, Math.max(30, brief.capacity.prepMinutes), 5, 240),
      defaultTaskMinutes: num(cp.defaultTaskMinutes, brief.capacity.defaultTaskMinutes, 5, 480),
    },
    brief,
  };
}
