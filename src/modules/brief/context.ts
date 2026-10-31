import "server-only";
import type { AppContext } from "@/lib/auth/context";
import { localDate } from "@/lib/util/time";
import type { LoadCtx } from "./data";

/** User-scoped load context: RLS does the filtering, so access = null. */
export function loadCtxFor(ctx: Pick<AppContext, "db" | "workspaceId" | "userId" | "timezone">): LoadCtx {
  return { db: ctx.db, workspaceId: ctx.workspaceId, userId: ctx.userId, tz: ctx.timezone || "Asia/Kolkata", access: null };
}

export function todayFor(ctx: Pick<AppContext, "timezone">, now = new Date()): string {
  return localDate(now, ctx.timezone || "Asia/Kolkata");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function parseDateParam(v: string | null | undefined, fallback: string): string {
  return v && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")) ? v : fallback;
}
