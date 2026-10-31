import "server-only";
/**
 * Health watchdog (spec Part I §7, Part III "Health watchdog 07:55 and 08:05"): a separate deterministic fallback that does
 * not depend on the AI task completing. 07:55: check sources; if no brief exists yet, build the deterministic brief now
 * (no AI). 08:05: if the brief is still not delivered, deliver the fallback and privately alert the user + workspace owners.
 * Every run is recorded in brief_health_run (one row per user/date/check) for the 99%-by-08:05 objective.
 */
import type { Db } from "@/lib/supabase/server";
import { deliverBrief, deliveredBrief, generateDailyBrief, latestBrief, noAiCaller } from "./brief-service";
import { notify } from "./db";
import { loadSources, type LoadCtx } from "./data";
import type { BriefSettings } from "./settings";

async function record(admin: Db, c: LoadCtx, date: string, kind: "pre_brief" | "post_brief", row: { sources: unknown; brief_present: boolean; brief_delivered: boolean; action_taken: string }) {
  const { error } = await admin.from("brief_health_run").upsert({
    workspace_id: c.workspaceId, user_id: c.userId, owner_user_id: c.userId, run_date: date, check_kind: kind, ran_at: new Date().toISOString(), ...row,
  }, { onConflict: "workspace_id,user_id,run_date,check_kind" });
  if (error) throw error;
}

export async function preBriefCheck(admin: Db, c: LoadCtx, settings: BriefSettings, date: string, now = new Date()) {
  const sources = await loadSources(c, settings, now);
  let brief = await latestBrief(admin, c.workspaceId, c.userId, date, "daily");
  let action = "none";
  if (!brief) {
    brief = (await generateDailyBrief(c, settings, { date, now, caller: noAiCaller, generatedBy: "watchdog_0755" })).brief;
    action = "fallback_generated";
  }
  await record(admin, c, date, "pre_brief", { sources, brief_present: true, brief_delivered: !!brief.delivered_at, action_taken: action });
  return { action, briefId: brief.id, failedSources: sources.filter((s) => s.state === "failed" || s.state === "stale").map((s) => s.key) };
}

export async function postBriefCheck(admin: Db, c: LoadCtx, settings: BriefSettings, date: string, now = new Date()) {
  const sources = await loadSources(c, settings, now);
  const delivered = await deliveredBrief(admin, c.workspaceId, c.userId, date);
  if (delivered) {
    await record(admin, c, date, "post_brief", { sources, brief_present: true, brief_delivered: true, action_taken: "none" });
    return { action: "none", briefId: delivered.id };
  }
  let brief = await latestBrief(admin, c.workspaceId, c.userId, date, "daily");
  const wasMissing = !brief;
  if (!brief) brief = (await generateDailyBrief(c, settings, { date, now, caller: noAiCaller, generatedBy: "watchdog_0805" })).brief;
  await deliverBrief(admin, c.workspaceId, brief, now);
  // private alerts: the user, plus workspace owners (never an external message)
  const { data: owners } = await admin.from("membership").select("user_id").eq("workspace_id", c.workspaceId).eq("role", "owner");
  const recipients = [...new Set([c.userId, ...(owners ?? []).map((o: { user_id: string }) => o.user_id)])];
  for (const r of recipients) {
    await notify(admin, c.workspaceId, r, "brief_alert", `brief_alert:${c.userId}:${date}:${r}`, {
      user_id: c.userId, date, reason: wasMissing ? "brief missing at 08:05 — deterministic fallback delivered" : "brief not delivered by 08:05 — delivered late by watchdog",
      brief_id: brief.id, href: "/today",
    });
  }
  await record(admin, c, date, "post_brief", { sources, brief_present: !wasMissing, brief_delivered: false, action_taken: "owner_alerted" });
  return { action: "owner_alerted", briefId: brief.id, wasMissing };
}
