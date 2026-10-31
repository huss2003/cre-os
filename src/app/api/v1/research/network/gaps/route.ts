import type { NextRequest } from "next/server";
import { route } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { threadingGaps, introPathsForOrg } from "@/modules/intelligence/network/service";
import { z } from "zod";

/** GET ?opportunityId= for multi-threading gaps; ?orgId= adds intro paths to that company's current people. */
export const GET = route(async (req: NextRequest) => {
  const ctx = await requireContext();
  const q = req.nextUrl.searchParams;
  const opp = q.get("opportunityId") ? z.string().uuid().parse(q.get("opportunityId")) : undefined;
  const org = q.get("orgId") ? z.string().uuid().parse(q.get("orgId")) : null;
  const [gaps, paths] = await Promise.all([guard(threadingGaps(ctx.db, ctx.workspaceId, opp)), org ? guard(introPathsForOrg(ctx.db, ctx.workspaceId, org, ctx.userId)) : Promise.resolve(null)]);
  return { gaps, introPaths: paths };
});
