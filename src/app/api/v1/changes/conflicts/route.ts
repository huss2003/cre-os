import type { NextRequest } from "next/server";
import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { asHttp } from "@/modules/changes/http";
import { listConflicts } from "@/modules/changes/steward";

export const dynamic = "force-dynamic";

/** GET /api/v1/changes/conflicts?status=open|all&type=&id= — source-vs-master field conflicts (both values, source, date). */
export const GET = route(async (req: NextRequest) => {
  const ctx = await requireContext();
  const sp = req.nextUrl.searchParams;
  try {
    return { conflicts: await listConflicts(ctx.db, ctx.workspaceId, { status: sp.get("status") === "all" ? "all" : "open",
      entityType: sp.get("type") ?? undefined, entityId: sp.get("id") ?? undefined }) };
  } catch (e) { asHttp(e); }
});
