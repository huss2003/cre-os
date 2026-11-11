/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { rebuildStyleProfile } from "./style";

/**
 * assistant.style_refresh — rebuild one user's writing-style profile (payload {userId}). Service role (S2): every query
 * filters workspace_id + owner explicitly; a profile that was turned off is never rebuilt.
 * Lead: merge `outputHandlers` into assistant/jobs.ts handlers and call `scheduleOutputs(now)` from schedule().
 */
export const outputHandlers: Record<string, JobHandler> = {
  "assistant.style_refresh": async (job) => {
    if (!job.workspace_id) throw new Error("workspace required");
    const userId = String(job.payload.userId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return { skipped: "bad user" };
    const admin = createAdminClient();
    const { data: m } = await (admin as any).from("membership").select("user_id").eq("workspace_id", job.workspace_id).eq("user_id", userId).maybeSingle();
    if (!m) return { skipped: "not a member" };
    return rebuildStyleProfile(admin, job.workspace_id, userId);
  },
};

/** Weekly refresh of every enabled profile (dedupe key per ISO week). */
export async function scheduleOutputs(now: Date): Promise<void> {
  const admin = createAdminClient() as any;
  const { data } = await admin.from("assistant_style_profile").select("workspace_id, owner_user_id, built_at").eq("enabled", true).is("archived_at", null).limit(500);
  const week = Math.floor(now.getTime() / (7 * 86_400_000));
  for (const p of (data ?? []) as any[]) {
    if (p.built_at && now.getTime() - Date.parse(p.built_at) < 6 * 86_400_000) continue;
    await enqueue({ workspaceId: p.workspace_id, type: "assistant.style_refresh", payload: { userId: p.owner_user_id }, dedupeKey: `style:${p.owner_user_id}:${week}` });
  }
}
