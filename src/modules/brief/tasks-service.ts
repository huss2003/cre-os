import "server-only";
/**
 * Task workflows for /tasks and /api/v1/tasks (user client, RLS enforced). Optimistic concurrency via row_version.
 * States stay distinct: open / overdue / snoozed / stale / done / cancelled (see builder.effectiveTaskState).
 * Completing a task requires completion evidence (spec: promise completion must be evidenced).
 */
import { z } from "zod";
import { HttpError } from "@/lib/auth/context";
import { createTask } from "@/lib/services/tasks";
import type { Db } from "@/lib/supabase/server";
import { effectiveTaskState, type TaskLite } from "./builder";
import { toTaskLite } from "./data";

export const TASK_STATES = ["open", "overdue", "snoozed", "stale", "done", "all"] as const;
export type TaskFilterState = (typeof TASK_STATES)[number];

export const taskFilterSchema = z.object({
  state: z.enum(TASK_STATES).default("open"),
  scope: z.enum(["mine", "all"]).default("mine"),
  q: z.string().trim().max(100).optional(),
  source: z.string().trim().max(40).optional(),
});
export type TaskFilter = z.infer<typeof taskFilterSchema>;

export const createTaskSchema = z.object({
  title: z.string().trim().min(3).max(300),
  description: z.string().trim().max(4000).optional(),
  dueAt: z.string().datetime({ offset: true }).optional().nullable(),
  priority: z.number().int().min(0).max(100).default(50),
  linkedEntityType: z.enum(["organisation", "person", "opportunity", "requirement", "lease", "asset", "meeting_visit"]).optional().nullable(),
  linkedEntityId: z.string().uuid().optional().nullable(),
});

export const completeSchema = z.object({ expectedVersion: z.number().int().positive(), evidence: z.string().trim().min(3, "describe what was done (evidence)").max(2000) });
export const snoozeSchema = z.object({ expectedVersion: z.number().int().positive(), until: z.string().datetime({ offset: true }) });
export const reopenSchema = z.object({ expectedVersion: z.number().int().positive() });

const COLS = "id, title, description, due_at, priority, status, snoozed_until, assigned_user_id, linked_entity_type, linked_entity_id, completion_evidence, completed_at, source, depends_on, row_version, updated_at, created_at, owner_user_id";

export interface TaskRow extends TaskLite {
  description: string | null; rowVersion: number; completionEvidence: string | null; assignedUserId: string | null; state: ReturnType<typeof effectiveTaskState>;
  dependsOn: string | null;
  /** Set when the task waits on an unfinished (or invisible) prerequisite — blocked, not doable. */
  waitsOn: string | null;
}

function toRow(t: any, now: string, staleAfter: number): TaskRow {
  const lite = toTaskLite(t);
  return { ...lite, description: t.description, rowVersion: Number(t.row_version), completionEvidence: t.completion_evidence, assignedUserId: t.assigned_user_id, state: effectiveTaskState(lite, now, staleAfter), dependsOn: t.depends_on ?? null, waitsOn: null };
}

/** Fill `waitsOn` for tasks whose depends_on task is not done/cancelled (RLS decides what the user can see). */
async function markBlocked(db: Db, workspaceId: string, rows: TaskRow[]): Promise<TaskRow[]> {
  const ids = [...new Set(rows.filter((r) => r.dependsOn && r.state !== "done" && r.state !== "cancelled").map((r) => r.dependsOn!))];
  if (!ids.length) return rows;
  const { data } = await db.from("task").select("id, title, status, archived_at").eq("workspace_id", workspaceId).in("id", ids.slice(0, 500));
  const dep = new Map((data ?? []).map((d: any) => [d.id, d]));
  return rows.map((r) => {
    if (!r.dependsOn || r.state === "done" || r.state === "cancelled") return r;
    const d: any = dep.get(r.dependsOn);
    if (d && (d.status === "done" || d.status === "cancelled" || d.archived_at)) return r;
    return { ...r, waitsOn: d ? `“${d.title}” (${d.status})` : "a prerequisite task you cannot see" };
  });
}

export async function listTasks(db: Db, workspaceId: string, userId: string, f: TaskFilter, opts: { now?: Date; staleAfterDays?: number; limit?: number } = {}): Promise<TaskRow[]> {
  const now = (opts.now ?? new Date()).toISOString();
  const staleAfter = opts.staleAfterDays ?? 14;
  let q = db.from("task").select(COLS).eq("workspace_id", workspaceId).is("archived_at", null);
  if (f.scope === "mine") q = q.or(`assigned_user_id.eq.${userId},and(assigned_user_id.is.null,owner_user_id.eq.${userId})`);
  if (f.source) q = q.eq("source", f.source);
  if (f.q) q = q.ilike("title", `%${f.q.replace(/[%_,()]/g, " ")}%`);
  if (f.state === "done") q = q.in("status", ["done", "cancelled"]).order("completed_at", { ascending: false, nullsFirst: false });
  else if (f.state !== "all") q = q.in("status", ["open", "snoozed", "stale"]).order("due_at", { ascending: true, nullsFirst: false }).order("priority", { ascending: false });
  else q = q.order("updated_at", { ascending: false });
  const { data, error } = await q.limit(opts.limit ?? 300);
  if (error) throw error;
  const rows = await markBlocked(db, workspaceId, (data ?? []).map((t: any) => toRow(t, now, staleAfter)));
  if (f.state === "done" || f.state === "all") return rows;
  return rows.filter((r) => (f.state === "open" ? r.state === "open" || r.state === "overdue" : r.state === f.state));
}

