import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { batchReverse, previewBatchReverse } from "@/modules/changes/service";
import { asHttp } from "@/modules/changes/http";

export const dynamic = "force-dynamic";

const Body = z.object({ ids: z.array(uuid).min(1).max(100), preview: z.boolean().default(false) });

/** POST — batch undo (newest first) or, with preview=true, the dependency preview without changing anything. */
export const POST = route(async (req: NextRequest) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  try {
    return b.preview ? await previewBatchReverse(ctx.db, ctx.workspaceId, b.ids) : await batchReverse(ctx.db, ctx.workspaceId, b.ids);
  } catch (e) { asHttp(e); }
}, { requireIdempotency: true });
