import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { asHttp } from "@/modules/changes/http";
import { getFreshness, listStale, markVerified } from "@/modules/changes/steward";

export const dynamic = "force-dynamic";

/** GET /api/v1/changes/freshness[?type=&id=] — stale records (or one record's freshness flag). */
export const GET = route(async (req: NextRequest) => {
  const ctx = await requireContext();
  const sp = req.nextUrl.searchParams;
  if (sp.get("type") && sp.get("id")) return { freshness: await getFreshness(ctx.db, ctx.workspaceId, String(sp.get("type")), uuid.parse(sp.get("id"))) };
  return { stale: await listStale(ctx.db, ctx.workspaceId) };
});

const Body = z.object({ type: z.enum(["organisation", "person", "asset", "availability"]), id: uuid, note: z.string().max(500).nullish() });

/** POST /api/v1/changes/freshness {type, id, note?} — mark a record's key facts verified (closes its review task). */
export const POST = route(async (req: NextRequest) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  try { return await markVerified(ctx.db, ctx.workspaceId, ctx.userId, b.type, b.id, b.note ?? null); } catch (e) { asHttp(e); }
}, { requireIdempotency: true });
