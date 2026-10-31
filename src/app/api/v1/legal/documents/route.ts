import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { addLegalDocument, LegalDocInput } from "@/modules/intelligence/legal/service";
import { listLegalDocuments } from "@/modules/intelligence/legal/queries";
import { LEGAL_DISCLAIMER } from "@/modules/intelligence/common";

export const GET = route(async () => {
  const ctx = await requireContext();
  return { disclaimer: LEGAL_DISCLAIMER, documents: await guard(listLegalDocuments(ctx.db, ctx.workspaceId)) };
});

/** Store a version and extract clauses. Identical text in the same family returns the existing version (duplicate=true). */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, LegalDocInput);
  const r = await guard(addLegalDocument(ctx.db, ctx.workspaceId, b, { userId: ctx.userId }));
  return { disclaimer: LEGAL_DISCLAIMER, ...r };
}, { requireIdempotency: true });
