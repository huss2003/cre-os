import { NextResponse } from "next/server";
import { HttpError, requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { ExportError, downloadExport } from "@/modules/assistant/outputs/export";

/** GET /api/v1/assistant/exports/:id — download a stored assistant export (hash-checked). */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext();
  try {
    const f = await downloadExport(ctx, uuid.parse(params.id));
    return new NextResponse(new Uint8Array(f.buffer), { headers: { "content-type": f.mime, "content-disposition": `attachment; filename="${f.fileName.replace(/["\\\r\n]/g, "_")}"`, "x-content-type-options": "nosniff" } });
  } catch (e) { if (e instanceof ExportError) throw new HttpError(e.status, e.message); throw e; }
});
