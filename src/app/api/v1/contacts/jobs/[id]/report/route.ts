import { NextResponse, type NextRequest } from "next/server";
import { requireContext } from "@/lib/auth/context";

/** CSV report of one enrichment run: one row per field, with status and source. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext("viewer");
  const { data } = await ctx.db.from("enrichment_item").select("full_name, stage, decision, role_class, cre_relevance, completeness, fields, org:org_id(display_name)").eq("workspace_id", ctx.workspaceId).eq("job_id", id).limit(1000);
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["person", "company", "stage", "decision", "role", "cre_relevance", "completeness", "field", "value", "status", "source", "source_url", "observed_on"].join(",")];
  for (const it of (data ?? []) as Record<string, any>[]) for (const f of it.fields ?? []) lines.push([it.full_name, it.org?.display_name, it.stage, it.decision, it.role_class, it.cre_relevance, it.completeness, f.field, f.value, f.status, f.source_name, f.source_url, f.observed_on].map(q).join(","));
  return new NextResponse(lines.join("\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="enrichment-${id}.csv"` } });
}