async function updateVersioned(db: Db, workspaceId: string, id: string, expectedVersion: number, patch: Record<string, unknown>) {
  const { data, error } = await db.from("task").update(patch).eq("workspace_id", workspaceId).eq("id", id).eq("row_version", expectedVersion).select(COLS);
  if (error) throw error;
  if (!data?.length) {
    const { data: cur } = await db.from("task").select(COLS).eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
    if (!cur) throw new HttpError(404, "task not found");
    throw new HttpError(409, "task changed since you loaded it — refresh and retry", { current: cur });
  }
  return data[0];
}

export async function completeTask(db: Db, workspaceId: string, id: string, input: unknown, now = new Date()) {
  const v = completeSchema.parse(input);
  const { data: cur } = await db.from("task").select(COLS).eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (!cur) throw new HttpError(404, "task not found");
  if (cur.status === "done") return toRow(cur, now.toISOString(), 14); // idempotent retry
  const row = await updateVersioned(db, workspaceId, id, v.expectedVersion, {
    status: "done", completion_evidence: v.evidence, completed_at: now.toISOString(), snoozed_until: null,
  });
  return toRow(row, now.toISOString(), 14);
}

export async function snoozeTask(db: Db, workspaceId: string, id: string, input: unknown, now = new Date()) {
  const v = snoozeSchema.parse(input);
  if (Date.parse(v.until) <= now.getTime()) throw new HttpError(400, "snooze time must be in the future");
  const row = await updateVersioned(db, workspaceId, id, v.expectedVersion, { status: "snoozed", snoozed_until: v.until });
  return toRow(row, now.toISOString(), 14);
}

export async function reopenTask(db: Db, workspaceId: string, id: string, input: unknown, now = new Date()) {
  const v = reopenSchema.parse(input);
  const row = await updateVersioned(db, workspaceId, id, v.expectedVersion, { status: "open", snoozed_until: null, completed_at: null });
  return toRow(row, now.toISOString(), 14);
}

/** Manual task; the Idempotency-Key makes retries return the same task. */
export async function createManualTask(db: Db, workspaceId: string, userId: string, input: unknown, idempotencyKey: string | null) {
  const v = createTaskSchema.parse(input);
  if ((v.linkedEntityType == null) !== (v.linkedEntityId == null)) throw new HttpError(400, "linkedEntityType and linkedEntityId go together");
  const row = await createTask(db, workspaceId, {
    title: v.title, description: v.description, dueAt: v.dueAt ?? null, priority: v.priority, source: "manual",
    linkedEntityType: v.linkedEntityType ?? null, linkedEntityId: v.linkedEntityId ?? null,
    assignedUserId: userId, ownerUserId: userId, idempotencyKey: idempotencyKey ? `manual:${userId}:${idempotencyKey}` : undefined,
  });
  return toRow(row, new Date().toISOString(), 14);
}

/** "Add to tasks" from a /today target card: one task per org per day. */
export async function createTargetTask(db: Db, workspaceId: string, userId: string, t: { orgId: string; name: string; why: string; date: string }) {
  return createTask(db, workspaceId, {
    title: `Approach ${t.name}`, description: `From today's plan: ${t.why}. Draft only — you send (no automatic outreach).`,
    dueAt: `${t.date}T13:30:00.000Z`, priority: 70, source: "brief", linkedEntityType: "organisation", linkedEntityId: t.orgId,
    assignedUserId: userId, ownerUserId: userId, idempotencyKey: `brief.target:${userId}:${t.orgId}:${t.date}`,
  });
}

/**
 * Housekeeping (admin client, job-side; explicit workspace filter): wake expired snoozes; mark long-overdue tasks stale
 * (they are not "done" and not hidden — /tasks shows them under Stale).
 */
export async function housekeepTasks(admin: Db, workspaceId: string, userId: string, now: Date, staleAfterDays: number): Promise<{ woken: number; staled: number }> {
  const nowIso = now.toISOString();
  const mine = `assigned_user_id.eq.${userId},and(assigned_user_id.is.null,owner_user_id.eq.${userId})`;
  const { data: woken, error: e1 } = await admin.from("task").update({ status: "open", snoozed_until: null })
    .eq("workspace_id", workspaceId).eq("status", "snoozed").lte("snoozed_until", nowIso).or(mine).select("id");
  if (e1) throw e1;
  const cutoff = new Date(now.getTime() - staleAfterDays * 86_400_000).toISOString();
  const { data: staled, error: e2 } = await admin.from("task").update({ status: "stale" })
    .eq("workspace_id", workspaceId).eq("status", "open").lt("due_at", cutoff).is("archived_at", null).or(mine).select("id");
  if (e2) throw e2;
  return { woken: woken?.length ?? 0, staled: staled?.length ?? 0 };
}
