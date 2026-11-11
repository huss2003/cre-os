import { requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { recordTrace } from "@/modules/imports/service";

/** GET /api/v1/imports/trace/[entityId] — spreadsheet rows (file, version, worksheet, cells) behind a record + value history. */
export const GET = route<{ entityId: string }>(async (_req, { params }) => {
  const ctx = await requireContext("viewer");
  return recordTrace(ctx, uuid.parse(params.entityId));
});
