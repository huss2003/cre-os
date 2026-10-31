import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Minimal context the deals services need. Built from requireContext()/requirePageContext() in the app, or from a
 * signed-in test client. `db` is ALWAYS a user-scoped client (RLS enforced) — deals never uses the service role.
 */
export interface DealsCtx {
  db: SupabaseClient<any, "public", any>;
  workspaceId: string;
  userId: string;
  role?: "owner" | "admin" | "editor" | "viewer";
}

export class DealsError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

/** Map a PostgREST / Postgres error to a DealsError with a useful status. */
export function dbError(e: { code?: string; message?: string; details?: unknown } | null | undefined, what: string): DealsError {
  const code = e?.code ?? "";
  const msg = e?.message ?? "database error";
  if (code === "42501") return new DealsError(403, msg);
  if (code === "23503" || code === "23514" || code === "22P02" || code === "23502") return new DealsError(400, `${what}: ${msg}`);
  if (code === "23505") return new DealsError(409, `${what}: duplicate`);
  if (code === "40001" || /stale_version/.test(msg)) return new DealsError(409, "stale_version: the record changed, reload and retry");
  if (code === "PGRST116") return new DealsError(404, `${what} not found`);
  return new DealsError(500, `${what}: ${msg}`);
}

export function must<T>(r: { data: T | null; error: { code?: string; message?: string } | null }, what: string): NonNullable<T> {
  if (r.error) throw dbError(r.error, what);
  if (r.data === null || r.data === undefined) throw new DealsError(404, `${what} not found`);
  return r.data as NonNullable<T>;
}

/** Standard ownership/classification columns for rows created by a user. */
export function owned(ctx: DealsCtx, classification = "corporate_confidential") {
  return { workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, classification };
}

/**
 * Idempotent mutation: same (scope, key) within a workspace returns the first response (S8, security review M8).
 * Works alongside the shared route() idempotency store; safe when key is null (no dedupe).
 */
export async function idempotent<T>(ctx: DealsCtx, scope: string, key: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const prior = await ctx.db.from("deal_idempotency").select("response")
    .eq("workspace_id", ctx.workspaceId).eq("scope", scope).eq("idem_key", key).maybeSingle();
  if (prior.data) return (prior.data as { response: T }).response;
  const result = await fn();
  const ins = await ctx.db.from("deal_idempotency").insert({ workspace_id: ctx.workspaceId, scope, idem_key: key, response: (result ?? null) as unknown });
  if (ins.error && ins.error.code === "23505") {
    const again = await ctx.db.from("deal_idempotency").select("response")
      .eq("workspace_id", ctx.workspaceId).eq("scope", scope).eq("idem_key", key).maybeSingle();
    if (again.data) return (again.data as { response: T }).response;
  }
  return result;
}

export const today = () => new Date().toISOString().slice(0, 10);
