import { z } from "zod";
import { dealsRoute } from "@/modules/deals/api";
import { regenerateDocument } from "@/modules/deals/documents/service";

/** New version from current inputs (same purpose / requirement / scenarios). Earlier versions, incl. approved ones, are kept. */
export const POST = dealsRoute<{ id: string }>({ mutation: true, scope: "documents.regenerate" }, async (_req, ctx, p) => {
  const r = await regenerateDocument(ctx, z.string().uuid().parse(p.id));
  return { document: r.document, warnings: r.warnings, download: `/api/v1/documents/${(r.document as { id: string }).id}/download` };
});
