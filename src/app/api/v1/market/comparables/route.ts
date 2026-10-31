import type { NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { marketComparables } from "@/modules/intelligence/market/service";

const Q = z.object({ locality: z.string().max(120).optional(), minSf: z.coerce.number().optional(), maxSf: z.coerce.number().optional(), since: z.string().date().optional(), basis: z.string().max(40).optional() });

export const GET = route(async (req: NextRequest) => {
  const ctx = await requireContext();
  const q = Q.parse(Object.fromEntries(req.nextUrl.searchParams));
  return guard(marketComparables(ctx.db, ctx.workspaceId, { locality: q.locality, minSf: q.minSf, maxSf: q.maxSf, sinceDate: q.since, rentBasis: q.basis }));
});
