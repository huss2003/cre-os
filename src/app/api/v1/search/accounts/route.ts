import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { decodeFilter, isEmptyFilter } from "@/modules/search/filter";
import { findAccounts, nlToFilter } from "@/modules/search/finder";

/**
 * GET /api/v1/search/accounts?nl=<plain text>  or  ?f=<base64url JSON AccountFilter>
 * Structured account finder (spec §2.9). Read-only. Returns { filter, understood, results, coverage }.
 */
export const GET = route(async (req) => {
  const ctx = await requireContext("viewer");
  const sp = req.nextUrl.searchParams;
  let filter = decodeFilter(sp.get("f"));
  let understood: string[] = [];
  if (!filter) {
    const nl = (sp.get("nl") ?? "").slice(0, 500);
    const r = await nlToFilter(ctx.db, ctx.workspaceId, nl, { useModel: sp.get("ai") !== "0" });
    filter = r.filter; understood = r.understood;
  }
  if (isEmptyFilter(filter)) return { filter, understood, results: [], coverage: null, note: "no criteria understood" };
  const res = await findAccounts(ctx.db, ctx.workspaceId, filter, { limit: Math.min(200, Number(sp.get("limit")) || 50) });
  return { ...res, understood };
});
