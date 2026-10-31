import { requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { reconciliation } from "@/modules/imports/service";

/** GET /api/v1/imports/[id]/reconciliation — batch report: raw = accepted + quarantined + excluded, masters vs observations, controls, diff. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext("viewer");
  return reconciliation(ctx, uuid.parse(params.id));
});
