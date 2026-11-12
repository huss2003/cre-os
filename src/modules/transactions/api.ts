import "server-only";
import type { NextRequest } from "next/server";
import { HttpError, requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { TxError, type TxCtx } from "./ctx";

/** /api/v1/transactions handler: auth, TxError → HTTP, Idempotency-Key required on mutations (S8, replay via route()). */
export function txRoute<P = Record<string, string>>(opts: { mutation?: boolean }, fn: (req: NextRequest, ctx: TxCtx, params: P) => Promise<unknown>) {
  return route<P>(async (req, meta) => {
    const app = await requireContext(opts.mutation ? "editor" : "viewer");
    try { return await fn(req, { db: app.db, workspaceId: app.workspaceId, userId: app.userId }, meta.params); }
    catch (e) { if (e instanceof TxError) throw new HttpError(e.status, e.message, e.details); throw e; }
  }, { requireIdempotency: !!opts.mutation });
}
