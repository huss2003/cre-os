import { requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { getProposal, previewReverse } from "@/modules/changes/service";
import { asHttp } from "@/modules/changes/http";

export const dynamic = "force-dynamic";

/** GET — proposal with current values, stale flag, approvals, conflicts, evidence spans and (if applied) undo preview. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext();
  try {
    const d = await getProposal(ctx.db, ctx.workspaceId, uuid.parse(params.id));
    const undo = ["applied", "conflict"].includes(d.proposal.state) ? await previewReverse(ctx.db, d.proposal.id).catch(() => null) : null;
    return { ...d, undo };
  } catch (e) { asHttp(e); }
});
