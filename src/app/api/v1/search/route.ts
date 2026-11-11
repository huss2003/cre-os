import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { parseSearchQuery, searchEntities } from "@/modules/admin/search";
import { parseEverythingQuery, searchEverything } from "@/modules/search/everything";

/**
 * GET /api/v1/search?q=&type=company,person,building,requirement,opportunity&as_of=YYYY-MM-DD&limit=&archived=1
 *   — original 5-type search (unchanged contract).
 * GET /api/v1/search?mode=everything&q=&type=lease,task,signal,…&from=&to=&status=&geo=<uuid>&source=&limit=
 *   — expanded search (leases, floors/units, meetings, tasks, signals, documents, legal documents, quotes, assistant chats).
 * Both run SECURITY INVOKER RPCs under the caller's RLS.
 */
export const GET = route(async (req) => {
  const ctx = await requireContext("viewer");
  if (req.nextUrl.searchParams.get("mode") === "everything") {
    const params = parseEverythingQuery(req.nextUrl.searchParams);
    const results = await searchEverything(ctx.db, ctx.workspaceId, params);
    return { query: params, count: results.length, results };
  }
  const params = parseSearchQuery(req.nextUrl.searchParams);
  const results = await searchEntities(ctx.db, ctx.workspaceId, params);
  return { query: params, count: results.length, results };
});
