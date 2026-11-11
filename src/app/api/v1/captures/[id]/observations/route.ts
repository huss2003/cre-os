import { requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { asHttp } from "@/modules/changes/http";
import { correctionsFor, observationsFor } from "@/modules/capture/input-engine/service";

export const dynamic = "force-dynamic";

/** GET — extracted observations (fact class, source reference, confidence, conflicts) and the correction history of a capture. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext();
  try {
    const id = uuid.parse(params.id);
    return { observations: await observationsFor(ctx.db, ctx.workspaceId, { captureId: id }), corrections: await correctionsFor(ctx.db, ctx.workspaceId, id) };
  } catch (e) { asHttp(e); }
});
