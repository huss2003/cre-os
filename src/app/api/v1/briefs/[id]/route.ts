import { HttpError, requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";


/** GET /api/v1/briefs/:id — one of the caller's own briefs (any kind/version). */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext();
  const id = uuid.parse(params.id);
  const { data, error } = await ctx.db.from("brief")
    .select("id, user_id, brief_date, kind, subject_key, version, generated_at, content, synthesis_status, source_health, delivered_at")
    .eq("workspace_id", ctx.workspaceId).eq("user_id", ctx.userId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "brief not found");
  return { brief: data };
});
