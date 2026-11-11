/* eslint-disable @typescript-eslint/no-explicit-any */
import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { localDate } from "@/lib/util/time";
import { deliverMorningBrief, nextBriefRun } from "./morning";

/**
 * assistant.morning_brief — one user's brief for one local day. Re-checks opt-in, dedupes per user per day
 * (job dedupe key + unique row), never sends anything outside CRE OS.
 * The lead registers `handlers` and `schedule` in src/modules/assistant/jobs.ts (or the registry).
 */
export const MORNING_BRIEF_JOB = "assistant.morning_brief";
export const briefDedupeKey = (userId: string, date: string) => `${MORNING_BRIEF_JOB}:${userId}:${date}`;

export type EnqueueFn = (o: { workspaceId: string; type: string; payload: Record<string, unknown>; dedupeKey: string; dueAt: Date; maxAttempts?: number }) => Promise<unknown>;

export const handlers: Record<string, JobHandler> = {
  [MORNING_BRIEF_JOB]: async (job) => {
    if (!job.workspace_id) throw new Error("workspace required");
    const admin = createAdminClient() as any;
    const userId = String(job.payload.userId ?? "");
    const { data: s } = await admin.from("assistant_brief_setting").select("enabled, timezone, top_n").eq("workspace_id", job.workspace_id).eq("owner_user_id", userId).is("archived_at", null).maybeSingle();
    if (!s?.enabled) return { skipped: "not opted in" };
    const { data: m } = await admin.from("membership").select("user_id").eq("workspace_id", job.workspace_id).eq("user_id", userId).maybeSingle();
    if (!m) return { skipped: "no longer a member" };
    return deliverMorningBrief({ db: admin, workspaceId: job.workspace_id, userId, timezone: s.timezone }, new Date(), { topN: s.top_n });
  },
};

/** Enqueue due briefs (service role: every query filters workspace_id) and advance next_run_at. */
export async function scheduleMorningBriefs(admin: any, now: Date, enq: EnqueueFn, onlyWorkspace?: string): Promise<string[]> {
  let q = admin.from("assistant_brief_setting").select("id, workspace_id, owner_user_id, time_local, timezone, next_run_at")
    .eq("enabled", true).is("archived_at", null).not("next_run_at", "is", null).lte("next_run_at", now.toISOString()).limit(500);
  if (onlyWorkspace) q = q.eq("workspace_id", onlyWorkspace);
  const { data, error } = await q;
  if (error) throw error;
  const keys: string[] = [];
  for (const s of (data ?? []) as any[]) {
    const date = localDate(new Date(s.next_run_at), s.timezone);
    const key = briefDedupeKey(s.owner_user_id, date);
    await enq({ workspaceId: s.workspace_id, type: MORNING_BRIEF_JOB, payload: { userId: s.owner_user_id, date }, dedupeKey: key, dueAt: now, maxAttempts: 2 });
    await admin.from("assistant_brief_setting").update({ next_run_at: nextBriefRun(s.time_local, now, s.timezone)?.toISOString() ?? null })
      .eq("workspace_id", s.workspace_id).eq("id", s.id);
    keys.push(key);
  }
  return keys;
}

export async function schedule(now: Date): Promise<void> {
  await scheduleMorningBriefs(createAdminClient(), now, (o) => enqueue(o));
}
