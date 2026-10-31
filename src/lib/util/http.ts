import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError, type ZodType } from "zod";
import { HttpError } from "@/lib/auth/context";
import { createUserClient } from "@/lib/supabase/server";
import { sha256 } from "@/lib/util/crypto";

/**
 * Wrap a /api/v1 route handler: request id, JSON errors, zod validation errors -> 400.
 * Mutations must send an `Idempotency-Key` header (spec: "Request IDs and idempotency keys on every mutation").
 */
export function route<P = Record<string, string>>(
  handler: (req: NextRequest, meta: { requestId: string; idempotencyKey: string | null; params: P }) => Promise<unknown>,
  opts: { requireIdempotency?: boolean } = {},
) {
  return async (req: NextRequest, ctx: { params: Promise<P> }) => {
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
    const idempotencyKey = req.headers.get("idempotency-key");
    try {
      const mutating = req.method !== "GET" && req.method !== "HEAD";
      if (opts.requireIdempotency && !idempotencyKey && mutating) {
        throw new HttpError(400, "Idempotency-Key header required");
      }
      // Replay protection: same user + route + key returns the stored response; a different body is rejected.
      let idem: { db: Awaited<ReturnType<typeof createUserClient>>; userId: string; route: string; hash: string } | null = null;
      if (opts.requireIdempotency && idempotencyKey && mutating) {
        const db = await createUserClient();
        const { data: u } = await db.auth.getUser();
        if (u.user) {
          const bodyText = await req.clone().text();
          const routeKey = `${req.method} ${req.nextUrl.pathname}`;
          const hash = sha256(bodyText);
          const { data: prior } = await db.from("idempotency_key").select("request_hash, status, response")
            .eq("user_id", u.user.id).eq("route", routeKey).eq("key", idempotencyKey).maybeSingle();
          if (prior) {
            if (prior.request_hash !== hash) throw new HttpError(422, "Idempotency-Key reused with a different request body");
            if (prior.response !== null) {
              return NextResponse.json(prior.response, { status: prior.status ?? 200, headers: { "x-request-id": requestId, "idempotent-replay": "true" } });
            }
            throw new HttpError(409, "request with this Idempotency-Key is still in progress");
          }
          const { error } = await db.from("idempotency_key").insert({ user_id: u.user.id, route: routeKey, key: idempotencyKey, request_hash: hash });
          if (error) throw new HttpError(409, "duplicate concurrent request");
          idem = { db, userId: u.user.id, route: routeKey, hash };
        }
      }
      try {
        const result = await handler(req, { requestId, idempotencyKey, params: await ctx.params });
        if (result instanceof Response) {
          if (idem) await idem.db.from("idempotency_key").delete().eq("user_id", idem.userId).eq("route", idem.route).eq("key", idempotencyKey!);
          return result;
        }
        const body = result ?? { ok: true };
        if (idem) await idem.db.from("idempotency_key").update({ status: 200, response: body }).eq("user_id", idem.userId).eq("route", idem.route).eq("key", idempotencyKey!);
        return NextResponse.json(body, { headers: { "x-request-id": requestId } });
      } catch (inner) {
        // failed requests may be retried with the same key
        if (idem) await idem.db.from("idempotency_key").delete().eq("user_id", idem.userId).eq("route", idem.route).eq("key", idempotencyKey!);
        throw inner;
      }
    } catch (e) {
      return errorResponse(e, requestId);
    }
  };
}

export function errorResponse(e: unknown, requestId: string) {
  if (e instanceof HttpError) {
    return NextResponse.json({ error: e.message, details: e.details, requestId }, { status: e.status });
  }
  if (e instanceof ZodError) {
    return NextResponse.json({ error: "validation_failed", details: e.issues, requestId }, { status: 400 });
  }
  console.error(`[${requestId}]`, e);
  return NextResponse.json({ error: "internal_error", requestId }, { status: 500 });
}

export async function parseJson<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  return schema.parse(body);
}

export const uuid = z.string().uuid();
