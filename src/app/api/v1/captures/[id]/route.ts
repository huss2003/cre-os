import { requireContext, HttpError } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";

export const dynamic = "force-dynamic";

/** GET /api/v1/captures/[id] — processing status. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext();
  const id = uuid.parse(params.id);
  const { data } = await ctx.db.from("capture").select("id, kind, status, error, source_at, created_at, language_hint, consent_reference")
    .eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "not found");
  return { capture: data };
});
