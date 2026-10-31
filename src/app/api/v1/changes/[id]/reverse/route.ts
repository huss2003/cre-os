import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { previewReverse, reverseChange } from "@/modules/changes/service";
import { asHttp } from "@/modules/changes/http";

export const dynamic = "force-dynamic";

/** GET — undo preview: fields (restorable or not), later changes, dependents, external effects. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext();
  try { return await previewReverse(ctx.db, uuid.parse(params.id)); } catch (e) { asHttp(e); }
});

const Body = z.object({ paths: z.array(z.string().regex(/^\/?[a-z_][a-z0-9_]*$/)).max(60).nullish() });

/** POST — compensating reversal; later independent edits are kept and returned as conflicts. */
export const POST = route<{ id: string }>(async (req: NextRequest, { params }) => {
  const ctx = await requireContext("editor");
  const b = req.headers.get("content-length") === "0" ? { paths: null } : await parseJson(req, Body).catch(() => ({ paths: null }));
  try { return await reverseChange(ctx.db, uuid.parse(params.id), { paths: b.paths ?? undefined }); } catch (e) { asHttp(e); }
}, { requireIdempotency: true });
