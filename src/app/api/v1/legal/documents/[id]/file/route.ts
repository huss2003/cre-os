import { NextResponse } from "next/server";
import { route, uuid } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { legalOriginal } from "@/modules/intelligence/legal/upload";

/** GET the stored original (PDF/DOCX) through RLS + storage policy; hash-checked. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext();
  const f = await guard(legalOriginal(ctx.db, ctx.workspaceId, uuid.parse(params.id)));
  return new NextResponse(new Uint8Array(f.buffer), { headers: { "content-type": f.mime, "content-disposition": `inline; filename="${f.fileName.replace(/["\\\r\n]/g, "_")}"`, "x-content-type-options": "nosniff" } });
});
