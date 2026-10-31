import "server-only";
import { HttpError } from "@/lib/auth/context";
import { AdminError } from "./errors";

/** Map module errors to HttpError so the shared route() wrapper returns the right status. */
export async function asHttp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AdminError) throw new HttpError(e.status, e.message, e.details);
    throw e;
  }
}

/** For server actions: turn any error into a user-facing message (zod issues flattened). */
export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "issues" in e && Array.isArray((e as { issues: unknown[] }).issues)) {
    return (e as { issues: { path: (string | number)[]; message: string }[] }).issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
