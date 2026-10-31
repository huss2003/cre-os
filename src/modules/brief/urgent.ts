/**
 * Urgent after-hours alerts (spec Part I §7). Private notification to the user only — never a client response (S3).
 * Deduplicated by source key, respects the DND window, escalates only opted-in categories; everything else is
 * queued for the 08:00 brief.
 */
import { dndEnd, inDnd } from "./scheduler";
import type { BriefSettings, UrgentCategory } from "./settings";

export interface UrgentRequest {
  category: UrgentCategory | "research_news" | "other";
  sourceKey: string;            // e.g. inbox message id — repeated messages dedupe on this
  title: string;
  activeOpportunity: boolean;   // only active/high-value opportunities qualify
  verifiedSender: boolean;      // sender matched to a known stakeholder (not just a display name)
}

export type UrgentDecision =
  | { action: "notify_now"; dedupeKey: string }
  | { action: "defer_until"; at: Date; dedupeKey: string; reason: string }
  | { action: "queue_for_brief"; reason: string };

export function decideUrgentAlert(req: UrgentRequest, settings: Pick<BriefSettings, "dnd" | "urgentCategories">, now: Date, tz: string): UrgentDecision {
  const dedupeKey = `urgent:${req.sourceKey}`;
  if (req.category === "research_news" || req.category === "other") return { action: "queue_for_brief", reason: "Not an urgent category — included in the next brief" };
  if (!req.activeOpportunity) return { action: "queue_for_brief", reason: "Not linked to an active opportunity" };
  if (!req.verifiedSender) return { action: "queue_for_brief", reason: "Sender not verified against a known stakeholder" };
  if (!settings.urgentCategories.includes(req.category)) return { action: "queue_for_brief", reason: `Category "${req.category}" not opted in for after-hours alerts` };
  if (inDnd(now, settings.dnd, tz)) return { action: "defer_until", at: dndEnd(now, settings.dnd, tz), dedupeKey, reason: "Inside do-not-disturb window" };
  return { action: "notify_now", dedupeKey };
}
