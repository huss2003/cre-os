import type { NextRequest } from "next/server";
import { requireContext } from "@/lib/auth/context";
import { route, uuid } from "@/lib/util/http";
import { asHttp } from "@/modules/changes/http";
import { recordProvenance } from "@/modules/changes/steward";

export const dynamic = "force-dynamic";

/** GET /api/v1/changes/provenance?type=organisation&id=… — "why do we believe this": per-field evidence, conflicts, freshness. */
export const GET = route(async (req: NextRequest) => {
  const ctx = await requireContext();
  const sp = req.nextUrl.searchParams;
  try { return await recordProvenance(ctx.db, ctx.workspaceId, String(sp.get("type") ?? ""), uuid.parse(sp.get("id"))); } catch (e) { asHttp(e); }
});
