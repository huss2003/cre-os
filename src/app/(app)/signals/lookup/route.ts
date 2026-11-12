import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { lookupOpportunities } from "@/modules/signals/ui-data";

const Q = z.object({ q: z.string().max(100).default(""), id: z.string().uuid().optional() });

/** GET /signals/lookup?q=&id= — opportunity picker for "Link to existing opportunity" (RLS + workspace filter). */
export const GET = route(async (req) => {
  const ctx = await requireContext();
  const sp = req.nextUrl.searchParams;
  const p = Q.parse({ q: sp.get("q") ?? "", id: sp.get("id") || undefined });
  return { items: await lookupOpportunities(ctx.db, ctx.workspaceId, p.q, p.id) };
});
