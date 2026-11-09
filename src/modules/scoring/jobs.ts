import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { localDate, atLocal } from "@/lib/util/time";
import { recalcOrg, scoreEntity, recalcStale } from "./service";

/**
 * scoring.recalc  — event-triggered (DB trigger on signal/lease/lease_event/requirement/opportunity/employment),
 *                   deduplicated per company per minute. Rescores only that company's records.
 * scoring.bulk    — nightly 02:30 local: unscored or >7-day-old companies, 150 per run.
 */
export const handlers: Record<string, JobHandler> = {
  "scoring.recalc": async (job) => {
    if (!job.workspace_id) throw new Error("workspace required");
    const p = job.payload as { org_id?: string | null; entity_type?: string; entity_id?: string; trigger?: string };
    const db = createAdminClient();
    if (p.org_id) return { scored: (await recalcOrg(db, job.workspace_id, p.org_id, p.trigger ?? "event")).length };
    if (p.entity_type === "person" && p.entity_id) return scoreEntity(db, job.workspace_id, "contact", p.entity_id, p.trigger ?? "event").then(() => ({ scored: 1 }));
    return { scored: 0 };
  },
  "scoring.bulk": async (job) => {
    if (!job.workspace_id) throw new Error("workspace required");
    return recalcStale(createAdminClient(), job.workspace_id, { trigger: "scheduled" });
  },
};

export async function schedule(now: Date): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.from("workspace").select("id, timezone, status").eq("status", "active");
  for (const ws of data ?? []) {
    const tz = ws.timezone || "Asia/Kolkata";
    const day = localDate(now, tz);
    const at = atLocal(day, "02:30", tz);
    if (now >= at) await enqueue({ workspaceId: ws.id, type: "scoring.bulk", dedupeKey: `scoring.bulk:${ws.id}:${day}`, dueAt: at, maxAttempts: 2 });
  }
}
