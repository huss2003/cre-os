import "server-only";
import type { Db } from "@/lib/supabase/server";

/** Append-only execution audit (workflow_audit_log). Never throws: auditing must not break execution. */
export async function audit(db: Db, ws: string, a: { runId: string | null; key?: string | null; action: string; actor?: string | null; detail?: Record<string, unknown> }) {
  await db.from("workflow_audit_log").insert({
    workspace_id: ws, run_id: a.runId, definition_key: a.key ?? null, action: a.action,
    actor_user_id: a.actor ?? null, actor_kind: a.actor ? "user" : "system", detail: a.detail ?? {},
  }).then(undefined, () => undefined);
}
