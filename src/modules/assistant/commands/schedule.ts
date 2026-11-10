import "server-only";
import type { Db } from "@/lib/supabase/server";
import { nextCronRun } from "./cron";
import type { CommandRow } from "./service";

/**
 * Scheduler side of saved commands. Uses the service-role client, so EVERY query filters workspace_id explicitly (S2).
 * A command is only due when schedule_enabled AND schedule_authorised_at are both set (explicit opt-in).
 */
export type EnqueueFn = (o: { workspaceId: string; type: string; payload: Record<string, unknown>; dedupeKey: string; dueAt: Date; maxAttempts?: number }) => Promise<unknown>;

export const dedupeKeyFor = (c: Pick<CommandRow, "id" | "next_run_at">) => `cmd:${c.id}:${c.next_run_at}`;

export async function dueCommands(admin: Db, workspaceId: string, now: Date): Promise<CommandRow[]> {
  const { data, error } = await admin.from("assistant_command").select("*").eq("workspace_id", workspaceId)
    .eq("schedule_enabled", true).not("schedule_authorised_at", "is", null).is("archived_at", null)
    .not("next_run_at", "is", null).lte("next_run_at", now.toISOString()).limit(100);
  if (error) throw error;
  return (data ?? []) as CommandRow[];
}

export async function scheduleCommands(admin: Db, now: Date, enqueue: EnqueueFn, onlyWorkspace?: string): Promise<string[]> {
  let wsq = admin.from("workspace").select("id, status").eq("status", "active");
  if (onlyWorkspace) wsq = wsq.eq("id", onlyWorkspace);
  const { data: wss } = await wsq;
  const keys: string[] = [];
  for (const ws of (wss ?? []) as { id: string }[]) {
    for (const c of await dueCommands(admin, ws.id, now)) {
      const key = dedupeKeyFor(c);
      await enqueue({ workspaceId: ws.id, type: "assistant.command", payload: { commandId: c.id, scheduledFor: c.next_run_at }, dedupeKey: key, dueAt: now, maxAttempts: 2 });
      keys.push(key);
    }
  }
  return keys;
}

/** After a scheduled run (or skip), move next_run_at forward. */
export async function advanceSchedule(admin: Db, workspaceId: string, c: Pick<CommandRow, "id" | "schedule_cron">, now: Date, tz = "Asia/Kolkata", ran = true) {
  const next = c.schedule_cron ? nextCronRun(c.schedule_cron, now, tz) : null;
  await admin.from("assistant_command").update({ ...(ran ? { last_run_at: now.toISOString() } : {}), next_run_at: next?.toISOString() ?? null })
    .eq("workspace_id", workspaceId).eq("id", c.id);
}
