import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError, type ZodType } from "zod";
import { HttpError } from "@/lib/auth/context";

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
      if (opts.requireIdempotency && !idempotencyKey && req.method !== "GET") {
        throw new HttpError(400, "Idempotency-Key header required");
      }
      const result = await handler(req, { requestId, idempotencyKey, params: await ctx.params });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true }, { headers: { "x-request-id": requestId } });
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
