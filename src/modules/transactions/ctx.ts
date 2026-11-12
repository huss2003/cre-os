import type { SupabaseClient } from "@supabase/supabase-js";

/** User-scoped context (RLS). Module 16 never uses the service role except in jobs (explicit workspace filters). */
export interface TxCtx { db: SupabaseClient<any, any, any>; workspaceId: string; userId: string }

export class TxError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

export function txDbError(e: { code?: string; message?: string } | null | undefined, what: string): TxError {
  const code = e?.code ?? ""; const msg = e?.message ?? "database error";
  if (code === "42501") return new TxError(403, msg);
  if (["23503", "23514", "22P02", "23502"].includes(code)) return new TxError(400, `${what}: ${msg}`);
  if (code === "23505") return new TxError(409, `${what}: duplicate`);
  if (code === "40001") return new TxError(409, msg);
  if (code === "PGRST116") return new TxError(404, `${what} not found`);
  return new TxError(500, `${what}: ${msg}`);
}

export async function q<T = any>(p: PromiseLike<{ data: unknown; error: any }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw txDbError(error, what);
  return data as T;
}
