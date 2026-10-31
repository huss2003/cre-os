import "server-only";
import type { Db } from "@/lib/supabase/server";

export interface NewTask {
  title: string;
  description?: string;
  dueAt?: string | null;
  priority?: number;
  assignedUserId?: string | null;
  linkedEntityType?: string | null;
  linkedEntityId?: string | null;
  source?: "capture" | "brief" | "workflow" | "manual" | "import" | "connector";
  idempotencyKey?: string;      // e.g. "capture:<id>:task:0" — repeated extraction creates one task
  classification?: string;
  ownerUserId?: string | null;
}

/** Idempotent task creation (unique workspace_id+idempotency_key). Works with user client (RLS) or admin client (jobs). */
export async function createTask(db: Db, workspaceId: string, t: NewTask) {
  const row = {
    workspace_id: workspaceId,
    title: t.title,
    description: t.description ?? null,
    due_at: t.dueAt ?? null,
    priority: t.priority ?? 50,
    assigned_user_id: t.assignedUserId ?? t.ownerUserId ?? null,
    linked_entity_type: t.linkedEntityType ?? null,
    linked_entity_id: t.linkedEntityId ?? null,
    source: t.source ?? "manual",
    idempotency_key: t.idempotencyKey ?? null,
    classification: t.classification ?? "corporate_confidential",
    owner_user_id: t.ownerUserId ?? undefined,
  };
  if (t.idempotencyKey) {
    const { data: existing } = await db.from("task").select("*").eq("workspace_id", workspaceId).eq("idempotency_key", t.idempotencyKey).maybeSingle();
    if (existing) return existing;
  }
  const { data, error } = await db.from("task").insert(row).select().single();
  if (error) throw error;
  return data;
}
