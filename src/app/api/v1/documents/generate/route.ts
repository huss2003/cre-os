import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { generateDocument } from "@/modules/deals/documents/service";

const Body = z.object({
  purpose: z.enum(["shortlist_deck", "proposal", "market_note", "comparison_xlsx"]),
  requirementId: z.string().uuid(), scenarioIds: z.array(z.string().uuid()).max(12).optional(),
  shortlistVersion: z.number().int().positive().nullish(), preparedFor: z.string().max(200).nullish(),
});

/** Editable PPTX/DOCX/XLSX from current approved inputs; stored with hash + input versions as a draft. */
export const POST = dealsRoute({ mutation: true, scope: "documents.generate" }, async (req, ctx) => {
  const b = await parseJson(req, Body);
  const r = await generateDocument(ctx, b);
  return { document: r.document, warnings: r.warnings, bytes: r.bytes, download: `/api/v1/documents/${(r.document as { id: string }).id}/download` };
});
