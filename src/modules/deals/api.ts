import "server-only";
import type { NextRequest } from "next/server";
import { HttpError, requireContext, type AppContext, type Role } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { DealsError, idempotent, type DealsCtx } from "./ctx";

export function toDealsCtx(c: AppContext): DealsCtx {
  return { db: c.db, workspaceId: c.workspaceId, userId: c.userId, role: c.role };
}

export function asHttp(e: unknown): never {
  if (e instanceof DealsError) throw new HttpError(e.status, e.message, e.details);
  throw e;
}

/**
 * /api/v1 handler for the deals module: auth + role, DealsError → HTTP, and for mutations a required Idempotency-Key
 * whose first response is replayed for repeats (scope = route name).
 */
export function dealsRoute<P = Record<string, string>>(
  opts: { role?: Role; mutation?: boolean; scope?: string },
  fn: (req: NextRequest, ctx: DealsCtx, params: P) => Promise<unknown>,
) {
  return route<P>(async (req, meta) => {
    const app = await requireContext(opts.role ?? (opts.mutation ? "editor" : "viewer"));
    const ctx = toDealsCtx(app);
    try {
      if (opts.mutation && opts.scope) {
        const scope = `${opts.scope}:${JSON.stringify(meta.params ?? {})}`;
        return await idempotent(ctx, scope, meta.idempotencyKey, () => fn(req, ctx, meta.params));
      }
      return await fn(req, ctx, meta.params);
    } catch (e) {
      asHttp(e);
    }
  }, { requireIdempotency: !!opts.mutation });
}
