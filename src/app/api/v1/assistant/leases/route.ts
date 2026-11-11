import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";

/** GET /api/v1/assistant/leases?q= → up to 10 leases matching tenant or building name (RLS + workspace filter). */
export const GET = route(async (req) => {
  const ctx = await requireContext();
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().replace(/[%_,()\\]/g, " ").slice(0, 60);
  let s = ctx.db.from("lease").select("id, tenant_name_raw, contractual_expiry, asset:asset_id(name)").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("contractual_expiry", { ascending: true, nullsFirst: false }).limit(10);
  if (q) s = s.ilike("tenant_name_raw", `%${q}%`);
  const { data } = await s;
  const items = ((data ?? []) as { id: string; tenant_name_raw: string | null; contractual_expiry: string | null; asset: { name?: string } | { name?: string }[] | null }[]).map((l) => {
    const asset = Array.isArray(l.asset) ? l.asset[0] : l.asset;
    return { id: l.id, label: [l.tenant_name_raw ?? "Lease", asset?.name, l.contractual_expiry ? `expires ${l.contractual_expiry}` : null].filter(Boolean).join(" · ") };
  });
  return { items };
});
