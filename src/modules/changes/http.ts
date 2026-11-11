import "server-only";
import { HttpError } from "@/lib/auth/context";
import { ChangeError, ForbiddenTargetError } from "@/lib/services/changes";

/** Map change/capture service errors to HTTP errors for /api/v1 routes (code prefix kept for clients). */
export function asHttp(e: unknown): never {
  if (e instanceof ForbiddenTargetError) throw new HttpError(403, e.message, { code: "forbidden" });
  if (e instanceof ChangeError) throw new HttpError(e.httpStatus === 500 ? 400 : e.httpStatus, `${e.code}: ${e.message}`, { code: e.code });
  if (e && typeof e === "object" && !(e instanceof Error) && "message" in e) {   // PostgREST error object
    const forbidden = (e as { code?: unknown }).code === "42501";
    throw new HttpError(forbidden ? 403 : 500, errorMessage(e), { code: forbidden ? "forbidden" : "database_error" });
  }
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
  return errorMessage(e);
}

/** A readable message for anything thrown — including PostgREST/Supabase error objects, which are plain objects
 *  (`String(e)` would show "[object Object]"). Row-level-security denials get a plain-language explanation. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    if (o.code === "42501") return "You don't have permission to save this here (your access level for this workspace doesn't cover it). Ask a workspace admin.";
    const parts = [o.message, o.details, o.hint].filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (parts.length) return parts.join(" — ");
    try { return JSON.stringify(e); } catch { /* fall through */ }
  }
  return typeof e === "string" && e ? e : "Something went wrong.";
}
