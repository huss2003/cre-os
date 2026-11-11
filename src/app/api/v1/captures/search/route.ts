import type { NextRequest } from "next/server";
import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { searchCaptures } from "@/modules/capture/input-engine/service";

export const dynamic = "force-dynamic";

/** GET /api/v1/captures/search?q=&days= — captured notes, files and source-linked observations (Module 12 uses the same service). */
export const GET = route(async (req: NextRequest) => {
  const ctx = await requireContext();
  const u = new URL(req.url);
  const days = Math.min(Math.max(Number(u.searchParams.get("days") ?? 90) || 90, 1), 730);
  return await searchCaptures(ctx.db, ctx.workspaceId, (u.searchParams.get("q") ?? "").slice(0, 200), { days });
});
