import "server-only";
import { HttpError } from "@/lib/auth/context";
import { DraftConflictError, DraftForbiddenError, DraftStateError, SuppressedRecipientError } from "@/lib/services/drafts";
import { CollisionError } from "./sequences";

/** Map integrations/draft service errors to HTTP errors for /api/v1 routes. */
export async function asHttp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SuppressedRecipientError) throw new HttpError(409, e.message, { reason: "suppressed" });
    if (e instanceof DraftConflictError) throw new HttpError(409, e.message, { reason: "conflict" });
    if (e instanceof DraftForbiddenError) throw new HttpError(403, e.message);
    if (e instanceof DraftStateError) throw new HttpError(e.message === "draft not found" ? 404 : 422, e.message);
    if (e instanceof CollisionError) throw new HttpError(409, e.message, { reason: "collision", report: e.report });
    const code = (e as { code?: string })?.code;
    if (code === "42501") throw new HttpError(403, "not allowed");
    if (code === "22023") throw new HttpError(422, (e as Error).message);
    throw e;
  }
}

export function providerParam(p: string): "microsoft" | "google" {
  if (p !== "microsoft" && p !== "google") throw new HttpError(404, "unknown provider");
  return p;
}
