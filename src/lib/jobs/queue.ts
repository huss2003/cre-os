import "server-only";
import { adminApp } from "@/lib/supabase/admin";

export interface Job {
  id: string;
  workspace_id: string | null;
  job_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  due_at: string;
  dedupe_key: string | null;
}

export type JobHandler = (job: Job) => Promise<unknown>;

/** Enqueue a durable job. Same dedupe_key => one job (at-least-once delivery, idempotent consumers). */
export async function enqueue(opts: {
  workspaceId: string | null;
  type: string;
  payload?: Record<string, unknown>;
  dueAt?: Date;
  dedupeKey?: string;
  maxAttempts?: number;
}): Promise<string> {
  const { data, error } = await adminApp().rpc("enqueue_job", {
    p_workspace: opts.workspaceId,
    p_type: opts.type,
    p_payload: opts.payload ?? {},
    p_due: (opts.dueAt ?? new Date()).toISOString(),
    p_dedupe: opts.dedupeKey ?? null,
    p_max_attempts: opts.maxAttempts ?? 5,
  });
  if (error) throw error;
  return data as string;
}

export async function claim(worker: string, limit = 5, types?: string[]): Promise<Job[]> {
  const { data, error } = await adminApp().rpc("claim_jobs", { p_worker: worker, p_limit: limit, p_lease_seconds: 300, p_types: types ?? null });
  if (error) throw error;
  return (data ?? []) as Job[];
}

export async function complete(id: string, result?: unknown) {
  await adminApp().rpc("complete_job", { p_id: id, p_result: (result ?? null) as never });
}

export async function fail(id: string, err: unknown) {
  await adminApp().rpc("fail_job", { p_id: id, p_error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) });
}
