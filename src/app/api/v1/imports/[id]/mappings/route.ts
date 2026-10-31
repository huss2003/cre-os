import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { parseJson, route, uuid } from "@/lib/util/http";
import { approveMappingAndReprocess } from "@/modules/imports/service";

const Body = z.object({
  sheet: z.string().min(1).max(200),
  adapter: z.string().min(1).max(60),
  role: z.string().min(1).max(60),
  column_map: z.record(z.string(), z.number().int().min(0).max(500)),
  positional: z.boolean().default(false),
  header_row: z.number().int().min(0).max(50).default(0),
  name: z.string().max(200).optional(),
  note: z.string().max(1000).optional(),
});

/** POST /api/v1/imports/[id]/mappings — admin approves a column map for an unknown sheet schema, then the batch is re-processed. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("admin");
  const b = await parseJson(req, Body);
  return approveMappingAndReprocess(ctx, {
    batchId: uuid.parse(params.id), sheet: b.sheet, adapter: b.adapter, role: b.role, columnMap: b.column_map, positional: b.positional,
    headerRow: b.header_row, name: b.name, note: b.note,
  });
}, { requireIdempotency: true });
