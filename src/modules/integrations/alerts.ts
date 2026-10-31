import { formatInTimeZone } from "date-fns-tz";
import { atLocal } from "@/lib/util/time";

/**
 * Urgent after-hours alert policy (spec Part I §7): a verified inbound request for a near-term visit, commercial decision,
 * expiring offer or critical deadline on an active/high-value opportunity => PRIVATE notification to the owner only.
 * Never an automatic client response. Only opted-in categories; DND respected (deferred to DND end); backfill never alerts.
 * Decided here in deterministic code — the model only proposes a category.
 */
export const URGENT_CATEGORIES = ["near_term_visit", "commercial_decision", "expiring_offer", "critical_deadline"] as const;
export type UrgentCategory = (typeof URGENT_CATEGORIES)[number];

export interface AlertPrefs {
  urgent_categories?: string[];                       // opt-in list; default none
  dnd?: { start: string; end: string } | null;        // "HH:mm" local, may wrap midnight; default 22:00-07:00
  work_hours?: { start: string; end: string; days?: number[] } | null; // ISO weekday 1=Mon..7=Sun; default Mon-Sat 09:00-19:00
}

export const DEFAULT_DND = { start: "22:00", end: "07:00" };
export const DEFAULT_WORK_HOURS = { start: "09:00", end: "19:00", days: [1, 2, 3, 4, 5, 6] };

function minutes(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

function inWindow(nowMin: number, start: string, end: string) {
  const s = minutes(start), e = minutes(end);
  return s <= e ? nowMin >= s && nowMin < e : nowMin >= s || nowMin < e;
}

export interface AlertDecision {
  alert: boolean;
  deliverAfter: string | null;
  reason: string;
}

export function decideUrgentAlert(i: {
  category: string | null | undefined;
  isBackfill: boolean;
  verifiedSender: boolean;
  activeOpportunity: boolean;
  prefs: AlertPrefs | null | undefined;
  now: Date;
  tz: string;
}): AlertDecision {
  const no = (reason: string): AlertDecision => ({ alert: false, deliverAfter: null, reason });
  if (!i.category || !(URGENT_CATEGORIES as readonly string[]).includes(i.category)) return no("not_urgent_category");
  if (i.isBackfill) return no("backfill");
  if (!i.verifiedSender) return no("sender_not_verified");
  if (!i.activeOpportunity) return no("no_active_opportunity");
  const opted = i.prefs?.urgent_categories ?? [];
  if (!opted.includes(i.category)) return no("category_not_opted_in");
  const nowMin = minutes(formatInTimeZone(i.now, i.tz, "HH:mm"));
  const isoDay = Number(formatInTimeZone(i.now, i.tz, "i"));
  const wh = i.prefs?.work_hours ?? DEFAULT_WORK_HOURS;
  if ((wh.days ?? DEFAULT_WORK_HOURS.days).includes(isoDay) && inWindow(nowMin, wh.start, wh.end)) return no("within_work_hours");
  const dnd = i.prefs?.dnd === null ? null : i.prefs?.dnd ?? DEFAULT_DND;
  if (dnd && inWindow(nowMin, dnd.start, dnd.end)) {
    const today = formatInTimeZone(i.now, i.tz, "yyyy-MM-dd");
    let end = atLocal(today, dnd.end, i.tz);
    if (end.getTime() <= i.now.getTime()) end = new Date(end.getTime() + 86_400_000);
    return { alert: true, deliverAfter: end.toISOString(), reason: "dnd_deferred" };
  }
  return { alert: true, deliverAfter: null, reason: "after_hours" };
}

/** Outbox dedupe key: one alert per message across sync, webhook, backfill and manual import. */
export function urgentDedupeKey(internetMessageId: string | null, provider: string, providerMessageId: string) {
  return `integrations.urgent:${internetMessageId ?? `${provider}:${providerMessageId}`}`;
}
