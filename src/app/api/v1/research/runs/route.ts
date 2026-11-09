import { route } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";

/** Latest research runs (what was searched, which sites were read). Polled by the Research screen while a run is live. */
export const GET = route(async () => {
  const ctx = await requireContext("viewer");
  const { data, error } = await ctx.db.from("research_run").select("id, kind, label, org_id, status, queries, sources, findings, new_companies, usd, error, created_at, finished_at, assessment")
    .eq("workspace_id", ctx.workspaceId).order("created_at", { ascending: false }).limit(12);
  if (error) throw error;
  return { runs: data ?? [] };
});
