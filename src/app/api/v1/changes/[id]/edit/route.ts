import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { editChange } from "@/modules/changes/service";
import { asHttp } from "@/modules/changes/http";

export const dynamic = "force-dynamic";

const Body = z.object({
  patch: z.array(z.object({ op: z.enum(["add", "replace", "remove"]), path: z.string().regex(/^\/[a-z_][a-z0-9_]*$/), value: z.unknown().optional() })).min(1).max(60),
  reason: z.string().max(2000).nullish(),
});

/** POST — edit an undecided proposal. Any approval is invalidated (approval binds to the content hash). */
export const POST = route<{ id: string }>(async (req: NextRequest, { params }) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  try { return { proposal: await editChange(ctx.db, uuid.parse(params.id), b.patch as never, { reason: b.reason ?? undefined }) }; } catch (e) { asHttp(e); }
}, { requireIdempotency: true });
