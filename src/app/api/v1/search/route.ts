import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { parseSearchQuery, searchEntities } from "@/modules/admin/search";

/**
 * GET /api/v1/search?q=&type=company,person,building,requirement,opportunity&as_of=YYYY-MM-DD&limit=&archived=1
 * Permission-filtered by the database (SECURITY INVOKER RPC under the caller's RLS): tenant, classification,
 * colleague assignment/sharing. Returns { results: [{entity_type, id, title, snippet, fact_status, href, ...}] }.
 */
export const GET = route(async (req) => {
  const ctx = await requireContext("viewer");
  const params = parseSearchQuery(req.nextUrl.searchParams);
  const results = await searchEntities(ctx.db, ctx.workspaceId, params);
  return { query: params, count: results.length, results };
});
