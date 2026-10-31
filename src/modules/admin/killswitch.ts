/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import type { SupabaseClient } from "@supabase/supabase-js";
import { badRequest } from "./errors";

type Client = SupabaseClient<any, any, any>;

/**
 * Workspace kill switch (POST /v1/admin/pause). Sets workspace.ai_paused, which the AI gateway already enforces
 * (AiUnavailableError 'paused'). Ingestion jobs (connectors, imports, research) must call assertIngestionAllowed()
 * before any external fetch. Internal records, tasks, approvals and the deterministic brief fallback keep working.
 */
export class IngestionPausedError extends Error {
  constructor(public reason: "paused" | "suspended", message?: string) {
    super(message ?? (reason === "paused" ? "external ingestion and AI are paused for this workspace" : "workspace is suspended"));
  }
}

export async function setAiPaused(db: Client, workspaceId: string, paused: boolean, reason?: string | null) {
  const { data, error } = await db.schema("mudar_app").rpc("set_ai_paused", { p_workspace: workspaceId, p_paused: paused, p_reason: reason ?? null });
  if (error) {
    if (error.code === "42501") throw badRequest("admin role required to toggle the kill switch");
    throw badRequest(error.message);
  }
  return data as boolean;
}

export async function pauseState(db: Client, workspaceId: string): Promise<{ aiPaused: boolean; status: string }> {
  const { data } = await db.from("workspace").select("ai_paused, status").eq("id", workspaceId).maybeSingle();
  return { aiPaused: !!data?.ai_paused, status: data?.status ?? "unknown" };
}

/** For jobs/connectors/importers (works with the service-role client; filters by workspace explicitly). */
export async function assertIngestionAllowed(db: Client, workspaceId: string) {
  const s = await pauseState(db, workspaceId);
  if (s.status === "suspended" || s.status === "archived") throw new IngestionPausedError("suspended");
  if (s.aiPaused || s.status === "paused") throw new IngestionPausedError("paused");
}
