import "server-only";
import type { Db } from "@/lib/supabase/server";
import { planWaves } from "./plan";
import { audit } from "./audit";
import type { DefStatus, WorkflowDefinition } from "./types";

type Row = Record<string, any>;
const REGISTRY = new Map<string, WorkflowDefinition>();

/** Register a code-defined workflow. Validates the dependency graph. Re-registering the same key replaces it (HMR/tests). */
export function registerWorkflow(def: WorkflowDefinition): WorkflowDefinition {
  planWaves(def.steps);
  REGISTRY.set(def.key, def);
  return def;
}
export function definition(key: string): WorkflowDefinition {
  const d = REGISTRY.get(key);
  if (!d) throw new Error(`Unknown workflow ${key}`);
  return d;
}
export const registeredWorkflows = () => [...REGISTRY.values()];

/** Serializable description (for the UI and version snapshots). */
export function describe(def: WorkflowDefinition) {
  return {
    key: def.key, name: def.name, description: def.description, module: def.module, trigger: def.trigger,
    steps: def.steps.map((s) => ({ key: s.key, label: s.label, module: s.module, dependsOn: s.dependsOn ?? [], consequential: !!s.consequential, timeoutMs: s.timeoutMs ?? null, retry: s.retry ?? null })),
    permissions: def.permissions ?? { role: "editor" }, approvals: def.approvals ?? [], retry: def.retry ?? null,
    timeoutMs: def.timeoutMs ?? null, priority: def.priority ?? 50, inputs: def.inputs ?? [],
  };
}

/** Per-workspace state row (status, priority, schedule). Created on first use; never duplicates (unique ws+key). */
export async function ensureDefinitionRow(db: Db, ws: string, key: string, now = new Date()): Promise<Row> {
  const def = definition(key);
  const { data: cur } = await db.from("workflow_definition").select("*").eq("workspace_id", ws).eq("key", key).maybeSingle();
  if (cur) return cur;
  const every = def.trigger.type === "schedule" ? def.trigger.everyMinutes ?? null : null;
  const ins = await db.from("workflow_definition").insert({
    workspace_id: ws, key, status: "active", version: 1, priority: def.priority ?? 50, every_minutes: every,
    next_run_at: every ? now.toISOString() : null,
  }).select("*").single();
  if (ins.error) {
    if (ins.error.code === "23505") return (await db.from("workflow_definition").select("*").eq("workspace_id", ws).eq("key", key).single()).data as Row;
    throw new Error(ins.error.message);
  }
  await db.from("workflow_definition_version").insert({ workspace_id: ws, definition_id: ins.data.id, version: 1, snapshot: { ...describe(def), state: { status: "active", priority: ins.data.priority, every_minutes: every } }, note: "created" });
  return ins.data as Row;
}

export async function listWorkflows(db: Db, ws: string) {
  const { data } = await db.from("workflow_definition").select("*").eq("workspace_id", ws);
  const rows = new Map(((data ?? []) as Row[]).map((r) => [r.key, r]));
  return registeredWorkflows().map((d) => ({ ...describe(d), state: rows.get(d.key) ?? null }));
}

export async function getWorkflow(db: Db, ws: string, key: string) {
  const def = definition(key);
  const row = await ensureDefinitionRow(db, ws, key);
  const [{ data: versions }, { data: runs }] = await Promise.all([
    db.from("workflow_definition_version").select("version, snapshot, changed_by, note, created_at").eq("workspace_id", ws).eq("definition_id", row.id).order("version", { ascending: false }).limit(50),
    db.from("workflow_run").select("id, status, started_at, finished_at, progress, error").eq("workspace_id", ws).eq("definition_key", key).order("started_at", { ascending: false }).limit(20),
  ]);
  return { ...describe(def), state: row, versions: (versions ?? []) as Row[], recentExecutions: (runs ?? []) as Row[] };
}

async function bump(db: Db, ws: string, key: string, patch: Row, actor: string | null, note: string) {
  const row = await ensureDefinitionRow(db, ws, key);
  const version = (row.version ?? 1) + 1;
  const { data, error } = await db.from("workflow_definition").update({ ...patch, version, updated_at: new Date().toISOString() })
    .eq("workspace_id", ws).eq("id", row.id).eq("version", row.version).select("*").maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("The workflow was changed by someone else; reload and try again.");
  await db.from("workflow_definition_version").insert({ workspace_id: ws, definition_id: row.id, version, snapshot: { ...describe(definition(key)), state: { status: data.status, priority: data.priority, every_minutes: data.every_minutes, next_run_at: data.next_run_at } }, changed_by: actor, note });
  await audit(db, ws, { runId: null, key, action: `definition_${note.split(" ")[0]}`, actor, detail: patch });
  return data as Row;
}

/** Pause/activate a workflow definition. Paused recurring workflows start no new executions; history is kept. */
export async function setWorkflowStatus(db: Db, ws: string, key: string, status: DefStatus, actor: string | null = null, now = new Date()) {
  const row = await ensureDefinitionRow(db, ws, key);
  const patch: Row = { status };
  // Resuming: the next run is the next due slot from now (no burst of missed runs).
  if (status === "active" && row.every_minutes && (!row.next_run_at || Date.parse(row.next_run_at) < +now)) patch.next_run_at = now.toISOString();
  return bump(db, ws, key, patch, actor, status === "paused" ? "paused" : status === "active" ? "activated" : "drafted");
}
export async function editSchedule(db: Db, ws: string, key: string, s: { everyMinutes?: number | null; nextRunAt?: string | null }, actor: string | null = null) {
  if (s.everyMinutes != null && (s.everyMinutes < 5 || !Number.isInteger(s.everyMinutes))) throw new Error("Interval must be a whole number of minutes, at least 5.");
  const patch: Row = {};
  if (s.everyMinutes !== undefined) patch.every_minutes = s.everyMinutes;
  if (s.nextRunAt !== undefined) patch.next_run_at = s.nextRunAt;
  return bump(db, ws, key, patch, actor, "schedule edited");
}
export async function changeWorkflowPriority(db: Db, ws: string, key: string, priority: number, actor: string | null = null) {
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) throw new Error("Priority must be 0–100.");
  return bump(db, ws, key, { priority }, actor, "priority changed");
}
