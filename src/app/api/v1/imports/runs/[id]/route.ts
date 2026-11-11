import { HttpError, requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { importRunDetail } from "@/modules/imports/service";

/** GET /api/v1/imports/runs/[id] — per-file status, progress and the completion report (spec §10). */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext("editor");
  const r = await importRunDetail(ctx, uuid.parse(params.id));
  if (!r) throw new HttpError(404, "run not found");
  return { run: r.run, items: r.items.map(({ like: _like, ...i }) => { void _like; return i; }) };
});
