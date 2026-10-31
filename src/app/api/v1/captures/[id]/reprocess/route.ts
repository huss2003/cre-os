import { requireContext, HttpError } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { reprocess } from "@/modules/capture/service";

export const dynamic = "force-dynamic";

/** POST — queue a forced re-extraction (idempotent: existing tasks/proposals/drafts are reused, never duplicated). */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  const { data } = await ctx.db.from("capture").select("id").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "not found");
  return { jobId: await reprocess(ctx.workspaceId, id) };
}, { requireIdempotency: true });
