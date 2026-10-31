import { route, uuid } from "@/lib/util/http";
import { HttpError, requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { legalDocument } from "@/modules/intelligence/legal/queries";
import { exposureChecklist, type ExtractedClause } from "@/modules/intelligence/legal/clauses";
import { LEGAL_DISCLAIMER } from "@/modules/intelligence/common";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext();
  const r = await guard(legalDocument(ctx.db, ctx.workspaceId, uuid.parse(params.id)));
  if (!r.doc) throw new HttpError(404, "not_found");
  return { disclaimer: LEGAL_DISCLAIMER, ...r, checklist: exposureChecklist(r.clauses as unknown as ExtractedClause[]) };
});
