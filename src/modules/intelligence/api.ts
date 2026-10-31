import "server-only";
import { ZodError } from "zod";
import { HttpError } from "@/lib/auth/context";

/** Map service errors to HTTP errors for /api/v1 intelligence routes (RLS -> 403, unique -> 409, domain -> 400). */
export function toHttp(e: unknown): never {
  if (e instanceof HttpError || e instanceof ZodError) throw e;
  const code = (e as { code?: string })?.code;
  if (code === "42501") throw new HttpError(403, "forbidden");
  if (code === "23505") throw new HttpError(409, "conflict");
  if (code === "PGRST116") throw new HttpError(404, "not_found");
  if (e instanceof Error && /not found|not visible/i.test(e.message)) throw new HttpError(404, e.message);
  if (e instanceof Error && !code) throw new HttpError(400, e.message.slice(0, 300));
  throw e;
}

export async function guard<T>(p: Promise<T>): Promise<T> {
  try { return await p; } catch (e) { toHttp(e); }
}
