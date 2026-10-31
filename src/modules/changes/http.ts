import "server-only";
import { HttpError } from "@/lib/auth/context";
import { ChangeError, ForbiddenTargetError } from "@/lib/services/changes";

/** Map change/capture service errors to HTTP errors for /api/v1 routes (code prefix kept for clients). */
export function asHttp(e: unknown): never {
  if (e instanceof ForbiddenTargetError) throw new HttpError(403, e.message, { code: "forbidden" });
  if (e instanceof ChangeError) throw new HttpError(e.httpStatus === 500 ? 400 : e.httpStatus, `${e.code}: ${e.message}`, { code: e.code });
  throw e;
}

/** Same, for server actions: a user-facing message. */
export function actionError(e: unknown): string {
  if (e instanceof ChangeError) {
    const hint: Record<string, string> = {
      approval_invalid: "The proposal changed (or was never approved) since approval — review and approve it again.",
      approval_expired: "The approval expired — approve again.",
      stale_version: "The record changed since this was proposed — review the current values and re-propose.",
      forbidden: "You don't have permission for this action.",
      not_found: "Not found (or not visible to you).",
    };
    return `${hint[e.code] ?? ""} ${e.message}`.trim();
  }
  if (e instanceof ForbiddenTargetError) return e.message;
  return e instanceof Error ? e.message : String(e);
}
